import { json, periodClause, params, chunk } from "./_lib.js";

// Top keywords with monthly sparkline + decay.
// GSC queries are site-wide, so for a SEGMENT we derive the keyword set from
// url_keywords (page×query) filtered by URL prefix, then join query_daily trends.
export async function onRequestGet({ env, request }) {
  const p = params(request);
  const per = periodClause(p.from, p.to);

  let totals;
  if (p.segment && p.segment !== "ALL") {
    totals = await env.DB.prepare(
      `SELECT query, SUM(clicks) AS clicks, SUM(impressions) AS impressions,
              CASE WHEN SUM(impressions)>0 THEN 1.0*SUM(clicks)/SUM(impressions) ELSE 0 END AS ctr,
              CASE WHEN SUM(impressions)>0 THEN SUM(position_in*impressions)/SUM(impressions) ELSE 0 END AS position
         FROM url_keywords WHERE url LIKE ?
        GROUP BY query ORDER BY clicks DESC LIMIT 300`
    ).bind(`${SITE}${p.segment}%`).all();
  } else {
    totals = await env.DB.prepare(
      `SELECT query, SUM(clicks) AS clicks, SUM(impressions) AS impressions,
              CASE WHEN SUM(impressions)>0 THEN 1.0*SUM(clicks)/SUM(impressions) ELSE 0 END AS ctr,
              CASE WHEN SUM(impressions)>0 THEN SUM(position_in*impressions)/SUM(impressions) ELSE 0 END AS position
         FROM query_daily WHERE 1=1${per.sql}
        GROUP BY query ORDER BY clicks DESC LIMIT 300`
    ).bind(...per.args).all();
  }

  const qs = totals.results.map((r) => r.query);
  if (!qs.length) return json({ ...p, rows: [] });

  // Monthly trend per query — chunked, parallel.
  const chunks = await Promise.all(chunk(qs).map((grp) => {
    const ph = grp.map(() => "?").join(",");
    return env.DB.prepare(
      `SELECT query, substr(date,1,7) AS m, SUM(clicks) AS c
         FROM query_daily WHERE query IN (${ph})${per.sql} GROUP BY query, m`
    ).bind(...grp, ...per.args).all();
  }));
  const monthly = chunks.flatMap((r) => r.results);

  const months = [...new Set(monthly.map((r) => r.m))].sort();
  const idx = new Map(months.map((m, i) => [m, i]));
  const byQ = new Map(qs.map((q) => [q, new Array(months.length).fill(0)]));
  for (const r of monthly) if (byQ.has(r.query)) byQ.get(r.query)[idx.get(r.m)] = r.c;

  const rows = totals.results.map((t) => {
    const spark = byQ.get(t.query) || [];
    return { ...t, spark, decayPct: decay(spark) };
  });
  return json({ ...p, rows });
}
function decay(y) {
  const n = y.length; if (n < 6) return 0;
  const r = y.slice(n - 3).reduce((a, b) => a + b, 0);
  const pr = y.slice(n - 6, n - 3).reduce((a, b) => a + b, 0);
  if (pr === 0) return r > 0 ? 100 : 0;
  return Math.round(((r - pr) / pr) * 100);
}
