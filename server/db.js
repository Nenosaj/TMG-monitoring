"use strict";
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "vlan70_history.sqlite3");
const db = new DatabaseSync(DB_PATH);

db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA synchronous = NORMAL;");

// ── Schema ────────────────────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS interface_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  bps_down REAL, bps_up REAL, pps_down REAL, pps_up REAL,
  bytes_total INTEGER, num_hosts INTEGER, num_flows INTEGER
);
CREATE INDEX IF NOT EXISTS idx_iface_ts ON interface_snapshots(ts);

CREATE TABLE IF NOT EXISTS host_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, ip TEXT NOT NULL, name TEXT, mac TEXT,
  vlan INTEGER, bytes_sent INTEGER, bytes_rcvd INTEGER, bytes_total INTEGER,
  bps REAL, pps REAL, num_flows INTEGER, top_app TEXT,
  duration_sec INTEGER, first_seen INTEGER, last_seen INTEGER
);
CREATE INDEX IF NOT EXISTS idx_host_ts ON host_snapshots(ts);
CREATE INDEX IF NOT EXISTS idx_host_ip ON host_snapshots(ip);
CREATE INDEX IF NOT EXISTS idx_host_ip_ts ON host_snapshots(ip, ts);

CREATE TABLE IF NOT EXISTS host_app_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, ip TEXT NOT NULL, vlan INTEGER,
  app_name TEXT NOT NULL,
  bytes INTEGER, bytes_sent INTEGER, bytes_rcvd INTEGER,
  flows INTEGER, duration_sec INTEGER
);
CREATE INDEX IF NOT EXISTS idx_host_app_ts ON host_app_snapshots(ts);
CREATE INDEX IF NOT EXISTS idx_host_app_ip_ts ON host_app_snapshots(ip, ts);
CREATE INDEX IF NOT EXISTS idx_host_app_name ON host_app_snapshots(app_name);

CREATE TABLE IF NOT EXISTS app_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, vlan INTEGER, app_name TEXT, bytes INTEGER, flows INTEGER
);
CREATE INDEX IF NOT EXISTS idx_app_ts ON app_snapshots(ts);

CREATE TABLE IF NOT EXISTS alerts_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, ntopng_row_id TEXT, severity TEXT,
  alert_name TEXT, description TEXT,
  UNIQUE(ntopng_row_id, ts)
);
CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts_log(ts);

CREATE TABLE IF NOT EXISTS aliases (
  ip TEXT PRIMARY KEY,
  name TEXT
);
`);

// ── Schema migrations for older DB files ──────────────────────────────────
try {
  const hostCols = new Set(db.prepare("PRAGMA table_info(host_snapshots)").all().map((r) => r.name));
  for (const { name, type } of [
    { name: "mac",          type: "TEXT" },
    { name: "bytes_total",  type: "INTEGER" },
    { name: "pps",          type: "REAL" },
    { name: "duration_sec", type: "INTEGER" },
    { name: "first_seen",   type: "INTEGER" },
    { name: "last_seen",    type: "INTEGER" },
  ]) {
    if (!hostCols.has(name)) db.exec(`ALTER TABLE host_snapshots ADD COLUMN ${name} ${type};`);
  }

  const appCols = new Set(db.prepare("PRAGMA table_info(host_app_snapshots)").all().map((r) => r.name));
  for (const { name, type } of [
    { name: "duration_sec", type: "INTEGER" },
    { name: "bytes_sent",   type: "INTEGER DEFAULT 0" },
    { name: "bytes_rcvd",   type: "INTEGER DEFAULT 0" },
  ]) {
    if (!appCols.has(name)) db.exec(`ALTER TABLE host_app_snapshots ADD COLUMN ${name} ${type};`);
  }
} catch (_) {
  // Already up-to-date
}

// ── Prepared statements ───────────────────────────────────────────────────
const stmts = {
  insertInterface: db.prepare(
    "INSERT INTO interface_snapshots (ts, bps_down, bps_up, pps_down, pps_up, bytes_total, num_hosts, num_flows) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ),
  insertHost: db.prepare(
    "INSERT INTO host_snapshots (ts, ip, name, mac, vlan, bytes_sent, bytes_rcvd, bytes_total, bps, pps, num_flows, top_app, duration_sec, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ),
  insertHostApp: db.prepare(
    "INSERT INTO host_app_snapshots (ts, ip, vlan, app_name, bytes, bytes_sent, bytes_rcvd, flows, duration_sec) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ),
  insertApp: db.prepare(
    "INSERT INTO app_snapshots (ts, vlan, app_name, bytes, flows) VALUES (?, ?, ?, ?, ?)"
  ),
  insertAlert: db.prepare(
    "INSERT OR IGNORE INTO alerts_log (ts, ntopng_row_id, severity, alert_name, description) VALUES (?, ?, ?, ?, ?)"
  ),
  pruneInterface: db.prepare("DELETE FROM interface_snapshots WHERE ts < ?"),
  pruneHost:      db.prepare("DELETE FROM host_snapshots WHERE ts < ?"),
  pruneHostApp:   db.prepare("DELETE FROM host_app_snapshots WHERE ts < ?"),
  pruneApp:       db.prepare("DELETE FROM app_snapshots WHERE ts < ?"),
  pruneAlerts:    db.prepare("DELETE FROM alerts_log WHERE ts < ?"),
};

// ── Insert helpers ────────────────────────────────────────────────────────
function insertInterfaceSnapshot(row) {
  stmts.insertInterface.run(
    row.ts, row.bps_down ?? 0, row.bps_up ?? 0,
    row.pps_down ?? 0, row.pps_up ?? 0,
    row.bytes_total ?? 0, row.num_hosts ?? 0, row.num_flows ?? 0
  );
}

function withTransaction(fn) {
  db.exec("BEGIN TRANSACTION;");
  try { fn(); db.exec("COMMIT;"); }
  catch (err) { db.exec("ROLLBACK;"); throw err; }
}

function insertHostSnapshots(rows) {
  withTransaction(() => {
    for (const r of rows) {
      stmts.insertHost.run(
        r.ts, r.ip, r.name || r.ip, r.mac || "",
        r.vlan ?? 70, r.bytes_sent ?? 0, r.bytes_rcvd ?? 0,
        r.bytes_total ?? ((r.bytes_sent || 0) + (r.bytes_rcvd || 0)),
        r.bps ?? 0, r.pps ?? 0, r.num_flows ?? 0,
        r.top_app || null, r.duration_sec ?? 0,
        r.first_seen ?? null, r.last_seen ?? null
      );
    }
  });
}

function insertHostAppSnapshots(rows) {
  withTransaction(() => {
    for (const r of rows) {
      stmts.insertHostApp.run(
        r.ts, r.ip, r.vlan ?? 70, r.app_name,
        r.bytes ?? 0, r.bytes_sent ?? 0, r.bytes_rcvd ?? 0,
        r.flows ?? 0, r.duration_sec ?? 0
      );
    }
  });
}

function insertAppSnapshots(rows) {
  withTransaction(() => {
    for (const r of rows) {
      stmts.insertApp.run(r.ts, r.vlan ?? 70, r.app_name, r.bytes ?? 0, r.flows ?? 0);
    }
  });
}

function insertAlerts(rows) {
  withTransaction(() => {
    for (const r of rows) {
      stmts.insertAlert.run(
        r.ts,
        r.ntopng_row_id || `${r.ts}-${r.alert_name}`,
        r.severity || "info",
        r.alert_name || "Alert",
        r.description || ""
      );
    }
  });
}

function prune(retentionDays = 30) {
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400;
  stmts.pruneInterface.run(cutoff);
  stmts.pruneHost.run(cutoff);
  stmts.pruneHostApp.run(cutoff);
  stmts.pruneApp.run(cutoff);
  stmts.pruneAlerts.run(cutoff);
}

// ── Query helpers ─────────────────────────────────────────────────────────
function getInterfaceHistory(sinceTs) {
  return db.prepare("SELECT * FROM interface_snapshots WHERE ts >= ? ORDER BY ts ASC").all(sinceTs);
}

function getLatestHostsList(sinceTs = 0) {
  const hosts = db.prepare(`
    WITH LatestPerHost AS (
      SELECT ip, MAX(ts) AS max_ts
      FROM host_snapshots
      WHERE ts >= ? AND vlan = ?
      GROUP BY ip
    ),
    LatestData AS (
      SELECT h.* FROM host_snapshots h
      JOIN LatestPerHost l ON h.ip = l.ip AND h.ts = l.max_ts
    ),
    HistorySummary AS (
      SELECT ip,
        MIN(ts) AS history_first_seen, MAX(ts) AS history_last_seen,
        COUNT(DISTINCT ts) AS active_snapshots
      FROM host_snapshots WHERE ts >= ?
      GROUP BY ip
    )
    SELECT
      l.ip, l.name, l.mac, l.vlan,
      l.bytes_sent, l.bytes_rcvd, l.bytes_total,
      l.bps, l.pps, l.num_flows, l.top_app,
      l.duration_sec, l.first_seen, l.last_seen,
      l.ts AS latest_poll_ts,
      COALESCE(s.history_first_seen, l.first_seen) AS min_ts,
      COALESCE(s.history_last_seen,  l.last_seen)  AS max_ts,
      COALESCE(s.active_snapshots, 1)               AS active_polls
    FROM LatestData l
    LEFT JOIN HistorySummary s ON l.ip = s.ip
    ORDER BY l.bps DESC, l.bytes_total DESC
  `).all(sinceTs, 70, sinceTs);

  const appStmt = db.prepare(`
    SELECT
      app_name,
      MAX(bytes)       AS max_bytes,
      MAX(bytes_sent)  AS max_bytes_sent,
      MAX(bytes_rcvd)  AS max_bytes_rcvd,
      MAX(duration_sec) AS duration_sec
    FROM host_app_snapshots
    WHERE ip = ? AND ts >= ?
    GROUP BY app_name
    ORDER BY max_bytes DESC
    LIMIT 4
  `);

  for (const h of hosts) {
    const apps = appStmt.all(h.ip, sinceTs);
    h.top_apps = apps.map((a) => ({
      name:     a.app_name,
      bytes:    a.max_bytes,
      sent:     a.max_bytes_sent,
      rcvd:     a.max_bytes_rcvd,
      duration: a.duration_sec,
    }));
  }

  return hosts;
}

function getHostDetails(ip, sinceTs) {
  const host = db.prepare("SELECT * FROM host_snapshots WHERE ip = ? ORDER BY ts DESC LIMIT 1").all(ip)[0] || null;

  const apps = db.prepare(`
    SELECT
      app_name,
      MAX(bytes)        AS total_bytes,
      MAX(bytes_sent)   AS total_bytes_sent,
      MAX(bytes_rcvd)   AS total_bytes_rcvd,
      MAX(flows)        AS total_flows,
      MAX(duration_sec) AS duration_sec,
      MIN(ts)           AS first_seen_ts,
      MAX(ts)           AS last_seen_ts,
      COUNT(DISTINCT ts) AS active_polls
    FROM host_app_snapshots
    WHERE ip = ? AND ts >= ?
    GROUP BY app_name
    ORDER BY total_bytes DESC
  `).all(ip, sinceTs);

  const timeline = db.prepare(`
    SELECT ts, bps, pps, num_flows, bytes_sent, bytes_rcvd, bytes_total, top_app
    FROM host_snapshots
    WHERE ip = ? AND ts >= ?
    ORDER BY ts ASC
  `).all(ip, sinceTs);

  return { ip, host, sinceTs, apps, timeline };
}

function getTopAppsSince(sinceTs, vlan, limit = 10) {
  return db.prepare(`
    SELECT app_name, SUM(bytes) AS total_bytes, SUM(flows) AS total_flows
    FROM app_snapshots
    WHERE ts >= ? AND vlan = ?
    GROUP BY app_name
    ORDER BY total_bytes DESC
    LIMIT ?
  `).all(sinceTs, vlan, limit);
}

function getAlerts(sinceTs, limit = 200) {
  return db.prepare("SELECT * FROM alerts_log WHERE ts >= ? ORDER BY ts DESC LIMIT ?").all(sinceTs, limit);
}

function getLastPollTs() {
  return db.prepare("SELECT MAX(ts) AS ts FROM interface_snapshots").all()[0]?.ts ?? null;
}

function getDbStats() {
  return {
    ifaceCount:   db.prepare("SELECT COUNT(*) AS c FROM interface_snapshots").all()[0]?.c ?? 0,
    hostCount:    db.prepare("SELECT COUNT(*) AS c FROM host_snapshots").all()[0]?.c ?? 0,
    hostAppCount: db.prepare("SELECT COUNT(*) AS c FROM host_app_snapshots").all()[0]?.c ?? 0,
    alertCount:   db.prepare("SELECT COUNT(*) AS c FROM alerts_log").all()[0]?.c ?? 0,
  };
}

function getAliases() {
  return db.prepare("SELECT ip, name FROM aliases").all()
    .reduce((acc, row) => { acc[row.ip] = row.name; return acc; }, {});
}

function setAlias(ip, name) {
  if (!name || name.trim() === "") {
    db.prepare("DELETE FROM aliases WHERE ip = ?").run(ip);
  } else {
    db.prepare("INSERT INTO aliases (ip, name) VALUES (?, ?) ON CONFLICT(ip) DO UPDATE SET name = excluded.name").run(ip, name.trim());
  }
}

function close() {
  db.close();
}

module.exports = {
  insertInterfaceSnapshot,
  insertHostSnapshots,
  insertHostAppSnapshots,
  insertAppSnapshots,
  insertAlerts,
  prune,
  getInterfaceHistory,
  getLatestHostsList,
  getHostDetails,
  getTopAppsSince,
  getAlerts,
  getLastPollTs,
  getDbStats,
  getAliases,
  setAlias,
  close,
};
