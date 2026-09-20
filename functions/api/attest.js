import { json } from "./_lib.js";

// Owner attestation: the content team is first-party ground truth for pages no
// crawler could see before an edit. Records "we updated this page on <date>" —
// labeled as team-confirmed, protected from ingest overwrites (merge rule).
export async function onRequestPost({ env, request }) {
  const { url, date } = await request.json().catch(() => ({}));
  if (!url || !date) return json({ error: "Missing url or date" }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Date must be YYYY-MM-DD" }, 400);
  const d = Date.parse(date);
  if (isNaN(d) || d > Date.now() || d < Date.parse("2024-01-01")) return json({ error: "Date out of range" }, 400);

  const norm = url.trim().replace(/\/?$/, "/");
  const row = await env.DB.prepare(`SELECT url FROM page_content_changes WHERE url = ?`).bind(norm).first();
  if (!row) return json({ error: "URL not tracked (must exist in the freshness table)" }, 404);

  await env.DB.prepare(
    `UPDATE page_content_changes SET last_changed = ?, date_precision = 'attested' WHERE url = ?`
  ).bind(date, norm).run();
  return json({ ok: true, url: norm, date });
}
