const db = require("./db");

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function startPoller({ client, vlan = 70, intervalSeconds = 30, retentionDays = 30, log = console.log }) {
  let isPolling = false;

  async function pollOnce() {
    if (isPolling) {
      log(`[poller] previous cycle still running, skipping...`);
      return;
    }
    isPolling = true;
    const ts = nowTs();

    try {
      // 1. Interface throughput data
      const ifaceData = await client.getInterfaceData();

      // 2. Active hosts (filter to VLAN 70 or 192.168.70.x)
      const allHosts = await client.getActiveHosts();
      const hosts = (allHosts || []).filter((h) => {
        const hVlan = Number(h.vlan);
        const isVlanMatch = hVlan === Number(vlan);
        const isSubnetMatch = typeof h.ip === "string" && h.ip.startsWith("192.168.70.");
        return isVlanMatch || isSubnetMatch;
      });

      // 3. Interface-wide L7 stats (supports array, { labels, series }, or key-value object)
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

      // 4. Alerts
      let alerts = [];
      try {
        const rawAlerts = await client.getAlertList();
        alerts = (rawAlerts || []).map((a) => ({
          row_id: a.row_id || a.id,
          severity: (a.severity?.label || a.severity || "info").replace(/<[^>]+>/g, "").trim(),
          alert_name: (a.alert_name || a.title || "Alert").replace(/<[^>]+>/g, "").trim(),
          description: (a.msg?.description || a.description || a.msg || "").replace(/<[^>]+>/g, "").trim(),
        }));
      } catch (e) {
        // Non-fatal
      }

      // Insert interface snapshot
      db.insertInterfaceSnapshot({
        ts,
        bps_down: ifaceData?.throughput?.download?.bps ?? 0,
        bps_up: ifaceData?.throughput?.upload?.bps ?? 0,
        pps_down: ifaceData?.throughput?.download?.pps ?? 0,
        pps_up: ifaceData?.throughput?.upload?.pps ?? 0,
        bytes_total: ifaceData?.bytes ?? 0,
        num_hosts: hosts.length,
        num_flows: ifaceData?.num_flows ?? 0,
      });

      // Per-host snapshots & per-host app snapshots
      const hostRows = [];
      const hostAppRows = [];

      // Query L7 stats in parallel batches of 4 (gentle on ntopng web server)
      const BATCH_SIZE = 4;
      for (let i = 0; i < hosts.length; i += BATCH_SIZE) {
        const batch = hosts.slice(i, i + BATCH_SIZE);
        await Promise.all(
          batch.map(async (h) => {
            let topApp = null;
            let hostDuration = (h.last_seen && h.first_seen) ? (h.last_seen - h.first_seen) : 0;
            
            try {
              const l7 = await client.getHostL7Stats(h.ip);
              if (Array.isArray(l7) && l7.length > 0) {
                const sortedApps = [...l7]
                  .filter((a) => (a.value ?? 0) > 0)
                  .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

                if (sortedApps.length > 0) {
                  topApp = sortedApps[0].label || sortedApps[0].name;
                }

                for (const app of l7) {
                  const appName = app.label || app.name || "Unknown";
                  if (appName === "Other" && (app.value ?? 0) === 0) continue;
                  hostAppRows.push({
                    ts,
                    ip: h.ip,
                    vlan: Number(h.vlan ?? vlan),
                    app_name: appName,
                    bytes: app.value ?? (app.sent + app.rcvd) ?? 0,
                    bytes_sent: app.sent ?? 0,
                    bytes_rcvd: app.rcvd ?? 0,
                    flows: app.count ?? 0,
                    duration_sec: app.duration ?? hostDuration,
                  });
                }
              }
            } catch (e) {
              // Ignore individual host L7 errors
            }

            const bytesSent = h.bytes?.sent ?? 0;
            const bytesRcvd = h.bytes?.received ?? h.bytes?.rcvd ?? 0;
            const bytesTotal = h.bytes?.total ?? (bytesSent + bytesRcvd);
            const bps = h.thpt?.bps ?? h.throughput_bps ?? 0;
            const pps = h.thpt?.pps ?? h.throughput_pps ?? 0;
            const numFlows = h.num_flows?.total ?? h.num_flows ?? 0;

            hostRows.push({
              ts,
              ip: h.ip,
              name: h.name || h.ip,
              mac: h.mac || "",
              vlan: Number(h.vlan ?? vlan),
              bytes_sent: bytesSent,
              bytes_rcvd: bytesRcvd,
              bytes_total: bytesTotal,
              bps,
              pps,
              num_flows: numFlows,
              top_app: topApp,
              duration_sec: hostDuration,
              first_seen: h.first_seen ?? h.seen?.first,
              last_seen: h.last_seen ?? h.seen?.last,
            });
          })
        );
      }

      if (hostRows.length) db.insertHostSnapshots(hostRows);
      if (hostAppRows.length) db.insertHostAppSnapshots(hostAppRows);

      // Interface-wide app breakdown
      const appRows = (ifaceL7List || []).map((a) => ({
        ts,
        vlan,
        app_name: a.label || a.name || "Unknown",
        bytes: a.value ?? a.count ?? 0,
        flows: a.count ?? 0,
      }));
      if (appRows.length) db.insertAppSnapshots(appRows);

      // Alerts
      const alertRows = (alerts || []).map((a) => ({
        ts,
        ntopng_row_id: a.row_id || `${ts}-${a.alert_name}`,
        severity: a.severity || "info",
        alert_name: a.alert_name || "Alert",
        description: a.description || "",
      }));
      if (alertRows.length) db.insertAlerts(alertRows);

      // Automatic retention pruning
      db.prune(retentionDays);

      log(`[poller] snapshot ok @ ${new Date(ts * 1000).toLocaleTimeString()} — ${hosts.length} VLAN 70 hosts, ${hostAppRows.length} host-app rows, ${appRows.length} iface-apps, ${alertRows.length} alerts`);
    } catch (err) {
      const cause = err.cause;
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
