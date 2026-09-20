import { json } from "./_lib.js";

// Pipeline health — one glance answers "is every data feed alive, and how fresh?"
// Derived from data the loaders already write; no new bookkeeping needed.
export async function onRequestGet({ env }) {
  const meta = {};
  const { results } = await env.DB.prepare(
    `SELECT key, value FROM meta WHERE key IN ('max_data_date','keywords_last_run','disk_free_gb')`
  ).all();
  for (const r of results) meta[r.key] = r.value;
  const sf = await env.DB.prepare(`SELECT MAX(computed_at) AS at FROM page_content_changes`).first();

  const now = Date.now();
  // Staleness is a CALENDAR-day question ("is the last fetch date < today?"), not an
  // elapsed-hours one. Flooring elapsed ms undercounts by up to a day — a pull ~46h old
  // read as age 1 and painted the CMS strip green while the data was 2 days stale and the
  // last attempt had failed. Compare UTC date parts so a 07:00->05:38 gap counts as 2.
  const dayNum = (iso) => Math.floor(Date.parse(iso.slice(0, 10) + "T00:00:00Z") / 864e5);
  const today = dayNum(new Date().toISOString());
  const ageDays = (iso) => (iso ? today - dayNum(iso) : null);
  const status = (age, warnAt, badAt) => (age == null ? "bad" : age <= warnAt ? "ok" : age <= badAt ? "warn" : "bad");

  // GSC lags ~3 days by nature -> healthy means max_data_date >= today-4.
  const gscAge = ageDays(meta.max_data_date);
  const sfAge = ageDays(sf?.at);
  const kwAge = ageDays(meta.keywords_last_run);

  return json({
    checks: [
      { id: "gsc", label: "Search Console", status: meta.max_data_date ? status(gscAge, 4, 6) : "off",
        detail: meta.max_data_date ? `data through ${meta.max_data_date}` : "not connected yet — see Setup" },
      { id: "crawl", label: "Crawl", status: sf?.at ? status(sfAge, 8, 20) : "off",
        detail: sf?.at ? `last import ${(sf.at || "").slice(0, 10)}` : "no crawl imported yet — add one in Setup" },
      { id: "keywords", label: "Keywords", status: meta.keywords_last_run ? status(kwAge, 8, 15) : "off",
        detail: meta.keywords_last_run ? `refreshed ${meta.keywords_last_run.slice(0, 10)}` : "not pulled yet" },
      { id: "disk", label: "Disk", status: meta.disk_free_gb == null ? "off" : +meta.disk_free_gb >= 20 ? "ok" : +meta.disk_free_gb >= 8 ? "warn" : "bad",
        detail: meta.disk_free_gb != null ? `${meta.disk_free_gb} GB free on the Mac` : "not reported yet" },
    ],
    at: new Date().toISOString(),
  });
}
