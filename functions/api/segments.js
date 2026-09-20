import { json } from "./_lib.js";

// Segment list is precomputed by scripts/build-rollups.mjs into meta — instant read
// instead of a full-table GROUP BY on every dashboard load.
export async function onRequestGet({ env }) {
  const cached = await env.DB.prepare(`SELECT value FROM meta WHERE key='segments_cache'`).first();
  if (cached?.value) return json({ segments: JSON.parse(cached.value) });
  // Fallback (rollups not built yet)
  const { results } = await env.DB.prepare(
    `SELECT segment, SUM(clicks) AS clicks, COUNT(DISTINCT url) AS pages
       FROM gsc_daily GROUP BY segment HAVING pages >= 5 AND segment <> '/'
      ORDER BY clicks DESC`
  ).all();
  return json({ segments: results });
}
