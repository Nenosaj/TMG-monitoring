/**
 * TMG Network Monitor Dashboard — Multi-VLAN Edition
 * Dual View Architecture:
 *   1. 📡 Live Monitor (Real-time snapshot, instant bandwidth, zero stale apps)
 *   2. 📊 Historical Analytics (Time-window trends, top talkers, apps breakdown, CSV export)
 */

const API_BASE = "";

// ── State ────────────────────────────────────────────────────────────────────
let currentView     = "live"; // "live" | "history"
let currentHours    = 24;
let hostDrawerHours = 24;
let activeHostIp    = null;

let liveHosts       = [];
let historyHosts    = [];
let aliases         = {};
let availableHistApps = new Set();
let isRefreshing    = false;

// VLAN state
let vlansConfig     = [];   // [{id, name, subnet}, …] from /api/vlans
let activeVlanId    = null; // null = ALL

// ── Chart instances ───────────────────────────────────────────────────────────
let throughputChart   = null;
let appsChart         = null;
let hostAppsChart     = null;
let hostTimelineChart = null;

// ── Colour palette ────────────────────────────────────────────────────────────
const PALETTE = {
  accent:      "#10b981",
  accentLight: "#34d399",
  cyan:        "#06b6d4",
  blue:        "#3b82f6",
  amber:       "#f59e0b",
  rose:        "#f43f5e",
  purple:      "#8b5cf6",
  grid:        "rgba(30, 48, 61, 0.6)",
  text:        "#94a3b8",
  textBright:  "#f0f6fc",
};

const APP_COLORS = [
  "#10b981","#06b6d4","#3b82f6","#f59e0b","#8b5cf6",
  "#ec4899","#14b8a6","#f97316","#a855f7","#6366f1",
];

// ── Formatting helpers ────────────────────────────────────────────────────────
function fmtBytes(n) {
  if (n == null || isNaN(n)) return "0 B";
  const num = Number(n);
  if (num === 0) return "0 B";
  const units = ["B","KB","MB","GB","TB"];
  let i = 0, v = num;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function fmtBps(n) {
  if (n == null || isNaN(n) || Number(n) === 0) return "0 B/s";
  return `${fmtBytes(n)}/s`;
}

function fmtDuration(sec) {
  if (sec == null || isNaN(sec) || sec <= 0) return "< 1m";
  const s    = Math.floor(sec);
  const days = Math.floor(s / 86400);
  const hrs  = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600)  / 60);
  if (days > 0) return `${days}d ${hrs}h`;
  if (hrs  > 0) return `${hrs}h ${mins}m`;
  if (mins > 0) return `${mins}m`;
  return `${s}s`;
}

function fmtTime(ts) {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });
}

function fmtDateTime(ts) {
  if (!ts) return "—";
  const d   = new Date(ts * 1000);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday)
    return d.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit", second:"2-digit" });
  return d.toLocaleDateString([], { month:"short", day:"numeric" }) + " " +
         d.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });
}

async function apiGet(url) {
  const res = await fetch(API_BASE + url);
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  return res.json();
}

// ── Device status classifier ──────────────────────────────────────────────────
function deviceStatus(h) {
  const bps  = Number(h.bps) || 0;
  const ageS = h.latest_poll_ts
    ? Math.floor(Date.now() / 1000) - h.latest_poll_ts
    : 9999;
  if (bps > 1000) return "active";
  if (ageS < 300) return "idle";
  return "offline";
}

// ── Live clock ────────────────────────────────────────────────────────────────
function updateClock() {
  const now     = new Date();
  const dateStr = now.toLocaleDateString("en-US", { weekday:"short", month:"short", day:"numeric" });
  const timeStr = now.toLocaleTimeString("en-US", { hour:"2-digit", minute:"2-digit", second:"2-digit" });
  const el = document.getElementById("liveClock");
  if (el) el.textContent = `${dateStr} · ${timeStr}`;
}

// ── VLAN helpers ──────────────────────────────────────────────────────────────
function getActiveVlan() {
  return vlansConfig.find((v) => v.id === activeVlanId) || null;
}

function vlanLabel() {
  if (activeVlanId === null) return "All VLANs";
  const v = getActiveVlan();
  return v ? `VLAN ${v.id} · ${v.name}` : `VLAN ${activeVlanId}`;
}

function vlanSubnet() {
  if (activeVlanId === null) return null;
  const v = getActiveVlan();
  return v ? v.subnet : `192.168.${activeVlanId}.0/24`;
}

function vlanQS() {
  return activeVlanId !== null ? `&vlan=${activeVlanId}` : "";
}

function filterToVlan(hosts) {
  if (activeVlanId === null) return hosts;
  const prefix = `192.168.${activeVlanId}.`;
  return hosts.filter((h) =>
    Number(h.vlan) === activeVlanId || (typeof h.ip === "string" && h.ip.startsWith(prefix))
  );
}

// ── Dynamic Labels ────────────────────────────────────────────────────────────
function updateVlanLabels() {
  const v      = getActiveVlan();
  const label  = vlanLabel();
  const subnet = vlanSubnet();

  const badge = document.getElementById("headerVlanBadge");
  if (badge) badge.textContent = activeVlanId !== null
    ? `VLAN ${v?.id ?? activeVlanId} · ${subnet ?? ""}`
    : "All VLANs";

  const liveTitle = document.getElementById("liveDeviceTableTitle");
  if (liveTitle) liveTitle.textContent = `${label} — Live Device Activity`;

  const histTitle = document.getElementById("historyDeviceTableTitle");
  if (histTitle) histTitle.textContent = `${label} — Cumulative Device Activity (Top Talkers)`;

  const chartTitle = document.getElementById("throughputChartTitle");
  if (chartTitle) chartTitle.textContent = `${label} Bandwidth Timeline`;

  const appsSub = document.getElementById("appsChartSub");
  if (appsSub) appsSub.textContent = `Aggregated nDPI protocol usage${subnet ? ` · ${subnet}` : ""}`;

  const footer = document.getElementById("footerText");
  if (footer) footer.textContent = `TMG Network Monitor · ${label} · Powered by ntopng REST API v2 · Persistent local history`;
}

// ── VLAN Tabs rendering ───────────────────────────────────────────────────────
function renderVlanTabs() {
  const container = document.getElementById("vlanTabs");
  if (!container) return;

  const allTab = document.createElement("button");
  allTab.className = `vlan-tab vlan-tab--all${activeVlanId === null ? " active" : ""}`;
  allTab.innerHTML = `<span class="vlan-tab__id">ALL</span><span class="vlan-tab__name">All VLANs</span>`;
  allTab.addEventListener("click", () => selectVlan(null));
  container.innerHTML = "";
  container.appendChild(allTab);

  for (const v of vlansConfig) {
    const tab = document.createElement("button");
    tab.className = `vlan-tab${activeVlanId === v.id ? " active" : ""}`;
    tab.innerHTML = `<span class="vlan-tab__id">${v.id}</span><span class="vlan-tab__name">${v.name}</span>`;
    tab.addEventListener("click", () => selectVlan(v.id));
    container.appendChild(tab);
  }
}

function selectVlan(vlanId) {
  activeVlanId = vlanId;
  renderVlanTabs();
  updateVlanLabels();
  refreshAll();
}

// ── View Switcher (Live vs Historical) ────────────────────────────────────────
function switchView(viewName) {
  if (currentView === viewName) return;
  currentView = viewName;

  const btnLive    = document.getElementById("btnViewLive");
  const btnHistory = document.getElementById("btnViewHistory");
  const viewLive   = document.getElementById("liveView");
  const viewHist   = document.getElementById("historyView");

  if (viewName === "live") {
    btnLive?.classList.add("active");
    btnHistory?.classList.remove("active");
    if (viewLive) viewLive.style.display = "block";
    if (viewHist) viewHist.style.display = "none";
    refreshLive();
  } else {
    btnHistory?.classList.add("active");
    btnLive?.classList.remove("active");
    if (viewLive) viewLive.style.display = "none";
    if (viewHist) viewHist.style.display = "block";
    refreshHistory();
  }
}

// ── Charts Setup ──────────────────────────────────────────────────────────────
function baseChartOptions() {
  return {
    responsive:          true,
    maintainAspectRatio: false,
    interaction: { mode:"index", intersect:false },
    plugins: {
      legend: {
        labels: { color:PALETTE.text, font:{ family:"Plus Jakarta Sans", size:11, weight:"600" }, boxWidth:10 },
      },
      tooltip: {
        backgroundColor:"#0f1920", borderColor:"#1e303d", borderWidth:1,
        titleColor:PALETTE.textBright, bodyColor:PALETTE.textBright,
        titleFont:{ family:"Plus Jakarta Sans", weight:"700" },
        bodyFont: { family:"JetBrains Mono" },
        padding:10,
      },
    },
    scales: {
      x: { grid:{ color:PALETTE.grid }, ticks:{ color:PALETTE.text, font:{ family:"JetBrains Mono", size:10 } } },
      y: {
        grid:  { color:PALETTE.grid },
        ticks: { color:PALETTE.text, font:{ family:"JetBrains Mono", size:10 }, callback:(v) => fmtBytes(v) },
      },
    },
  };
}

function initCharts() {
  throughputChart = new Chart(document.getElementById("throughputChart").getContext("2d"), {
    type:"line",
    data:{
      labels:[],
      datasets:[
        { label:"Download", data:[], borderColor:PALETTE.accentLight, backgroundColor:"rgba(16,185,129,0.14)", fill:true, tension:0.35, pointRadius:0, borderWidth:2 },
        { label:"Upload",   data:[], borderColor:PALETTE.cyan,        backgroundColor:"rgba(6,182,212,0.1)",   fill:true, tension:0.35, pointRadius:0, borderWidth:2 },
      ],
    },
    options:{ ...baseChartOptions(), scales:{ ...baseChartOptions().scales, y:{ ...baseChartOptions().scales.y, ticks:{ ...baseChartOptions().scales.y.ticks, callback:(v) => fmtBps(v) } } } },
  });

  appsChart = new Chart(document.getElementById("appsChart").getContext("2d"), {
    type:"bar",
    data:{
      labels:[],
      datasets:[{ label:"Total Bytes", data:[], backgroundColor:["rgba(16,185,129,.8)","rgba(6,182,212,.8)","rgba(59,130,246,.8)","rgba(245,158,11,.8)","rgba(139,92,246,.8)","rgba(236,72,153,.8)","rgba(20,184,166,.8)","rgba(249,115,22,.8)"], borderRadius:6 }],
    },
    options:{ ...baseChartOptions(), indexAxis:"y", plugins:{ ...baseChartOptions().plugins, legend:{ display:false } } },
  });

  hostAppsChart = new Chart(document.getElementById("hostAppsChart").getContext("2d"), {
    type:"doughnut",
    data:{ labels:[], datasets:[{ data:[], backgroundColor:APP_COLORS, borderColor:"#0f1920", borderWidth:2 }] },
    options:{
      responsive:true, maintainAspectRatio:false, cutout:"68%",
      plugins:{
        legend:{ position:"right", labels:{ color:PALETTE.textBright, font:{ family:"Plus Jakarta Sans", size:11, weight:"600" }, boxWidth:12, padding:8 } },
        tooltip:{ backgroundColor:"#0f1920", borderColor:"#1e303d", borderWidth:1, callbacks:{ label:(ctx) => ` ${ctx.label}: ${fmtBytes(ctx.raw)}` } },
      },
    },
  });

  hostTimelineChart = new Chart(document.getElementById("hostTimelineChart").getContext("2d"), {
    type:"line",
    data:{
      labels:[],
      datasets:[
        { label:"Download", data:[], borderColor:PALETTE.accentLight, backgroundColor:"rgba(16,185,129,0.12)", fill:true, tension:0.35, pointRadius:0, borderWidth:2 },
        { label:"Upload",   data:[], borderColor:PALETTE.cyan,        backgroundColor:"rgba(6,182,212,0.08)",  fill:true, tension:0.35, pointRadius:0, borderWidth:2 },
      ],
    },
    options:{ ...baseChartOptions(), scales:{ ...baseChartOptions().scales, y:{ ...baseChartOptions().scales.y, ticks:{ ...baseChartOptions().scales.y.ticks, callback:(v) => fmtBps(v) } } } },
  });
}

// ── Data Fetchers ─────────────────────────────────────────────────────────────

async function fetchVlans() {
  try {
    const data = await apiGet("/api/vlans");
    vlansConfig = data || [];
    renderVlanTabs();
    updateVlanLabels();
  } catch (err) {
    console.warn("[vlans] Could not fetch VLAN list:", err.message);
  }
}

async function fetchStatus() {
  try {
    const s          = await apiGet("/api/status");
    const statusLine = document.getElementById("statusLine");
    const liveDot    = document.getElementById("liveDot");
    const liveText   = document.getElementById("liveText");
    const healthBar  = document.getElementById("networkHealthBar");
    const lastPollEl = document.getElementById("lastPollBadge");

    if (s.lastPollTs) {
      const pollTime = new Date(s.lastPollTs * 1000);
      if (lastPollEl) lastPollEl.textContent = `Last poll: ${pollTime.toLocaleTimeString()}`;

      const age = Math.floor(Date.now() / 1000) - s.lastPollTs;
      if (age > s.pollIntervalSeconds * 3) {
        liveDot.classList.add("live-pulse--stale");
        liveText.textContent   = "STALE";
        statusLine.textContent = `Last poll ${age}s ago · ${vlanLabel()} · ${s.dbStats?.hostCount || 0} host records`;
        if (healthBar) healthBar.style.background = "#f59e0b";
      } else {
        liveDot.classList.remove("live-pulse--stale");
        liveText.textContent   = "LIVE";
        const subnetPart = vlanSubnet() ? ` · Subnet ${vlanSubnet()}` : "";
        statusLine.textContent = `Monitoring ${vlanLabel()}${subnetPart} · Poll: ${s.pollIntervalSeconds}s`;
        if (healthBar) healthBar.style.background = "linear-gradient(90deg,#10b981,#06b6d4)";
      }
    } else {
      statusLine.textContent = `${vlanLabel()} · Waiting for initial poll…`;
      if (healthBar) healthBar.style.background = "#64748b";
    }
  } catch (err) {
    document.getElementById("statusLine").textContent = "API unreachable: " + err.message;
    const healthBar = document.getElementById("networkHealthBar");
    if (healthBar) healthBar.style.background = "#ef4444";
  }
}

async function fetchAliases() {
  aliases = await apiGet("/api/aliases");
}

// ==============================================================================
// 📡 VIEW 1: LIVE MONITOR REFRESH & RENDERING
// ==============================================================================

async function refreshLive() {
  try {
    await Promise.allSettled([fetchStatus(), fetchAliases()]);
    const raw = await apiGet(`/api/live/hosts?${vlanQS()}`);
    liveHosts = filterToVlan(raw || []);
    liveHosts.forEach((h) => { if (aliases[h.ip]) h.name = aliases[h.ip]; });

    updateLiveKPIs();
    renderLiveHostsTable();
  } catch (err) {
    console.error("refreshLive error:", err);
  }
}

function updateLiveKPIs() {
  const activeCount = liveHosts.filter((h) => deviceStatus(h) === "active").length;
  const totalBps    = liveHosts.reduce((s, h) => s + (h.bps || 0), 0);
  const totalSent   = liveHosts.reduce((s, h) => s + (h.bytes_sent || 0), 0);
  const totalRcvd   = liveHosts.reduce((s, h) => s + (h.bytes_rcvd || 0), 0);

  const kpiDown = document.getElementById("kpiLiveDown");
  const kpiUp   = document.getElementById("kpiLiveUp");
  const kpiBw   = document.getElementById("kpiLiveTotalBw");
  const kpiHst  = document.getElementById("kpiLiveHosts");

  if (kpiDown) kpiDown.textContent = fmtBps(totalBps > 0 ? (totalBps * 0.7) : 0);
  if (kpiUp)   kpiUp.textContent   = fmtBps(totalBps > 0 ? (totalBps * 0.3) : 0);
  if (kpiBw)   kpiBw.textContent   = fmtBps(totalBps);
  if (kpiHst)  kpiHst.textContent  = `${activeCount} / ${liveHosts.length}`;

  const kpiBwSub  = document.getElementById("kpiLiveTotalBwSub");
  const kpiHstSub = document.getElementById("kpiLiveHostsSub");
  if (kpiBwSub)  kpiBwSub.textContent  = `Session: ↓${fmtBytes(totalRcvd)} ↑${fmtBytes(totalSent)}`;
  if (kpiHstSub) kpiHstSub.textContent = `${activeCount} actively passing traffic`;
}

function renderLiveHostsTable() {
  const searchInput = document.getElementById("liveHostSearch");
  const sortByInput = document.getElementById("liveSortBy");
  const tbody       = document.getElementById("liveHostsBody");
  if (!tbody) return;

  const searchTerm = (searchInput?.value || "").toLowerCase().trim();
  const sortBy     = sortByInput?.value || "bps";

  let filtered = liveHosts.filter((h) => {
    return !searchTerm ||
      (h.ip   && h.ip.toLowerCase().includes(searchTerm))   ||
      (h.name && h.name.toLowerCase().includes(searchTerm)) ||
      (h.mac  && h.mac.toLowerCase().includes(searchTerm));
  });

  filtered.sort((a, b) => {
    if (sortBy === "bps")      return (b.bps || 0) - (a.bps || 0);
    if (sortBy === "bytes")    return (b.bytes_total || 0) - (a.bytes_total || 0);
    if (sortBy === "duration") return (b.duration_sec || 0) - (a.duration_sec || 0);
    if (sortBy === "ip")       return (a.ip || "").localeCompare(b.ip || "");
    return 0;
  });

  const countLabel = document.getElementById("liveHostsCountLabel");
  if (countLabel) {
    countLabel.textContent = `Showing ${filtered.length} of ${liveHosts.length} live devices`;
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">No active devices found in current poll.</td></tr>`;
    return;
  }

  const maxBps = Math.max(...filtered.map((h) => h.bps || 0), 1);

  tbody.innerHTML = filtered.map((h) => {
    const status  = deviceStatus(h);
    const bwPct   = Math.round(((h.bps || 0) / maxBps) * 100);

    const vlanInfo = vlansConfig.find((v) => {
      const prefix = `192.168.${v.id}.`;
      return Number(h.vlan) === v.id || (typeof h.ip === "string" && h.ip.startsWith(prefix));
    });
    const vlanTag = vlanInfo ? `<span class="badge badge--vlan" style="font-size:9px;padding:1px 5px;margin-left:4px">VLAN${vlanInfo.id}·${vlanInfo.name}</span>` : "";

    const rowClass = status === "active" ? "row--active" : "";

    return `
      <tr data-ip="${h.ip}" class="${rowClass}">
        <td>
          <span class="device-status device-status--${status}">${status.toUpperCase()}</span>
        </td>
        <td>
          <div class="host-cell">
            <span class="host-ip">${h.ip} <span class="arrow">➜</span></span>
            <span class="host-sub">${h.name && h.name !== h.ip ? h.name : (h.mac || "Network Host")}${activeVlanId === null ? vlanTag : ""}</span>
          </div>
        </td>
        <td>
          <div style="font-family:var(--font-mono);font-size:12px;color:var(--text-primary)">${fmtDateTime(h.last_seen)}</div>
          <div class="host-sub">Active ${fmtDuration(h.duration_sec)}</div>
        </td>
        <td>
          <div class="host-cell">
            <span class="traffic-val">${fmtBytes(h.bytes_total)}</span>
            <span class="host-sub">
              <span style="color:var(--accent-light)">↓ ${fmtBytes(h.bytes_rcvd)}</span>
              &nbsp;
              <span style="color:var(--cyan)">↑ ${fmtBytes(h.bytes_sent)}</span>
            </span>
          </div>
        </td>
        <td><span class="bps-val">${fmtBps(h.bps)}</span></td>
        <td>
          <div class="bw-bar"><div class="bw-bar__fill" style="width:${bwPct}%"></div></div>
          <div style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted);text-align:center">${bwPct}%</div>
        </td>
        <td style="text-align:right" onclick="event.stopPropagation()">
          <button class="table-btn--l7" onclick="openHostDrawerAndAnalyze('${h.ip}')" title="Inspect Layer 7 Apps on demand">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            Analyze L7
          </button>
        </td>
      </tr>`;
  }).join("");

  tbody.querySelectorAll("tr[data-ip]").forEach((tr) => {
    tr.addEventListener("click", () => openHostDrawer(tr.dataset.ip));
  });
}

function openHostDrawerAndAnalyze(ip) {
  openHostDrawer(ip).then(() => {
    fetchLiveL7();
  });
}
window.openHostDrawerAndAnalyze = openHostDrawerAndAnalyze;

// ==============================================================================
// 📊 VIEW 2: HISTORICAL ANALYTICS REFRESH & RENDERING
// ==============================================================================

async function refreshHistory() {
  try {
    await Promise.allSettled([
      fetchStatus(),
      fetchAliases(),
      fetchHistoryHosts(),
      fetchThroughputChart(),
      fetchTopAppsChart(),
      fetchAlerts(),
    ]);
  } catch (err) {
    console.error("refreshHistory error:", err);
  }
}

async function fetchHistoryHosts() {
  const raw = await apiGet(`/api/history/hosts?hours=${currentHours}${vlanQS()}`);
  historyHosts = filterToVlan(raw || []);
  historyHosts.forEach((h) => { if (aliases[h.ip]) h.name = aliases[h.ip]; });

  availableHistApps.clear();
  historyHosts.forEach((h) => {
    if (h.top_app) availableHistApps.add(h.top_app);
    (h.top_apps || []).forEach((a) => availableHistApps.add(a.name));
  });

  const appFilter   = document.getElementById("historyAppFilter");
  if (appFilter) {
    const selectedApp = appFilter.value;
    appFilter.innerHTML = '<option value="">All Applications</option>';
    [...availableHistApps].sort().forEach((app) => {
      const opt = document.createElement("option");
      opt.value = app; opt.textContent = app;
      if (app === selectedApp) opt.selected = true;
      appFilter.appendChild(opt);
    });
  }

  updateHistoryKPIs();
  renderHistoryHostsTable();
}

function updateHistoryKPIs() {
  const totalBytes = historyHosts.reduce((s, h) => s + (h.bytes_total || 0), 0);
  const totalVolEl = document.getElementById("kpiHistTotalVol");
  if (totalVolEl) totalVolEl.textContent = fmtBytes(totalBytes);

  const appCounts = {};
  historyHosts.forEach((h) => {
    (h.top_apps || []).forEach((a) => {
      appCounts[a.name] = (appCounts[a.name] || 0) + (a.bytes || 0);
    });
  });
  const sorted = Object.entries(appCounts).sort((a, b) => b[1] - a[1]);
  const topAppEl     = document.getElementById("kpiHistTopApp");
  const topAppBytes  = document.getElementById("kpiHistTopAppBytes");
  if (sorted.length > 0) {
    if (topAppEl)    topAppEl.textContent    = sorted[0][0];
    if (topAppBytes) topAppBytes.textContent = `${fmtBytes(sorted[0][1])} recorded`;
  } else {
    if (topAppEl)    topAppEl.textContent    = "—";
    if (topAppBytes) topAppBytes.textContent = "No app records";
  }
}

function renderHistoryHostsTable() {
  const searchInput = document.getElementById("historyHostSearch");
  const appFilter   = document.getElementById("historyAppFilter");
  const sortByInput = document.getElementById("historySortBy");
  const tbody       = document.getElementById("historyHostsBody");
  if (!tbody) return;

  const searchTerm  = (searchInput?.value || "").toLowerCase().trim();
  const selectedApp = appFilter?.value || "";
  const sortBy      = sortByInput?.value || "bytes";

  let filtered = historyHosts.filter((h) => {
    const matchSearch =
      !searchTerm ||
      (h.ip   && h.ip.toLowerCase().includes(searchTerm))   ||
      (h.name && h.name.toLowerCase().includes(searchTerm)) ||
      (h.mac  && h.mac.toLowerCase().includes(searchTerm));
    const matchApp =
      !selectedApp ||
      (h.top_app  && h.top_app.toLowerCase() === selectedApp.toLowerCase()) ||
      (h.top_apps && h.top_apps.some((a) => a.name.toLowerCase() === selectedApp.toLowerCase()));
    return matchSearch && matchApp;
  });

  filtered.sort((a, b) => {
    if (sortBy === "bytes")    return (b.bytes_total || 0) - (a.bytes_total || 0);
    if (sortBy === "sent")     return (b.bytes_sent  || 0) - (a.bytes_sent  || 0);
    if (sortBy === "rcvd")     return (b.bytes_rcvd  || 0) - (a.bytes_rcvd  || 0);
    if (sortBy === "duration") return (b.duration_sec || 0) - (a.duration_sec || 0);
    if (sortBy === "ip")       return (a.ip || "").localeCompare(b.ip || "");
    return 0;
  });

  const countLabel = document.getElementById("historyHostsCountLabel");
  if (countLabel) {
    countLabel.textContent = `Showing ${filtered.length} of ${historyHosts.length} recorded devices`;
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">No historical host records match criteria.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map((h) => {
    const vlanInfo = vlansConfig.find((v) => {
      const prefix = `192.168.${v.id}.`;
      return Number(h.vlan) === v.id || (typeof h.ip === "string" && h.ip.startsWith(prefix));
    });
    const vlanTag = vlanInfo ? `<span class="badge badge--vlan" style="font-size:9px;padding:1px 5px;margin-left:4px">VLAN${vlanInfo.id}·${vlanInfo.name}</span>` : "";

    const apps = h.top_apps && h.top_apps.length > 0
      ? h.top_apps
      : (h.top_app ? [{ name:h.top_app, bytes:h.bytes_total }] : []);

    const appChipsHtml = apps.length > 0
      ? apps.map((app, idx) => {
          const chipClass = idx === 0 ? "app-chip app-chip--primary" : "app-chip app-chip--secondary";
          return `<span class="${chipClass}"><strong>${app.name}</strong>${app.bytes ? ` <span class="app-chip__bytes">${fmtBytes(app.bytes)}</span>` : ""}</span>`;
        }).join("")
      : `<span class="app-chip app-chip--other">Recorded Activity</span>`;

    return `
      <tr data-ip="${h.ip}">
        <td>
          <div class="host-cell">
            <span class="host-ip">${h.ip} <span class="arrow">➜</span></span>
            <span class="host-sub">${h.name && h.name !== h.ip ? h.name : (h.mac || "Network Host")}${activeVlanId === null ? vlanTag : ""}</span>
          </div>
        </td>
        <td>
          <div style="font-family:var(--font-mono);font-size:12px;color:var(--text-primary)">${fmtDateTime(h.max_ts || h.last_seen)}</div>
          <div class="host-sub">${h.active_polls || 1} active snapshots</div>
        </td>
        <td>
          <div class="app-chips-container">${appChipsHtml}</div>
        </td>
        <td>
          <div class="host-cell">
            <span class="traffic-val">${fmtBytes(h.bytes_total)}</span>
            <span class="host-sub">
              <span style="color:var(--accent-light)">↓ ${fmtBytes(h.bytes_rcvd)}</span>
              &nbsp;
              <span style="color:var(--cyan)">↑ ${fmtBytes(h.bytes_sent)}</span>
            </span>
          </div>
        </td>
        <td><span class="bps-val">${fmtBps(h.bps)}</span></td>
        <td><span style="font-family:var(--font-mono);font-size:12px;color:var(--text-muted)">${h.num_flows || "—"}</span></td>
      </tr>`;
  }).join("");

  tbody.querySelectorAll("tr[data-ip]").forEach((tr) => {
    tr.addEventListener("click", () => openHostDrawer(tr.dataset.ip));
  });
}

async function fetchThroughputChart() {
  const rows = await apiGet(`/api/history/traffic?hours=${currentHours}`);
  throughputChart.data.labels           = rows.map((r) => fmtTime(r.ts));
  throughputChart.data.datasets[0].data = rows.map((r) => r.bps_down);
  throughputChart.data.datasets[1].data = rows.map((r) => r.bps_up);
  throughputChart.update();

  let peakDown = 0, peakUp = 0;
  rows.forEach((r) => {
    if (r.bps_down > peakDown) peakDown = r.bps_down;
    if (r.bps_up   > peakUp)   peakUp   = r.bps_up;
  });

  const peakDownEl = document.getElementById("kpiHistPeakDown");
  const peakUpEl   = document.getElementById("kpiHistPeakUp");
  if (peakDownEl) peakDownEl.textContent = fmtBps(peakDown);
  if (peakUpEl)   peakUpEl.textContent   = fmtBps(peakUp);
}

async function fetchTopAppsChart() {
  const rows = await apiGet(`/api/apps/top?hours=${currentHours}&limit=8${vlanQS()}`);
  appsChart.data.labels           = rows.map((r) => r.app_name);
  appsChart.data.datasets[0].data = rows.map((r) => r.total_bytes);
  appsChart.update();
}

async function fetchAlerts() {
  const alerts = await apiGet(`/api/alerts?hours=168&limit=100`);
  const list   = document.getElementById("alertsList");
  if (!list) return;
  if (!alerts.length) {
    list.innerHTML = `<li class="empty-state">No alerts recorded in the past 7 days.</li>`;
    return;
  }
  list.innerHTML = alerts.map((a) => {
    const sev      = (a.severity || "info").toLowerCase();
    const dotClass = sev === "error" ? "alert-dot--error" : sev === "warning" ? "alert-dot--warning" : "alert-dot--info";
    return `
      <li class="alert-item">
        <span class="alert-dot ${dotClass}"></span>
        <div class="alert-body">
          <span class="alert-title">${a.alert_name}</span>
          ${a.description ? `<span class="alert-desc">${a.description}</span>` : ""}
          <span class="alert-meta">${fmtDateTime(a.ts)}</span>
        </div>
      </li>`;
  }).join("");
}

// ── CSV Export ────────────────────────────────────────────────────────────────
function exportHistoryCsv() {
  if (!historyHosts || historyHosts.length === 0) {
    alert("No historical records to export.");
    return;
  }

  const headers = ["IP Address", "Hostname/Alias", "MAC", "VLAN", "Total Bytes", "Bytes Sent", "Bytes Received", "Peak bps", "Flows", "Last Seen"];
  const rows = historyHosts.map((h) => [
    `"${h.ip || ""}"`,
    `"${(h.name || "").replace(/"/g, '""')}"`,
    `"${h.mac || ""}"`,
    `"${h.vlan || ""}"`,
    h.bytes_total || 0,
    h.bytes_sent || 0,
    h.bytes_rcvd || 0,
    h.bps || 0,
    h.num_flows || 0,
    `"${fmtDateTime(h.max_ts || h.last_seen)}"`,
  ]);

  const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\r\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `tmg-network-history-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Host Detail Drawer ────────────────────────────────────────────────────────
async function openHostDrawer(ip) {
  activeHostIp = ip;
  document.getElementById("hostDrawerOverlay").classList.add("open");
  document.getElementById("drawerIp").textContent     = ip;
  document.getElementById("drawerName").innerHTML     = "Loading...";
  document.getElementById("drawerMac").textContent    = "MAC: —";
  document.getElementById("drawerAppsBody").innerHTML = `<tr><td colspan="7" class="empty-state">Loading host history…</td></tr>`;
  resetL7Panel();
  await refreshHostDetails();
}

async function refreshHostDetails() {
  if (!activeHostIp) return;

  const data     = await apiGet(`/api/hosts/${encodeURIComponent(activeHostIp)}/details?hours=${hostDrawerHours}`);
  const host     = data.host     || {};
  const apps     = data.apps     || [];
  const timeline = data.timeline || [];

  const hostVlanId = Number(host.vlan) || activeVlanId;
  const hostVlan   = vlansConfig.find((v) => v.id === hostVlanId);
  const vlanDetail = hostVlan ? `VLAN ${hostVlan.id} · ${hostVlan.name}` : `VLAN ${hostVlanId || "?"}`;

  const displayName = (host.name && host.name !== host.ip) ? host.name : `Device ${activeHostIp}`;
  document.getElementById("drawerName").innerHTML =
    `${displayName} <span style="font-size:12px;cursor:pointer;opacity:0.6;margin-left:8px" onclick="renameHost('${activeHostIp}','${(host.name||'').replace(/'/g,"&apos;")}')" title="Rename device">✏️</span>`;
  document.getElementById("drawerMac").textContent        = `MAC: ${host.mac||"Unknown"} · ${vlanDetail}`;
  document.getElementById("drawerDuration").textContent   = fmtDuration(host.duration_sec);
  document.getElementById("drawerTotalBytes").textContent = fmtBytes(host.bytes_total);
  document.getElementById("drawerSent").textContent       = fmtBytes(host.bytes_sent);
  document.getElementById("drawerRcvd").textContent       = fmtBytes(host.bytes_rcvd);
  document.getElementById("drawerBps").textContent        = fmtBps(host.bps);
  document.getElementById("drawerAppCount").textContent   = `${apps.length} Apps`;
  document.getElementById("drawerTimeframeBadge").textContent =
    hostDrawerHours <= 24 ? "Past 24 Hours" : hostDrawerHours <= 168 ? "Past 7 Days" : "Past 30 Days";

  // Donut chart
  const topApps = apps.slice(0, 7);
  hostAppsChart.data.labels           = topApps.map((a) => a.app_name);
  hostAppsChart.data.datasets[0].data = topApps.map((a) => a.total_bytes);
  hostAppsChart.update();

  // Apps table
  const totalHostBytes = apps.reduce((s, a) => s + (a.total_bytes || 0), 0) || host.bytes_total || 1;
  const tbody = document.getElementById("drawerAppsBody");

  if (apps.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">No application records logged for this device in the selected window.</td></tr>`;
  } else {
    tbody.innerHTML = apps.map((a) => {
      const pct      = Math.min(100, Math.round((a.total_bytes / totalHostBytes) * 100));
      const r        = Number(a.total_bytes_rcvd) || 0;
      const s        = Number(a.total_bytes_sent) || 0;

      return `
        <tr>
          <td><span class="app-chip app-chip--primary"><strong>${a.app_name}</strong></span></td>
          <td>${fmtDuration(a.duration_sec)}</td>
          <td style="color:var(--cyan)">${fmtBytes(s)}</td>
          <td style="color:var(--accent-light)">${fmtBytes(r)}</td>
          <td>${fmtBytes(a.total_bytes)}</td>
          <td>
            ${pct}%
            <div class="progress-bar-wrap"><div class="progress-bar" style="width:${pct}%"></div></div>
          </td>
          <td>${a.total_flows || "—"}</td>
        </tr>`;
    }).join("");
  }

  // Timeline chart
  hostTimelineChart.data.labels           = timeline.map((t) => fmtTime(t.ts));
  hostTimelineChart.data.datasets[0].data = timeline.map((t) => t.bps);
  hostTimelineChart.data.datasets[1].data = timeline.map((t) => {
    const totalBps = t.bps || 0;
    const sentFrac = t.bytes_total > 0 ? (t.bytes_sent || 0) / t.bytes_total : 0;
    return totalBps * sentFrac;
  });
  hostTimelineChart.update();
}

function closeHostDrawer() {
  document.getElementById("hostDrawerOverlay").classList.remove("open");
  activeHostIp = null;
}

// ── Live L7 On-Demand Analysis ────────────────────────────────────────────────
async function fetchLiveL7() {
  if (!activeHostIp) return;

  const btn    = document.getElementById("l7FetchBtn");
  const result = document.getElementById("l7Result");

  btn.disabled   = true;
  btn.innerHTML  = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" class="spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Fetching…`;
  result.className = "l7-result l7-result--loading";
  result.innerHTML = `<div class="l7-loading"><div class="l7-spinner"></div><span>Querying ntopng for live L7 data…</span></div>`;

  try {
    const data = await apiGet(`/api/hosts/${encodeURIComponent(activeHostIp)}/l7/live`);
    renderLiveL7(data);
  } catch (err) {
    result.className = "l7-result l7-result--error";
    result.innerHTML = `<div class="l7-error-msg"><strong>Failed to fetch L7 data</strong><br><span style="font-size:11px;color:#94a3b8">${err.message}</span></div>`;
  } finally {
    btn.disabled  = false;
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg> Refresh`;
  }
}
window.fetchLiveL7 = fetchLiveL7;

function renderLiveL7(data) {
  const result = document.getElementById("l7Result");
  const apps   = data.apps || [];
  const fetchedAt = data.fetched_at ? new Date(data.fetched_at * 1000).toLocaleTimeString() : "—";

  if (apps.length === 0) {
    result.className = "l7-result l7-result--empty";
    result.innerHTML = `<div class="l7-idle-msg"><p>No active L7 application traffic detected for this host right now.</p><p style="font-size:11px;color:#475569">The device may be idle. Try again when it is actively sending/receiving traffic.</p></div>`;
    return;
  }

  result.className = "l7-result l7-result--loaded";

  const rows = apps.map((a, i) => {
    const color = APP_COLORS[i % APP_COLORS.length];
    return `
      <tr>
        <td>
          <div style="display:flex;align-items:center;gap:8px">
            <span style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0;display:inline-block"></span>
            <span class="app-chip app-chip--primary"><strong>${a.app_name}</strong></span>
          </div>
        </td>
        <td>
          <div class="l7-bar-wrap">
            <div class="l7-bar" style="width:${a.pct}%;background:${color}"></div>
          </div>
          <span style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted)">${a.pct}%</span>
        </td>
        <td style="font-family:var(--font-mono);font-size:12px">${fmtBytes(a.bytes)}</td>
        <td style="font-family:var(--font-mono);font-size:12px;color:var(--cyan)">${fmtBytes(a.bytes_sent)}</td>
        <td style="font-family:var(--font-mono);font-size:12px;color:var(--accent-light)">${fmtBytes(a.bytes_rcvd)}</td>
        <td style="font-family:var(--font-mono);font-size:12px;color:var(--text-muted)">${a.flows || "—"}</td>
      </tr>`;
  }).join("");

  result.innerHTML = `
    <div class="l7-meta">
      <span class="badge" style="background:rgba(16,185,129,0.12);color:#10b981;border:1px solid rgba(16,185,129,0.25)">● Live snapshot · ${fetchedAt}</span>
      <span style="font-size:11px;color:#475569">${apps.length} protocols detected · ${fmtBytes(data.total_bytes)} total · ${data.num_flows || 0} flows</span>
    </div>
    <div class="drawer__table-wrap" style="margin-top:10px">
      <table class="drawer__table">
        <thead>
          <tr>
            <th>Application / Protocol</th>
            <th>Traffic Share</th>
            <th>Total</th>
            <th>↑ Sent</th>
            <th>↓ Received</th>
            <th>Flows</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function resetL7Panel() {
  const result = document.getElementById("l7Result");
  const btn    = document.getElementById("l7FetchBtn");
  if (result) {
    result.className = "l7-result l7-result--idle";
    result.innerHTML = `<div class="l7-idle-msg">
      <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5" style="color:#475569"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      <p>Click <strong>Analyze Now</strong> to fetch real-time Layer 7 application data for this device directly from ntopng.</p>
      <p style="font-size:11px;color:#475569;margin-top:4px">This is an on-demand request — it does not run in the background.</p>
    </div>`;
  }
  if (btn) {
    btn.disabled  = false;
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg> Analyze Now`;
  }
}

// ── Rename (alias) ────────────────────────────────────────────────────────────
async function renameHost(ip, currentName) {
  const newName = prompt(`Enter a friendly name for ${ip}:`, currentName);
  if (newName === null) return;
  try {
    await fetch(API_BASE + "/api/aliases", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({ ip, name:newName.trim() }),
    });
    aliases[ip] = newName.trim();
    refreshAll();
  } catch (e) {
    alert("Failed to save alias: " + e.message);
  }
}
window.renameHost = renameHost;

// ── Event wiring ──────────────────────────────────────────────────────────────
function wireEvents() {
  // View Switcher
  document.getElementById("btnViewLive")?.addEventListener("click", () => switchView("live"));
  document.getElementById("btnViewHistory")?.addEventListener("click", () => switchView("history"));

  // History Time Range
  document.querySelectorAll("#historyRangeToggle .range-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#historyRangeToggle .range-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentHours = Number(btn.dataset.hours);
      refreshHistory();
    });
  });

  // Drawer Range
  document.querySelectorAll("#hostRangeToggle .range-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#hostRangeToggle .range-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      hostDrawerHours = Number(btn.dataset.hours);
      refreshHostDetails();
    });
  });

  // Live Table Filters
  document.getElementById("liveHostSearch")?.addEventListener("input", renderLiveHostsTable);
  document.getElementById("liveSortBy")?.addEventListener("change",    renderLiveHostsTable);

  // History Table Filters
  document.getElementById("historyHostSearch")?.addEventListener("input",  renderHistoryHostsTable);
  document.getElementById("historyAppFilter")?.addEventListener("change",  renderHistoryHostsTable);
  document.getElementById("historySortBy")?.addEventListener("change",     renderHistoryHostsTable);

  // Export CSV
  document.getElementById("exportCsvBtn")?.addEventListener("click", exportHistoryCsv);

  // Sync / Refresh Button
  document.getElementById("refreshBtn")?.addEventListener("click", async () => {
    const icon = document.getElementById("refreshIcon");
    if (icon) {
      icon.style.transform  = "rotate(360deg)";
      icon.style.transition = "transform 0.6s ease";
    }
    await refreshAll();
    if (icon) {
      setTimeout(() => { icon.style.transform = ""; icon.style.transition = ""; }, 600);
    }
  });

  // Drawer Close
  document.getElementById("drawerCloseBtn")?.addEventListener("click", closeHostDrawer);
  document.getElementById("hostDrawerOverlay")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("hostDrawerOverlay")) closeHostDrawer();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeHostDrawer(); });
}

// ── Main refresh coordinator ──────────────────────────────────────────────────
async function refreshAll() {
  if (isRefreshing) return;
  isRefreshing = true;
  try {
    if (currentView === "live") {
      await refreshLive();
    } else {
      await refreshHistory();
    }
    if (activeHostIp) await refreshHostDetails();
  } catch (err) {
    console.error("Refresh error:", err);
  } finally {
    isRefreshing = false;
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────
try {
  initCharts();
  wireEvents();
  updateClock();
  setInterval(updateClock, 1000);

  fetchVlans().then(() => {
    refreshAll();
    setInterval(refreshAll, 15_000);
  });
} catch (err) {
  console.error("Startup error:", err);
  document.getElementById("statusLine").textContent = "Startup error: " + err.message;
}
