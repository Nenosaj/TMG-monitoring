/**
 * Native fetch client for ntopng REST API v2.
 * Reference: https://www.ntop.org/guides/ntopng/api/rest/api_v2.html
 */
function makeClient({ baseUrl, user, pass, ifid }) {
  const cleanBaseUrl = (baseUrl || "").replace(/\/+$/, "");
  const authHeader = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

  async function request(endpoint, params = {}) {
    const url = new URL(endpoint, cleanBaseUrl);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
    const res = await fetch(url.toString(), {
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      // Return null / empty for 404s gracefully
      if (res.status === 404) return { rc: -1, rsp: [] };
      throw new Error(`ntopng ${endpoint} returned HTTP ${res.status} ${res.statusText}`);
    }
    return await res.json();
  }

  return {
    async getInterfaceData() {
      const data = await request("/lua/rest/v2/get/interface/data.lua", { ifid });
      return data?.rsp || {};
    },

    async getActiveHosts({ perPage = 100 } = {}) {
      let page = 1;
      let all = [];
      for (let i = 0; i < 20; i++) {
        const data = await request("/lua/rest/v2/get/host/active.lua", {
          ifid,
          perPage,
          currentPage: page,
        });
        const rows = data?.rsp?.data || [];
        all = all.concat(rows);
        const total = data?.rsp?.totalRows ?? 0;
        if (rows.length === 0 || (total > 0 && all.length >= total)) break;
        page += 1;
      }
      return all;
    },

    async getHostL7Stats(hostIp) {
      if (!hostIp) return [];
      const data = await request("/lua/rest/v2/get/host/l7/stats.lua", {
        ifid,
        host: hostIp,
      });
      return data?.rsp || [];
    },

    async getHostDetails(hostIp) {
      if (!hostIp) return null;
      const data = await request("/lua/rest/v2/get/host/data.lua", {
        ifid,
        host: hostIp,
      });
      return data?.rsp || null;
    },

    async getInterfaceL7Stats() {
      const data = await request("/lua/rest/v2/get/interface/l7/stats.lua", {
        ifid,
        ndpistats_mode: "count",
      });
      return data?.rsp || [];
    },

    async getAlertList() {
      try {
        const data = await request("/lua/rest/v2/get/interface/alert/list.lua", { ifid });
        return data?.rsp?.records || data?.rsp?.data || [];
      } catch (err) {
        try {
          const res = await fetch(`${cleanBaseUrl}/lua/rest/v2/get/interface/alert/list.lua`, {
            method: "POST",
            headers: {
              Authorization: authHeader,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ ifid }),
            signal: AbortSignal.timeout(8000),
          });
          const postData = await res.json();
          return postData?.rsp?.records || [];
        } catch {
          return [];
        }
      }
    },
  };
}

module.exports = { makeClient };
