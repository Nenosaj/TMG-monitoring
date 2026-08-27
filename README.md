# VLAN 70 Signal Log
A modern web dashboard that continuously watches ntopng's REST API v2 for VLAN 70 (and the `192.168.70.0/24` subnet) and keeps its own persistent SQLite history log — tracking bandwidth over time, per-device active durations, and the full history of applications accessed by each host over the day or week.

## Architecture

```
┌─────────────┐   polls every 30s    ┌─────────────┐        ┌────────────────────────┐
│   ntopng     │ ───────────────────▶ │  poller.js   │ ─────▶ │ SQLite history store   │
│ REST API v2  │                      │ (Node.js)    │        │ (vlan70_history.sqlite3) │
└─────────────┘                      └─────────────┘        └───────────┬────────────┘
                                                                        │
                                                                 ┌──────▼───────┐
                                                                 │ server.js     │
                                                                 │ Express API   │
                                                                 └──────┬───────┘
                                                                        │
                                                                 ┌──────▼───────┐
                                                                 │ dashboard UI │
                                                                 │ (public/)     │
                                                                 └──────────────┘
```

## Features

- **Direct Live Integration**: Connects directly to ntopng REST API v2 using native fetch with zero demo dependencies.
- **Zero-Build Native SQLite**: Powered by Node's built-in `node:sqlite` (`DatabaseSync`), requiring zero C++ build tools or external compilation dependencies on Windows.
- **Host & App History**: Captures active durations and per-host application breakdowns (`YouTube`, `WhatsApp`, `TLS`, `HTTP`, `Google`, etc.) into `host_app_snapshots`.
- **Modern Dark UI**:
  - Global timeframe selector: **1h**, **6h**, **24h (Today)**, **7d (Week)**, **30d**.
  - Formatted Device Table: `IP & Device Name ──▶ Active Duration ──▶ Apps Accessed ──▶ Total Traffic ──▶ Throughput`.
  - **Interactive Host Deep-Dive Drawer**: Click any host IP to see all applications accessed by that device over the course of the day or week, with duration, byte breakdown, and bandwidth timeline.
  - Live VLAN throughput chart and aggregate application distribution.

## Running the Server

```bash
cd server
npm start
```

Open `http://localhost:4070` in your web browser.

## Running with Docker

1. Copy `server/.env.example` to `server/.env` and fill in the ntopng credentials.
2. Run `docker compose up -d --build` from the repository root.
3. Open `http://localhost:4070`. The SQLite history is retained in the named `vlan70-data` volume.

Use `docker compose logs -f vlan70-monitor` to inspect polling, and `docker compose down` to stop it without deleting history. Use `docker compose down -v` only when you intentionally want to remove the stored history.

### ntopng connectivity

`NTOPNG_URL` must point to an ntopng HTTP or HTTPS listener that is reachable from the machine running Docker. Before starting the monitor, verify the configured port is open from that machine (for example, `Test-NetConnection <ntopng-ip> -Port <port>` in PowerShell). A ping reply alone does not confirm that the ntopng web/API port is available; allow the port through the ntopng host firewall and use the actual listener port/protocol.

## Configuration (`server/.env`)

```env
NTOPNG_URL=http://192.168.100.2:3000
NTOPNG_USER=admin
NTOPNG_PASS=replace-with-your-password
NTOPNG_IFID=0
VLAN_ID=70
POLL_INTERVAL_SECONDS=30
RETENTION_DAYS=30
PORT=4070
```
