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

const PORT                  = positiveNumber(process.env.PORT, 4070, "PORT");
const VLAN_ID               = positiveNumber(process.env.VLAN_ID, 70, "VLAN_ID");
const IFID                  = process.env.NTOPNG_IFID || "0";
const POLL_INTERVAL_SECONDS = positiveNumber(process.env.POLL_INTERVAL_SECONDS, 30, "POLL_INTERVAL_SECONDS");
const RETENTION_DAYS        = positiveNumber(process.env.RETENTION_DAYS, 30, "RETENTION_DAYS");
const pollingConfigured     = Boolean(process.env.NTOPNG_URL && process.env.NTOPNG_USER && process.env.NTOPNG_PASS);

if (!pollingConfigured) {
  console.warn("[startup] ntopng credentials are incomplete; the dashboard will run, but polling is disabled.");
}

const client = makeClient({
  baseUrl: process.env.NTOPNG_URL,
  user:    process.env.NTOPNG_USER,
  pass:    process.env.NTOPNG_PASS,
  ifid:    IFID,
});

const stopPoller = pollingConfigured
  ? startPoller({
      client,
      vlan:            VLAN_ID,
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

// ── Health ────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ ok: true }));

// ── Status ────────────────────────────────────────────────────────────────
app.get("/api/status", (_req, res) => {
  res.json({
    vlan: VLAN_ID, ifid: IFID,
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
app.get("/api/hosts/summary", (req, res) => {
  res.json(db.getLatestHostsList(since(req.query.hours || 24)));
});

// Legacy alias
app.get("/api/live/hosts", (req, res) => {
  res.json(db.getLatestHostsList(since(req.query.hours || 24)));
});

app.get("/api/hosts/:ip/details", (req, res) => {
  res.json(db.getHostDetails(req.params.ip, since(req.query.hours || 24)));
});

// ── Interface / App history ───────────────────────────────────────────────
app.get("/api/history/traffic", (req, res) => {
  res.json(db.getInterfaceHistory(since(req.query.hours || 24)));
});

app.get("/api/apps/top", (req, res) => {
  res.json(db.getTopAppsSince(since(req.query.hours || 24), VLAN_ID, boundedLimit(req.query.limit, 12, 100)));
});

app.get("/api/alerts", (req, res) => {
  res.json(db.getAlerts(since(req.query.hours || 168), boundedLimit(req.query.limit, 200, 1000)));
});

// ── Start server ──────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`  VLAN ${VLAN_ID} Monitor Dashboard running at:`);
  console.log(`  http://localhost:${PORT}`);
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
