# TMG Network Monitor

**Real-time VLAN 70 network monitoring dashboard** powered by [ntopng](https://www.ntop.org/). Track every device on your network, see which applications they're using, identify blocked traffic, and keep a full 30-day history — all in a clean Grafana-style dark interface.

![Dashboard Preview](docs/preview.png)

---

## ✨ Features

### 📡 Live Monitoring
- **Real-time device table** — every host on VLAN 70 (192.168.70.0/24) shown with status, last-seen time, and current bandwidth
- **30-second polling** of ntopng REST API, with data stored locally in SQLite
- **Live clock** and "Last Poll" timestamp always visible in the header
- **Network health bar** (top edge) — green = live, amber = stale, red = offline

### 🔴🟡⚫ Device Activity Status
Each device is automatically classified:

| Status | Meaning |
|--------|---------|
| 🟢 **ACTIVE** | Currently sending/receiving data (bps > 1 Kbps) |
| 🟡 **IDLE** | Seen recently, no current traffic |
| ⚫ **OFFLINE** | Not seen in the last 2 poll cycles |

Active devices get a green glow row highlight so you can instantly spot who's online.

### 📊 Application Traffic
- Top 4 apps per device shown as **chip badges** in the main table
- **Engagement indicator** on each chip:
  - `●` green = app is **actively receiving data** (user is genuinely browsing/streaming)
  - `✕` grey = app sent traffic but **received nothing back** — likely **firewall-blocked**
- Per-app **Sent ↑ / Received ↓** byte breakdown in the host detail drawer

### 📈 Bandwidth & Charts
- **Bandwidth % bar** per device — see at a glance who is consuming the most
- **VLAN Throughput Timeline** chart (download + upload over time)
- **Top Apps Breakdown** bar chart (aggregated across entire VLAN)
- **Per-host bandwidth timeline** with download/upload split in the host drawer

### 🗂️ 6 KPI Cards
| Card | Shows |
|------|-------|
| Download | Current VLAN download speed + peak |
| Upload | Current VLAN upload speed + peak |
| Total VLAN Bandwidth | Sum of all host bps |
| Active / Total Devices | How many devices are actively sending data |
| Top Dominant App | Highest-traffic application across all hosts |
| App Engagement | Count of actively-receiving apps + count of possibly-blocked apps |

### 🔍 Host Deep-Dive Drawer
Click any device row to open the inspection drawer:
- **Duration, Total Traffic, Sent ↑, Received ↓, Bandwidth, App count** — 6 stat boxes
- **Donut chart** of app breakdown
- **App table** with columns: Application | Duration | Sent ↑ | Received ↓ | Total | % Host | Flows
- **Engagement remark** per app: `● Active` or `✕ Blocked?`
- **Bandwidth timeline** chart (download + upload split)
- **Time window selector**: Last 24h / 7 Days / 30 Days

### 🏷️ Custom Device Names
Click the ✏️ pencil icon next to any device name to give it a friendly alias (e.g. "Jason's Phone"). Names are stored persistently in SQLite.

### 🔒 Security & Privacy
- All data stays **on your own machine** — no cloud, no external analytics
- SQLite database persisted via Docker volume — survives container rebuilds
- `.env` credentials never committed to git

---

## 🚀 Quick Start

### Prerequisites
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- An [ntopng](https://www.ntop.org/products/traffic-analysis/ntop/) instance accessible on your network
- ntopng REST API v2 enabled (Community edition works)

### 1. Clone the repo
```bash
git clone https://github.com/Nenosaj/TMG-monitoring.git
cd TMG-monitoring
```

### 2. Configure credentials
```bash
cp server/.env.example server/.env
```

Edit `server/.env`:
```env
NTOPNG_URL=http://192.168.100.2:3000   # Your ntopng URL
NTOPNG_USER=admin                       # ntopng username
NTOPNG_PASS=yourpassword                # ntopng password
NTOPNG_IFID=0                           # Interface ID (usually 0)

VLAN_ID=70                              # VLAN to monitor
POLL_INTERVAL_SECONDS=30               # How often to poll ntopng
RETENTION_DAYS=30                       # Days of history to keep
PORT=4070                               # Dashboard port
```

### 3. Start
```bash
docker compose up -d --build
```

Open **http://localhost:4070** in your browser.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────┐
│  Docker Container                                │
│                                                  │
│  ┌──────────────┐    ┌────────────────────────┐  │
│  │  Express.js  │    │  Background Poller     │  │
│  │  REST API    │    │  (every 30s)           │  │
│  │  :4070       │    │  → ntopng REST API v2  │  │
│  └──────┬───────┘    └──────────┬─────────────┘  │
│         │                       │                │
│         └──────────┬────────────┘                │
│                    ↓                             │
│           ┌─────────────────┐                    │
│           │  SQLite DB      │  ← Docker Volume   │
│           │  (persistent)   │                    │
│           └─────────────────┘                    │
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │  Static Frontend (vanilla JS/HTML/CSS)   │    │
│  │  Chart.js · Plus Jakarta Sans · JB Mono  │    │
│  └──────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
          ↕ HTTP polls every 15s
     Browser (http://localhost:4070)
```

### Key files
```
TMG-monitoring/
├── server/
│   ├── server.js          # Express app + REST routes
│   ├── db.js              # SQLite schema, queries, migrations
│   ├── poller.js          # Background ntopng polling loop
│   ├── ntopngClient.js    # ntopng REST API v2 client
│   ├── .env               # 🔒 Your credentials (not committed)
│   └── .env.example       # Template
├── public/
│   ├── index.html         # Dashboard HTML
│   ├── app.js             # Dashboard logic (vanilla JS)
│   ├── styles.css         # Dark analytics theme
│   └── vendor/
│       └── chart.umd.js   # Chart.js (bundled, no CDN dependency)
├── docker-compose.yml
└── Dockerfile
```

---

## 🔌 API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/status` | Poll status, DB stats, config |
| `GET /api/hosts/summary?hours=24` | All VLAN 70 hosts with top apps |
| `GET /api/hosts/:ip/details?hours=24` | Full app history for one host |
| `GET /api/history/traffic?hours=24` | Interface bandwidth timeline |
| `GET /api/apps/top?hours=24&limit=10` | Top applications across VLAN |
| `GET /api/alerts?hours=168` | Alert log |
| `GET /api/aliases` | Custom device name aliases |
| `POST /api/aliases` | Set/update alias `{ ip, name }` |

---

## 🗄️ Database Schema

SQLite database stored at `/app/server/data/vlan70_history.sqlite3` (Docker volume).

| Table | Description |
|-------|-------------|
| `interface_snapshots` | Per-poll VLAN bandwidth metrics |
| `host_snapshots` | Per-host traffic snapshot per poll |
| `host_app_snapshots` | Per-host per-application bytes/flows |
| `app_snapshots` | Interface-wide L7 app breakdown |
| `alerts_log` | ntopng alerts |
| `aliases` | Custom device friendly names |

---

## 🛠️ Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `NTOPNG_URL` | — | ntopng base URL (required) |
| `NTOPNG_USER` | — | ntopng username (required) |
| `NTOPNG_PASS` | — | ntopng password (required) |
| `NTOPNG_IFID` | `0` | Interface ID to monitor |
| `VLAN_ID` | `70` | VLAN number to filter hosts |
| `POLL_INTERVAL_SECONDS` | `30` | How often to poll ntopng |
| `RETENTION_DAYS` | `30` | Days of history to retain |
| `PORT` | `4070` | Dashboard HTTP port |

---

## 🔄 Update / Rebuild

After pulling new code:
```bash
git pull
docker compose up -d --build
```

Your history database is preserved in a Docker volume and survives rebuilds.

---

## 📝 Notes on Sent / Received Data

- **Host-level** Sent ↑ / Received ↓ comes directly from ntopng's host stats and is accurate
- **Per-app** Sent ↑ / Received ↓ is **estimated** by proportionally applying the host's directional ratio to each app's total bytes. ntopng's L7 protocol stats endpoint does not expose per-application directional breakdowns, so this is a best approximation
- The **engagement indicator** (● Active / ✕ Blocked?) uses the estimated values, so treat `✕ Blocked?` as a signal to investigate, not a guaranteed determination

---

## 🤝 Contributing

Pull requests welcome. Please keep commits focused and descriptive.

---

## 📄 License

MIT
