import { json } from "./_lib.js";

// "Ask the data" — Gemini turns a question into read-only SQL over D1,
// we run it, then Gemini explains the result. Two cheap flash calls.
const SCHEMA = `
Table gsc_daily(date TEXT 'YYYY-MM-DD', url TEXT, segment TEXT e.g. '/car-insurance/',
  clicks INT, impressions INT, ctr REAL 0..1, position REAL global, position_in REAL India position).
Table gsc_monthly(month TEXT 'YYYY-MM', url, segment, clicks, impressions, pos_w) -- pos_w/impressions = India position; PREFER this for month-level questions (much faster).
Table query_daily(date, query TEXT keyword, clicks, impressions, ctr, position_in).
Table url_keywords(url, query, clicks, impressions, ctr, position_in) -- keyword-page map, last 90d.
Table page_content_changes(url, tracked_since TEXT date, last_changed TEXT date or NULL, changes_in_window INT)
  -- last_changed = VERIFIED last body edit; NULL = no edit detected in ~16 months. THE ONLY valid freshness source.
Notes: weighted avg India position = SUM(position_in*impressions)/SUM(impressions).
CTR over a range = SUM(clicks)/SUM(impressions). Latest data ~3 days behind today. SQLite.`;

export async function onRequestPost({ env, request }) {
  const key = env.GEMINI_API_KEY;
  if (!key) return json({ error: "GEMINI_API_KEY not set" }, 400);
  const model = env.GEMINI_MODEL || "gemini-3.5-flash";

  const { question, from, to, segment } = await request.json().catch(() => ({}));
  if (!question) return json({ error: "Missing question" }, 400);

  // Scope precedence: explicit dates/sections IN THE QUESTION win; else dropdowns apply.
  const segNote = segment && segment !== "ALL"
    ? `The dashboard segment filter is '${segment}'. Unless the question names a different section, filter to segment='${segment}' (or url LIKE '${SITE}${segment}%').`
    : "";
  const periodNote = from && to
    ? `The dashboard period is ${from} to ${to}. Unless the question gives its own timeframe, filter dates to that range. ${segNote}`
    : segNote;

  // 1) question -> SQL
  const sqlRaw = await gemini(key, model,
    `You write ONE read-only SQLite SELECT for this schema. Output only SQL, no markdown.\n${SCHEMA}\n` +
    `${periodNote}\nALWAYS SELECT the metric(s) the question mentions (e.g. if it asks about CTR, include a ctr column; ` +
    `clicks -> clicks; position -> position_in). Give columns readable aliases.\n\nQuestion: ${question}`);
  const sql = sanitize(sqlRaw);
  if (!sql) return json({ error: "Could not derive a safe query", sqlRaw }, 400);

  // 2) run it
  let rows;
  try {
    ({ results: rows } = await env.DB.prepare(sql).all());
  } catch (e) {
    return json({ error: "Query failed: " + e.message, sql }, 400);
  }

  // 3) rows -> natural-language answer
  const answer = await gemini(key, model,
    `Question: ${question}\nSQL: ${sql}\nRows (JSON): ${JSON.stringify(rows.slice(0, 50))}\n` +
    `Answer the question for a content team in 2-4 sentences. Be specific with numbers. No preamble.`);

  const scope = `segment ${segment || "ALL"} · ${from || "?"} → ${to || "?"}`;
  return json({ question, sql, rows, answer, scope });
}

async function gemini(key, model, prompt) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    }
  );
  const d = await r.json();
  return d?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
}

// Only allow a single SELECT/WITH; block anything that writes.
function sanitize(raw) {
  let s = raw.replace(/```sql/gi, "").replace(/```/g, "").trim();
  if (s.endsWith(";")) s = s.slice(0, -1).trim();
  if (s.includes(";")) return null; // no stacked statements
  const low = s.toLowerCase();
  if (!/^(select|with)\b/.test(low)) return null;
  if (/\b(insert|update|delete|drop|alter|attach|pragma|create|replace)\b/.test(low)) return null;
  if (!/\blimit\b/.test(low)) s += " LIMIT 200";
  return s;
}
