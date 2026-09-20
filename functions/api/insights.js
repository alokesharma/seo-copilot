import { json, segmentClause, params } from "./_lib.js";

// Rule-based anomaly detection. Compares last 90d vs prior 90d (India position).
// Surfaces "what to act on"; per-item SERP+Gemini diagnosis is /api/insight-analyze.
export async function onRequestGet({ env, request }) {
  const p = params(request);
  const seg = segmentClause(p.segment);

  const agg = (fromExpr, toExpr) => env.DB.prepare(
    `SELECT url, segment, SUM(clicks) c, SUM(impressions) i,
            CASE WHEN SUM(impressions)>0 THEN 1.0*SUM(clicks)/SUM(impressions) ELSE 0 END ctr,
            CASE WHEN SUM(impressions)>0 THEN SUM(position_in*impressions)/SUM(impressions) ELSE 0 END pos
       FROM gsc_daily
      WHERE date >= ${fromExpr} AND date < ${toExpr}${seg.sql}
      GROUP BY url`
  ).bind(...seg.args).all();

  const [recent, prior, kw, cannib] = await Promise.all([
    agg("date('now','-90 day')", "date('now','+1 day')"),
    agg("date('now','-180 day')", "date('now','-90 day')"),
    env.DB.prepare(`SELECT url, query FROM (
                      SELECT url, query, ROW_NUMBER() OVER (PARTITION BY url ORDER BY clicks DESC) rn
                        FROM url_keywords
                    ) WHERE rn = 1`).all(),
    env.DB.prepare(`SELECT query, COUNT(DISTINCT url) n FROM url_keywords GROUP BY query HAVING n > 1`).all(),
  ]);

  const prev = new Map(prior.results.map((r) => [r.url, r]));
  const mainKw = new Map(kw.results.map((r) => [r.url, r.query]));
  const cannibQ = new Set(cannib.results.map((r) => r.query));
  const out = [];
  const push = (g, type, severity, reason) =>
    out.push({ url: g.url, query: mainKw.get(g.url) || "", clicks: g.c, impressions: g.i, ctr: g.ctr, position: g.pos, type, severity, reason });

  for (const g of recent.results) {
    if (g.i < 500) continue;
    const pr = prev.get(g.url);
    if (g.pos <= 3.5 && g.ctr < 0.03)
      push(g, "ctr_gap", g.i * (0.03 - g.ctr), `Ranks #${g.pos.toFixed(1)} in India but CTR is only ${(g.ctr * 100).toFixed(1)}%.`);
    if (g.pos >= 6 && g.pos <= 15 && g.i > 3000)
      push(g, "striking_distance", g.i / g.pos, `Position ${g.pos.toFixed(1)} with ${fmt(g.i)} impressions — close to page 1.`);
    if (pr && pr.c > 0 && (g.c - pr.c) / pr.c < -0.3 && g.c > 50)
      push(g, "decay", pr.c - g.c, `Clicks fell ${Math.round((1 - g.c / pr.c) * 100)}% vs the prior 90 days (${fmt(pr.c)}→${fmt(g.c)}).`);
    if (pr && pr.pos > 0 && pr.pos <= 10 && g.pos > 10 && g.i > 1000)
      push(g, "lost_positions", g.i, `Dropped off page 1 (India pos ${pr.pos.toFixed(1)}→${g.pos.toFixed(1)}).`);
    if (mainKw.get(g.url) && cannibQ.has(mainKw.get(g.url)))
      push(g, "cannibalization", g.i, `Its top keyword "${mainKw.get(g.url)}" also ranks on other the site pages.`);
  }
  out.sort((a, b) => b.severity - a.severity);

  const byType = {};
  for (const x of out) byType[x.type] = (byType[x.type] || 0) + 1;
  return json({ segment: p.segment, count: out.length, byType, insights: out.slice(0, 200) });
}
const fmt = (n) => (n || 0).toLocaleString("en-IN");
