import { json, params } from "./_lib.js";

// Freshness preset questions. Canned = hardcoded SQL (instant, deterministic,
// always correct). Custom free-text goes through Gemini text-to-SQL (POST).
const SEG = (p) => (p.segment && p.segment !== "ALL" ? `${SITE}${p.segment}%` : "%");

const PRESETS = {
  refresh_first: {
    label: "Which pages should we refresh first?",
    hint: "biggest real traffic loss + not updated in 3+ months",
    sql: `SELECT c.url, w.clicks_90d, MAX(0, w.clicks_prev90 - w.clicks_90d) clicks_lost,
                 COALESCE(c.last_changed,'>16 mo ago') last_updated
            FROM page_content_changes c JOIN url_windows w ON w.url = c.url
            LEFT JOIN url_first_seen fs ON fs.url = c.url
           WHERE c.url LIKE ?1 AND COALESCE(fs.first_seen,'2000-01-01') < date('now','-90 day') AND (c.last_changed IS NULL OR c.last_changed < date('now','-90 day'))
             AND w.clicks_prev90 > w.clicks_90d
           ORDER BY clicks_lost DESC LIMIT 25`,
  },
  stale6_traffic: {
    label: "Traffic pages not updated in 6+ months",
    hint: "still earning clicks, long overdue",
    sql: `SELECT c.url, w.clicks_90d, COALESCE(c.last_changed,'>16 mo ago') last_updated
            FROM page_content_changes c JOIN url_windows w ON w.url = c.url
            LEFT JOIN url_first_seen fs ON fs.url = c.url
           WHERE c.url LIKE ?1 AND COALESCE(fs.first_seen,'2000-01-01') < date('now','-90 day') AND w.clicks_90d > 500
             AND (c.last_changed IS NULL OR c.last_changed < date('now','-180 day'))
           ORDER BY w.clicks_90d DESC LIMIT 25`,
  },
  never_updated: {
    label: "Never updated in 16 months",
    hint: "no content change across our whole tracking window",
    sql: `SELECT c.url, w.clicks_90d
            FROM page_content_changes c JOIN url_windows w ON w.url = c.url
            LEFT JOIN url_first_seen fs ON fs.url = c.url
           WHERE c.url LIKE ?1 AND COALESCE(fs.first_seen,'2000-01-01') < date('now','-90 day') AND c.last_changed IS NULL AND c.tracked_since < date('now','-400 day')
           ORDER BY w.clicks_90d DESC LIMIT 25`,
  },
  refresh_roi: {
    label: "Did our recent refreshes work?",
    hint: "clicks 3 weeks after an update vs 3 weeks before",
    sql: `SELECT c.url, c.last_changed updated_on,
                 COALESCE(bef.k,0) clicks_before, COALESCE(aft.k,0) clicks_after,
                 COALESCE(aft.k,0)-COALESCE(bef.k,0) delta
            FROM page_content_changes c
            LEFT JOIN (SELECT g.url u, SUM(g.clicks) k FROM gsc_daily g JOIN page_content_changes p ON p.url=g.url
                        WHERE g.date >= date(p.last_changed,'-21 day') AND g.date < p.last_changed GROUP BY g.url) bef ON bef.u=c.url
            LEFT JOIN (SELECT g.url u, SUM(g.clicks) k FROM gsc_daily g JOIN page_content_changes p ON p.url=g.url
                        WHERE g.date > p.last_changed AND g.date <= date(p.last_changed,'+21 day') GROUP BY g.url) aft ON aft.u=c.url
           WHERE c.url LIKE ?1 AND c.last_changed BETWEEN date('now','-90 day') AND date('now','-21 day')
             AND COALESCE(bef.k,0)+COALESCE(aft.k,0) > 100
           ORDER BY delta ASC LIMIT 25`,
  },
  update_resistant: {
    label: "Updated often but still declining",
    hint: "refreshes aren't working — likely needs a rewrite",
    sql: `SELECT c.url, c.changes_in_window updates_tracked, w.clicks_90d,
                 w.clicks_prev90 - w.clicks_90d clicks_lost
            FROM page_content_changes c JOIN url_windows w ON w.url = c.url
           WHERE c.url LIKE ?1 AND c.changes_in_window >= 2
             AND w.clicks_prev90 > w.clicks_90d*1.2 AND w.clicks_prev90 > 300
           ORDER BY clicks_lost DESC LIMIT 25`,
  },
  stale_striking: {
    label: "Stale pages ranking 4–10",
    hint: "striking distance + stale = fastest wins from a refresh",
    sql: `SELECT c.url, ROUND(w.pos_w_90d/w.impressions_90d,1) position_india,
                 w.impressions_90d, COALESCE(c.last_changed,'>16 mo ago') last_updated
            FROM page_content_changes c JOIN url_windows w ON w.url = c.url
           WHERE c.url LIKE ?1 AND w.impressions_90d > 2000
             AND w.pos_w_90d/w.impressions_90d BETWEEN 4 AND 10
             AND (c.last_changed IS NULL OR c.last_changed < date('now','-90 day'))
           ORDER BY w.impressions_90d DESC LIMIT 25`,
  },
  stalest_segment: {
    label: "Which section has the stalest content?",
    hint: "stale-page counts and traffic at stake per folder",
    sql: `SELECT w.segment, COUNT(*) stale_pages, SUM(w.clicks_90d) clicks_90d_at_stake
            FROM page_content_changes c JOIN url_windows w ON w.url = c.url
           WHERE (c.last_changed IS NULL OR c.last_changed < date('now','-180 day')) AND w.clicks_90d > 50
           GROUP BY w.segment ORDER BY clicks_90d_at_stake DESC LIMIT 20`,
  },
};

export async function onRequestGet({ env, request }) {
  const p = params(request);
  const u = new URL(request.url);
  const id = u.searchParams.get("id");
  if (!id) return json({ presets: Object.entries(PRESETS).map(([k, v]) => ({ id: k, label: v.label, hint: v.hint })) });
  const preset = PRESETS[id];
  if (!preset) return json({ error: "Unknown preset" }, 400);
  const stmt = env.DB.prepare(preset.sql);
  const { results } = await (preset.sql.includes("?1") ? stmt.bind(SEG(p)) : stmt).all();
  return json({ id, label: preset.label, rows: results });
}

// Custom free-text question -> Gemini text-to-SQL over the freshness schema.
const SCHEMA = `
Table page_content_changes(url TEXT, tracked_since TEXT date, last_changed TEXT date or NULL
 (NULL = no body change detected in ~16 months), changes_in_window INT, last_word_count INT).
Table gsc_daily(date TEXT 'YYYY-MM-DD', url TEXT, segment TEXT like '/car-insurance/',
 clicks INT, impressions INT, ctr REAL 0..1, position_in REAL = India avg position).
Join on url. This is SQLite. Latest data ~3 days behind today.`;

export async function onRequestPost({ env, request }) {
  if (!env.GEMINI_API_KEY) return json({ error: "GEMINI_API_KEY not set" }, 400);
  const { question, segment } = await request.json().catch(() => ({}));
  if (!question) return json({ error: "Missing question" }, 400);
  const segNote = segment && segment !== "ALL" ? `Restrict to urls LIKE '${SITE}${segment}%'.` : "";
  const model = env.GEMINI_MODEL || "gemini-3.5-flash";

  const raw = await gemini(env.GEMINI_API_KEY, model,
    `Write ONE read-only SQLite SELECT. Output only SQL.\n${SCHEMA}\n${segNote}\nQuestion: ${question}`);
  const sql = sanitize(raw);
  if (!sql) return json({ error: "Could not derive a safe query" }, 400);
  let rows;
  try { ({ results: rows } = await env.DB.prepare(sql).all()); }
  catch (e) { return json({ error: "Query failed: " + e.message, sql }, 400); }
  const answer = await gemini(env.GEMINI_API_KEY, model,
    `Q: ${question}\nRows: ${JSON.stringify(rows.slice(0, 40))}\nAnswer for a content team in 2-3 sentences with specific numbers. No preamble.`);
  return json({ question, rows, answer });
}

async function gemini(key, model, prompt) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) });
  const d = await r.json();
  return d?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
}
function sanitize(raw) {
  let s = raw.replace(/```sql/gi, "").replace(/```/g, "").trim();
  if (s.endsWith(";")) s = s.slice(0, -1).trim();
  if (s.includes(";")) return null;
  if (!/^(select|with)\b/i.test(s)) return null;
  if (/\b(insert|update|delete|drop|alter|attach|pragma|create|replace)\b/i.test(s)) return null;
  if (!/\blimit\b/i.test(s)) s += " LIMIT 100";
  return s;
}
