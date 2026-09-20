import { json, params } from "./_lib.js";

// Keywords for a single URL (weekly snapshot), enriched so the drawer can group
// them into action buckets: striking-distance, CTR-underperformers, questions,
// cannibalisation (shared with other the site URLs).
export async function onRequestGet({ env, request }) {
  const p = params(request);
  if (!p.url) return json({ error: "Missing url" }, 400);
  const { results } = await env.DB.prepare(
    `SELECT k.query, k.clicks, k.impressions, k.ctr, k.position_in AS position,
            (SELECT COUNT(DISTINCT url) FROM url_keywords k2 WHERE k2.query = k.query AND k2.url <> k.url) AS also
       FROM url_keywords k WHERE k.url = ? ORDER BY k.clicks DESC LIMIT 200`
  ).bind(p.url).all();
  return json({ url: p.url, rows: results });
}
