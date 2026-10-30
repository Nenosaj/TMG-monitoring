const db = require("./db");

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Build the set of subnet prefixes for a list of VLAN IDs.
 * e.g. [5, 70] → ["192.168.5.", "192.168.70."]
 */
function subnetPrefixes(vlans) {
  return vlans.map((v) => `192.168.${v}.`);
}

/**
 * Start a background poller for one or more VLANs.
 *
 * @param {object}   opts
 * @param {object}   opts.client            ntopng REST client
 * @param {number[]} opts.vlans             Array of VLAN IDs to monitor
 * @param {number}   opts.intervalSeconds   Poll interval (default 60)
 * @param {number}   opts.retentionDays     Data retention (default 30)
 * @param {Function} opts.log               Logger function
 */
function startPoller({ client, vlans = [70], intervalSeconds = 120, retentionDays = 30, log = console.log }) {
  let isPolling  = false;
  let _pollCount = 0;
  const prefixes = subnetPrefixes(vlans);
  const vlanSet  = new Set(vlans.map(Number));

  // --- Tuning knobs ---
  // Set to 0 to disable per-host L7 enrichment entirely (saves the most CPU on ntopng/pfSense).
  // Interface-wide app stats (getInterfaceL7Stats) still run regardless.
  const MAX_L7_HOSTS = 0;
  // Only enrich hosts actively passing traffic above this threshold (bps)
  const BPS_THRESHOLD_FOR_L7 = 1000;
  // Concurrency for per-host L7 calls (lower = gentler on ntopng/pfSense)
  const BATCH_SIZE = 2;
  // Delay (ms) between batches to spread load
  const BATCH_DELAY_MS = 500;
  // Only fetch alerts every N cycles (e.g. 5 × 120s = every 10 minutes)
  const ALERT_EVERY_N_CYCLES = 5;

  function matchesMonitoredVlan(h) {
    const hVlan = Number(h.vlan);
    if (vlanSet.has(hVlan)) return true;
    // ntopng often reports internal hosts with vlan=0; fall back to subnet match
    return typeof h.ip === "string" && prefixes.some((pfx) => h.ip.startsWith(pfx));
  }

  /** Determine which monitored VLAN a host belongs to (by subnet prefix). */
  function resolveVlan(h) {
    const hVlan = Number(h.vlan);
    if (vlanSet.has(hVlan)) return hVlan;
    for (const pfx of prefixes) {
      if (typeof h.ip === "string" && h.ip.startsWith(pfx)) {
        // derive VLAN from third octet: 192.168.70.x → 70
        const parts = h.ip.split(".");
        return Number(parts[2]);
      }
    }
    return vlans[0]; // fallback
  }

  async function pollOnce() {
    if (isPolling) {
      log(`[poller] previous cycle still running, skipping...`);
      return;
    }
    isPolling = true;
    _pollCount++;
    const ts = nowTs();

    try {
      // 1. Interface throughput data
      const ifaceData = await client.getInterfaceData();

      // 2. Active hosts — fetch all, then filter to any monitored VLAN/subnet
      const allHosts = await client.getActiveHosts();
      const hosts    = (allHosts || []).filter(matchesMonitoredVlan);

      // 3. Interface-wide L7 stats
      let ifaceL7List = [];
      try {
        const rawIfaceL7 = await client.getInterfaceL7Stats();
        if (Array.isArray(rawIfaceL7)) {
          ifaceL7List = rawIfaceL7;
        } else if (rawIfaceL7?.labels && rawIfaceL7?.series) {
          ifaceL7List = rawIfaceL7.labels.map((lbl, idx) => ({
            label: lbl,
            value: rawIfaceL7.series[idx] || 0,
            count: rawIfaceL7.series[idx] || 0,
          }));
        } else if (rawIfaceL7 && typeof rawIfaceL7 === "object") {
          ifaceL7List = Object.entries(rawIfaceL7).map(([k, v]) => ({
            label: k,
            value: typeof v === "object" ? (v.bytes || v.value || 0) : Number(v || 0),
            count: typeof v === "object" ? (v.flows || v.count || 0) : 0,
          }));
        }
      } catch (e) {
        // Non-fatal
      }

      // 4. Alerts — throttled: only fetch every ALERT_EVERY_N_CYCLES cycles
      let alerts = [];
      if (_pollCount % ALERT_EVERY_N_CYCLES === 0) {
        try {
          const rawAlerts = await client.getAlertList();
          alerts = (rawAlerts || []).map((a) => ({
            row_id:     a.row_id || a.id,
            severity:   (a.severity?.label || a.severity || "info").replace(/<[^>]+>/g, "").trim(),
            alert_name: (a.alert_name || a.title || "Alert").replace(/<[^>]+>/g, "").trim(),
            description:(a.msg?.description || a.description || a.msg || "").replace(/<[^>]+>/g, "").trim(),
          }));
        } catch (e) {
          // Non-fatal
        }
      }

      // Insert interface snapshot
      db.insertInterfaceSnapshot({
        ts,
        bps_down:    ifaceData?.throughput?.download?.bps ?? 0,
        bps_up:      ifaceData?.throughput?.upload?.bps   ?? 0,
        pps_down:    ifaceData?.throughput?.download?.pps ?? 0,
        pps_up:      ifaceData?.throughput?.upload?.pps   ?? 0,
        bytes_total: ifaceData?.bytes     ?? 0,
        num_hosts:   hosts.length,
        num_flows:   ifaceData?.num_flows ?? 0,
      });

      // Per-host snapshots & per-host app snapshots
      const hostRows    = [];
      const hostAppRows = [];

      // --- OPTIMIZATION: Only enrich hosts that are actively passing traffic ---
      // Sort by bps descending and cap at MAX_L7_HOSTS to avoid hammering ntopng
      const hostsForL7 = hosts
        .filter(h => (h.thpt?.bps ?? h.throughput_bps ?? 0) > BPS_THRESHOLD_FOR_L7)
        .sort((a, b) => (b.thpt?.bps ?? b.throughput_bps ?? 0) - (a.thpt?.bps ?? a.throughput_bps ?? 0))
        .slice(0, MAX_L7_HOSTS);

      const l7Set = new Set(hostsForL7.map(h => h.ip));

      // Build host metric rows for ALL hosts first (no L7 needed for basic stats)
      for (const h of hosts) {
        const bytesSent  = h.bytes?.sent  ?? 0;
        const bytesRcvd  = h.bytes?.recvd ?? h.bytes?.received ?? h.bytes?.rcvd ?? 0;
        const bytesTotal = h.bytes?.total ?? (bytesSent + bytesRcvd);
        const bps        = h.thpt?.bps ?? h.throughput_bps ?? 0;
        const pps        = h.thpt?.pps ?? h.throughput_pps ?? 0;
        const numFlows   = h.num_flows?.total ?? h.num_flows ?? 0;
        const hostDuration = (h.last_seen && h.first_seen) ? (h.last_seen - h.first_seen) : 0;

        hostRows.push({
          ts,
          ip:          h.ip,
          name:        h.name || h.ip,
          mac:         h.mac || "",
          vlan:        resolveVlan(h),
          bytes_sent:  bytesSent,
          bytes_rcvd:  bytesRcvd,
          bytes_total: bytesTotal,
          bps,
          pps,
          num_flows:   numFlows,
          top_app:     null,   // filled in below for active hosts
          duration_sec:hostDuration,
          first_seen:  h.first_seen ?? h.seen?.first,
          last_seen:   h.last_seen  ?? h.seen?.last,
        });
      }

      // Build a quick lookup map for the hostRows by IP so we can backfill top_app
      const hostRowByIp = new Map(hostRows.map(r => [r.ip, r]));

      // --- L7 enrichment: batched with delay, only for active hosts ---
      for (let i = 0; i < hostsForL7.length; i += BATCH_SIZE) {
        const batch = hostsForL7.slice(i, i + BATCH_SIZE);
        await Promise.all(
          batch.map(async (h) => {
            const row          = hostRowByIp.get(h.ip);
            const totalForRatio = (row.bytes_sent + row.bytes_rcvd) || 1;
            const sentRatio    = row.bytes_sent / totalForRatio;
            const rcvdRatio    = row.bytes_rcvd / totalForRatio;

            try {
              const l7 = await client.getHostL7Stats(h.ip);
              if (Array.isArray(l7) && l7.length > 0) {
                const sortedApps = [...l7]
                  .filter((a) => (a.value ?? 0) > 0)
                  .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

                if (sortedApps.length > 0 && row) {
                  row.top_app = sortedApps[0].label || sortedApps[0].name;
                }

                for (const app of l7) {
                  const appName  = app.label || app.name || "Unknown";
                  const appTotal = app.value ?? 0;
                  if (appName === "Other" && appTotal === 0) continue;

                  const appSent = app.sent != null ? app.sent : Math.round(appTotal * sentRatio);
                  const appRcvd = app.rcvd != null ? app.rcvd : Math.round(appTotal * rcvdRatio);

                  hostAppRows.push({
                    ts,
                    ip:           h.ip,
                    vlan:         resolveVlan(h),
                    app_name:     appName,
                    bytes:        appTotal,
                    bytes_sent:   appSent,
                    bytes_rcvd:   appRcvd,
                    flows:        app.count ?? 0,
                    duration_sec: app.duration ?? row.duration_sec,
                  });
                }
              }
            } catch (e) {
              // Ignore individual host L7 errors
            }
          })
        );

        // Inter-batch delay — spread the load across time
        if (i + BATCH_SIZE < hostsForL7.length) {
          await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
        }
      }

      if (hostRows.length)    db.insertHostSnapshots(hostRows);
      if (hostAppRows.length) db.insertHostAppSnapshots(hostAppRows);

      // Interface-wide app breakdown — insert ONCE (not once per VLAN, since it's shared data)
      const appRows = ifaceL7List.map(a => ({
        ts,
        vlan:     vlans[0], // tag with primary VLAN; it's interface-wide, not per-VLAN
        app_name: a.label || a.name || "Unknown",
        bytes:    a.value ?? a.count ?? 0,
        flows:    a.count ?? 0,
      }));
      if (appRows.length) db.insertAppSnapshots(appRows);

      // Alerts
      const alertRows = (alerts || []).map((a) => ({
        ts,
        ntopng_row_id: a.row_id || `${ts}-${a.alert_name}`,
        severity:      a.severity    || "info",
        alert_name:    a.alert_name  || "Alert",
        description:   a.description || "",
      }));
      if (alertRows.length) db.insertAlerts(alertRows);

      // Automatic retention pruning
      db.prune(retentionDays);

      // Build per-vlan host count summary for logging
      const vlanCounts = {};
      for (const vlan of vlans) vlanCounts[vlan] = 0;
      for (const r of hostRows) {
        if (vlanCounts[r.vlan] !== undefined) vlanCounts[r.vlan]++;
        else vlanCounts[r.vlan] = 1;
      }
      const summary = Object.entries(vlanCounts).map(([v, c]) => `VLAN${v}:${c}`).join(" ");
      log(`[poller] snapshot ok @ ${new Date(ts * 1000).toLocaleTimeString()} — ${hosts.length} hosts (${summary}), L7-enriched: ${hostsForL7.length}/${hosts.length}, ${hostAppRows.length} app rows, ${alertRows.length} alerts`);
    } catch (err) {
      const cause  = err.cause;
      const detail = cause
        ? `${cause.code || cause.name || "network error"}: ${cause.message}`
        : err.message;
      log(`[poller] ERROR @ ${new Date(ts * 1000).toLocaleTimeString()}: ${detail}`);
    } finally {
      isPolling = false;
    }
  }

  pollOnce();
  const handle = setInterval(pollOnce, intervalSeconds * 1000);

  return () => clearInterval(handle);
}

module.exports = { startPoller };
