// Lazy auto-refresh: on any dashboard load, if the warehouse is older than GSC's
// newest available day (today-3), pull ONLY the missing days in the background
// (dual pull: global metrics + India position), update rollups incrementally,
// and the next reload shows fresh data. Lock prevents duplicate pulls.
const esc = (s) => String(s).replace(/'/g, "''");
const segOf = (url) => {
  try { const p = new URL(url).pathname.split("/").filter(Boolean); return p.length ? `/${p[0]}/` : "/"; }
  catch { return "/"; }
};

export function maybeRefresh(ctx) {
  ctx.waitUntil((async () => {
    const { env } = ctx;
    try {
      if (!env.GSC_CLIENT_ID) return;
      const max = (await env.DB.prepare(`SELECT value FROM meta WHERE key='max_data_date'`).first())?.value;
      const target = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
      if (!max || max >= target) return;
      const lock = await env.DB.prepare(`SELECT value FROM meta WHERE key='refresh_lock'`).first();
      if (lock?.value && Date.now() - Date.parse(lock.value) < 10 * 60 * 1000) return;
      await env.DB.prepare(`INSERT OR REPLACE INTO meta(key,value) VALUES('refresh_lock',?)`).bind(new Date().toISOString()).run();
      try { await ingestMissing(env, max, target); }
      finally { await env.DB.prepare(`DELETE FROM meta WHERE key='refresh_lock'`).run(); }
    } catch (e) { console.log("auto-refresh failed:", e.message); }
  })());
}

async function token(env) {
  const body = new URLSearchParams({
    client_id: env.GSC_CLIENT_ID, client_secret: env.GSC_CLIENT_SECRET,
    refresh_token: env.GSC_REFRESH_TOKEN, grant_type: "refresh_token",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body });
  const d = await r.json();
  if (!d.access_token) throw new Error("GSC token refresh failed");
  return d.access_token;
}

async function gscDay(at, date, country) {
  const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent("${SITE}/")}/searchAnalytics/query`;
  const rows = [];
  let startRow = 0;
  for (;;) {
    const payload = { startDate: date, endDate: date, dimensions: ["page"], rowLimit: 25000, startRow, dataState: "final" };
    if (country) payload.dimensionFilterGroups = [{ filters: [{ dimension: "country", operator: "equals", expression: country }] }];
    const r = await fetch(endpoint, { method: "POST", headers: { Authorization: "Bearer " + at, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!r.ok) throw new Error(`GSC ${r.status}`);
    const d = await r.json();
    const batch = d.rows || [];
    rows.push(...batch);
    if (batch.length < 25000) break;
    startRow += 25000;
  }
  return rows;
}

async function ingestMissing(env, maxDate, target) {
  const at = await token(env);
  const days = [];
  let d = new Date(Date.parse(maxDate) + 864e5);
  while (d.toISOString().slice(0, 10) <= target && days.length < 7) { // cap 7 days/run
    days.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + 864e5);
  }
  const touchedMonths = new Set(), touchedWeeks = new Set();
  for (const day of days) {
    const [glob, ind] = await Promise.all([gscDay(at, day, null), gscDay(at, day, "ind")]);
    if (!glob.length) continue; // GSC not final yet for this day
    const posIn = new Map(ind.map((r) => [r.keys[0], r.position]));
    // multi-row inserts, 200 rows per statement, batched
    const stmts = [];
    for (let i = 0; i < glob.length; i += 200) {
      const vals = glob.slice(i, i + 200).map((r) => {
        const u = r.keys[0];
        return `('${day}','${esc(u)}','${segOf(u)}',${r.clicks | 0},${r.impressions | 0},${(r.ctr || 0).toFixed(4)},${(r.position || 0).toFixed(1)},${(posIn.get(u) ?? r.position ?? 0).toFixed(1)})`;
      }).join(",");
      stmts.push(env.DB.prepare(`INSERT OR REPLACE INTO gsc_daily(date,url,segment,clicks,impressions,ctr,position,position_in) VALUES ${vals}`));
    }
    await env.DB.batch(stmts);
    touchedMonths.add(day.slice(0, 7));
    touchedWeeks.add(isoWeek(day));
    await env.DB.prepare(`INSERT OR REPLACE INTO meta(key,value) VALUES('max_data_date',?)`).bind(day).run();
  }
  // incremental rollups for touched buckets only
  for (const m of touchedMonths) {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM gsc_monthly WHERE month='${m}'`),
      env.DB.prepare(`INSERT INTO gsc_monthly SELECT '${m}', url, segment, SUM(clicks), SUM(impressions), SUM(position_in*impressions) FROM gsc_daily WHERE substr(date,1,7)='${m}' GROUP BY url`),
    ]);
  }
  for (const w of touchedWeeks) {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM gsc_weekly WHERE week='${w}'`),
      env.DB.prepare(`INSERT INTO gsc_weekly SELECT '${w}', url, segment, SUM(clicks), SUM(impressions), SUM(position_in*impressions) FROM gsc_daily WHERE strftime('%Y-W%W', date)='${w}' GROUP BY url`),
    ]);
  }
  // 90-day windows, first-seen, segment cache
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM url_windows`),
    env.DB.prepare(`INSERT INTO url_windows SELECT url, MAX(segment),
        SUM(CASE WHEN date >= date('now','-90 day') THEN clicks ELSE 0 END),
        SUM(CASE WHEN date >= date('now','-180 day') AND date < date('now','-90 day') THEN clicks ELSE 0 END),
        SUM(CASE WHEN date >= date('now','-90 day') THEN impressions ELSE 0 END),
        SUM(CASE WHEN date >= date('now','-90 day') THEN position_in*impressions ELSE 0 END)
      FROM gsc_daily WHERE date >= date('now','-180 day') GROUP BY url`),
    env.DB.prepare(`INSERT OR IGNORE INTO url_first_seen SELECT url, MIN(date) FROM gsc_daily WHERE date >= date('now','-10 day') GROUP BY url`),
  ]);
  const segs = await env.DB.prepare(`SELECT segment, SUM(clicks) clicks, COUNT(DISTINCT url) pages FROM gsc_monthly GROUP BY segment HAVING pages >= 5 AND segment <> '/' ORDER BY clicks DESC`).all();
  await env.DB.prepare(`INSERT OR REPLACE INTO meta(key,value) VALUES('segments_cache',?)`).bind(JSON.stringify(segs.results)).run();
}

function isoWeek(d) {
  const dt = new Date(d);
  const jan1 = new Date(dt.getFullYear(), 0, 1);
  const week = Math.floor(((dt - jan1) / 864e5 + jan1.getDay()) / 7);
  return `${dt.getFullYear()}-W${String(week).padStart(2, "0")}`;
}
