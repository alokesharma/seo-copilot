import { json, params } from "./_lib.js";

// Live per-URL keyword matrix from GSC: top 30 keywords with clicks + India
// position PER MONTH across the selected period. Fetched on drawer-open,
// cached in-isolate (GSC data changes daily at most).
let tokenCache = { at: null, exp: 0 };
const matrixCache = new Map();

async function accessToken(env) {
  if (tokenCache.at && Date.now() < tokenCache.exp - 60000) return tokenCache.at;
  const body = new URLSearchParams({
    client_id: env.GSC_CLIENT_ID, client_secret: env.GSC_CLIENT_SECRET,
    refresh_token: env.GSC_REFRESH_TOKEN, grant_type: "refresh_token",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body });
  const d = await r.json();
  if (!d.access_token) throw new Error("GSC token refresh failed");
  tokenCache = { at: d.access_token, exp: Date.now() + (d.expires_in || 3500) * 1000 };
  return tokenCache.at;
}

export async function onRequestGet({ env, request }) {
  const p = params(request);
  if (!p.url) return json({ error: "Missing url" }, 400);
  if (!env.GSC_CLIENT_ID) return json({ error: "GSC credentials not configured" }, 400);
  const from = p.from || "2026-01-01", to = p.to || new Date().toISOString().slice(0, 10);
  const key = `${p.url}|${from}|${to}`;
  if (matrixCache.has(key)) return json(matrixCache.get(key));

  // month list within [from, to]
  const months = [];
  let d = new Date(from.slice(0, 7) + "-01T12:00:00Z");
  const end = new Date(to + "T12:00:00Z");
  while (d <= end) {
    const m = d.toISOString().slice(0, 7);
    const mStart = m + "-01";
    const mEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    months.push({ m, start: mStart < from ? from : mStart, end: mEnd > to ? to : mEnd });
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 12));
  }

  const at = await accessToken(env);
  const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent("${SITE}/")}/searchAnalytics/query`;
  const perMonth = await Promise.all(months.map(async (mo) => {
    const r = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: "Bearer " + at, "Content-Type": "application/json" },
      body: JSON.stringify({
        startDate: mo.start, endDate: mo.end, dimensions: ["query"], rowLimit: 100,
        dimensionFilterGroups: [{ filters: [{ dimension: "page", operator: "equals", expression: p.url }] }],
      }),
    });
    const dd = await r.json();
    return { m: mo.m, rows: dd.rows || [] };
  }));

  // aggregate -> top 30 by total clicks, matrix cells {clicks, position}
  const agg = new Map();
  for (const mo of perMonth) for (const row of mo.rows) {
    const q = row.keys[0];
    if (!agg.has(q)) agg.set(q, { query: q, total: 0, months: {} });
    const a = agg.get(q);
    a.total += row.clicks || 0;
    a.months[mo.m] = { clicks: row.clicks || 0, position: row.position || 0 };
  }
  const top = [...agg.values()].sort((a, b) => b.total - a.total).slice(0, 30);
  // projection meta for the in-progress latest month (run-rate off `to`)
  const last = months[months.length - 1];
  const toD = new Date(to + "T12:00:00Z");
  const daysInMonth = new Date(Date.UTC(toD.getUTCFullYear(), toD.getUTCMonth() + 1, 0)).getUTCDate();
  const projection = last && last.m === to.slice(0, 7) && toD.getUTCDate() < daysInMonth
    ? { m: last.m, daysElapsed: toD.getUTCDate(), daysInMonth } : null;
  const out = { url: p.url, months: months.map((x) => x.m), rows: top, projection };
  matrixCache.set(key, out);
  return json(out);
}
