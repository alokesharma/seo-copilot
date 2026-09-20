import { json, params } from "./_lib.js";

// Fixed last-6-months monthly trend for one keyword (India position).
export async function onRequestGet({ env, request }) {
  const p = params(request);
  if (!p.query) return json({ error: "Missing query" }, 400);
  const { results } = await env.DB.prepare(
    `SELECT substr(date,1,7) AS month,
            SUM(clicks) AS clicks, SUM(impressions) AS impressions,
            CASE WHEN SUM(impressions)>0 THEN SUM(position_in*impressions)/SUM(impressions) ELSE 0 END AS position
       FROM query_daily
      WHERE query = ? AND date >= date('now','-6 month')
      GROUP BY month ORDER BY month`
  ).bind(p.query).all();
  return json({ query: p.query, months: results });
}
