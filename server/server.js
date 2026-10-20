"use strict";
require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const path    = require("path");

const db               = require("./db");
const { makeClient }   = require("./ntopngClient");
const { startPoller }  = require("./poller");

function positiveNumber(value, fallback, name) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  if (value !== undefined && value !== "") {
    console.warn(`[startup] Invalid ${name}=${JSON.stringify(value)}; using ${fallback}.`);
  }
  return fallback;
}

// ── VLAN configuration ────────────────────────────────────────────────────────
// VLAN_IDS: comma-separated list of VLAN IDs to monitor (e.g. "5,10,30,50,60,70,80,100")
// VLAN_NAMES: comma-separated "id:name" pairs (e.g. "5:MESH,10:OPERATIONS,70:NETIS")
// Falls back to legacy VLAN_ID if VLAN_IDS is not set.
function parseVlanIds(raw) {
  if (!raw || !raw.trim()) return null;
  return raw.split(",").map((s) => s.trim()).filter(Boolean).map(Number).filter(Number.isFinite);
}

function parseVlanNames(raw) {
  const map = {};
  if (!raw || !raw.trim()) return map;
  raw.split(",").forEach((part) => {
    const [id, ...nameParts] = part.trim().split(":");
    const name = nameParts.join(":").trim();
    if (id && name) map[Number(id)] = name;
  });
  return map;
}

const PORT                  = positiveNumber(process.env.PORT, 4070, "PORT");
const POLL_INTERVAL_SECONDS = positiveNumber(process.env.POLL_INTERVAL_SECONDS, 30, "POLL_INTERVAL_SECONDS");
const RETENTION_DAYS        = positiveNumber(process.env.RETENTION_DAYS, 30, "RETENTION_DAYS");
const IFID                  = process.env.NTOPNG_IFID || "0";

// Multi-VLAN support: VLAN_IDS overrides legacy VLAN_ID
const rawVlanIds = process.env.VLAN_IDS || process.env.VLAN_ID || "70";
const VLAN_IDS   = parseVlanIds(rawVlanIds) || [70];

// VLAN name map — applied over defaults or any not listed
const DEFAULT_NAMES = {
  5: "MESH", 10: "OPERATIONS", 30: "SALES",
  50: "WEB", 60: "DMT", 70: "NETIS", 80: "CEO", 100: "DEFAULT",
};
const envVlanNames = parseVlanNames(process.env.VLAN_NAMES || "");
const VLAN_NAMES   = { ...DEFAULT_NAMES, ...envVlanNames };

// Build the config object sent to the frontend
const VLANS_CONFIG = VLAN_IDS.map((id) => ({
  id,
  name:   VLAN_NAMES[id] || `VLAN ${id}`,
  subnet: `192.168.${id}.0/24`,
}));

const pollingConfigured = Boolean(process.env.NTOPNG_URL && process.env.NTOPNG_USER && process.env.NTOPNG_PASS);

if (!pollingConfigured) {
  console.warn("[startup] ntopng credentials are incomplete; the dashboard will run, but polling is disabled.");
}

console.log(`[startup] Monitoring VLANs: ${VLAN_IDS.map((id) => `${id} (${VLAN_NAMES[id] || id})`).join(", ")}`);

const client = makeClient({
  baseUrl: process.env.NTOPNG_URL,
  user:    process.env.NTOPNG_USER,
  pass:    process.env.NTOPNG_PASS,
  ifid:    IFID,
});

const stopPoller = pollingConfigured
  ? startPoller({
      client,
      vlans:           VLAN_IDS,
      intervalSeconds: POLL_INTERVAL_SECONDS,
      retentionDays:   RETENTION_DAYS,
      log: (msg) => console.log(msg),
    })
  : () => {};

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

function since(hours) {
  const h = Math.min(Math.max(positiveNumber(hours, 24, "hours"), 1), 24 * 365);
  return Math.floor(Date.now() / 1000) - h * 3600;
}

function boundedLimit(value, fallback, maximum) {
  return Math.min(Math.floor(positiveNumber(value, fallback, "limit")), maximum);
}

// Parse optional ?vlan= query param; null = all monitored vlans
function parseVlanParam(query) {
  if (!query.vlan) return null;
  const v = Number(query.vlan);
  return Number.isFinite(v) && v > 0 ? v : null;
}

// ── Health ────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ ok: true }));

// ── Status ────────────────────────────────────────────────────────────────
app.get("/api/status", (_req, res) => {
  res.json({
    // Legacy compat: vlan = first monitored VLAN
    vlan: VLAN_IDS[0],
    vlans: VLANS_CONFIG,
    ifid: IFID,
    pollIntervalSeconds: POLL_INTERVAL_SECONDS,
    retentionDays: RETENTION_DAYS,
    pollingConfigured,
    lastPollTs: db.getLastPollTs(),
    dbStats: db.getDbStats(),
  });
});

// ── Aliases ───────────────────────────────────────────────────────────────
app.get("/api/aliases", (_req, res) => {
  res.json(db.getAliases());
});

app.post("/api/aliases", (req, res) => {
  const { ip, name } = req.body || {};
  if (!ip) return res.status(400).json({ error: "ip required" });
  db.setAlias(ip, name);
  res.json({ success: true });
});

// ── Hosts ─────────────────────────────────────────────────────────────────
// ?vlan=70 filters to specific VLAN; omit for all monitored VLANs
app.get("/api/hosts/summary", (req, res) => {
  const vlan = parseVlanParam(req.query);
  res.json(db.getLatestHostsList(since(req.query.hours || 24), vlan ? [vlan] : VLAN_IDS));
});

// Legacy alias
app.get("/api/live/hosts", (req, res) => {
  const vlan = parseVlanParam(req.query);
  res.json(db.getLatestHostsList(since(req.query.hours || 24), vlan ? [vlan] : VLAN_IDS));
});

app.get("/api/hosts/:ip/details", (req, res) => {
  res.json(db.getHostDetails(req.params.ip, since(req.query.hours || 24)));
});

// ── Interface / App history ───────────────────────────────────────────────
app.get("/api/history/traffic", (req, res) => {
  res.json(db.getInterfaceHistory(since(req.query.hours || 24)));
});

app.get("/api/apps/top", (req, res) => {
  const vlan = parseVlanParam(req.query);
  res.json(db.getTopAppsSince(since(req.query.hours || 24), vlan ? [vlan] : VLAN_IDS, boundedLimit(req.query.limit, 12, 100)));
});

app.get("/api/alerts", (req, res) => {
  res.json(db.getAlerts(since(req.query.hours || 168), boundedLimit(req.query.limit, 200, 1000)));
});

// ── VLAN list ─────────────────────────────────────────────────────────────
app.get("/api/vlans", (_req, res) => {
  res.json(VLANS_CONFIG);
});

// ── Start server ──────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`  TMG Network Monitor Dashboard running at:`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  VLANs: ${VLAN_IDS.join(", ")}`);
  console.log(`  Polling ntopng at: ${process.env.NTOPNG_URL} (ifid: ${IFID})`);
  console.log(`=======================================================`);
});

let isShuttingDown = false;
function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[shutdown] Received ${signal}; stopping poller and HTTP server.`);
  stopPoller();
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
