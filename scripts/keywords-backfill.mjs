// Keyword data into local D1:
//  - query_daily : per-day keyword trend (global clicks/impr/ctr + India position)
//  - url_keywords: top keywords per URL over the last 90 days (snapshot)
// Run AFTER backfill.mjs (and not concurrently — both write the same local D1).
//   node scripts/keywords-backfill.mjs [--days=90]
import { gscQuery } from "./lib/gsc.mjs";
import { runFile, esc, setMeta, getMeta } from "./lib/d1.mjs";
const lastRun = getMeta("keywords_last_run");
if (lastRun && (Date.now() - Date.parse(lastRun)) < 5 * 864e5) {
  console.log("Ran " + lastRun.slice(0,10) + " — skipping (weekly cadence).");
  process.exit(0);
}

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const DAYS = parseInt(args.days || "90", 10);
const iso = (d) => d.toISOString().slice(0, 10);
const segmentOf = (url) => { try { const p = new URL(url).pathname.split("/").filter(Boolean); return p.length ? `/${p[0]}/` : "/"; } catch { return "/"; } };

const end = new Date(Date.now() - 3 * 864e5);
const start = new Date(end.getTime() - DAYS * 864e5);

let buf = [], n = 0;
const flush = () => { if (buf.length) { runFile(buf.join("\n")); buf = []; } };

// 1) Keyword trend, day by day.
console.log(`query_daily ${iso(start)} -> ${iso(end)}`);
for (let day = new Date(start); day <= end; day = new Date(day.getTime() + 864e5)) {
  const d = iso(day);
  const [glob, ind] = await Promise.all([
    gscQuery({ startDate: d, endDate: d, dimensions: ["query"] }),
    gscQuery({ startDate: d, endDate: d, dimensions: ["query"], country: "ind" }),
  ]);
  const posIn = new Map(ind.map((r) => [r.keys[0], r.position]));
  for (const r of glob) {
    const q = r.keys[0];
    buf.push(`INSERT OR REPLACE INTO query_daily(date,query,segment,clicks,impressions,ctr,position_in) ` +
      `VALUES('${d}','${esc(q)}','',${r.clicks | 0},${r.impressions | 0},${(r.ctr || 0).toFixed(4)},${(posIn.get(q) ?? r.position ?? 0).toFixed(1)});`);
    n++;
  }
  if (buf.length >= 6000) flush();
  process.stdout.write(`  ${d}  ${glob.length} queries\n`);
}
flush();

// 2) Per-URL keywords, single 90-day window.
console.log("url_keywords (page × query, 90d)…");
runFile("DELETE FROM url_keywords;"); // snapshot table — clear stale queries so it can't accumulate (grew 54k→430k)
const [pg, pgIn] = await Promise.all([
  gscQuery({ startDate: iso(start), endDate: iso(end), dimensions: ["page", "query"] }),
  gscQuery({ startDate: iso(start), endDate: iso(end), dimensions: ["page", "query"], country: "ind" }),
]);
const posMap = new Map(pgIn.map((r) => [r.keys[0] + "\n" + r.keys[1], r.position]));
for (const r of pg) {
  const [url, q] = r.keys;
  const pin = posMap.get(url + "\n" + q) ?? r.position ?? 0;
  buf.push(`INSERT OR REPLACE INTO url_keywords(url,query,segment,clicks,impressions,ctr,position_in) ` +
    `VALUES('${esc(url)}','${esc(q)}','${segmentOf(url)}',${r.clicks | 0},${r.impressions | 0},${(r.ctr || 0).toFixed(4)},${pin.toFixed(1)});`);
  if (buf.length >= 6000) flush();
}
flush();
setMeta("keywords_last_run", new Date().toISOString());
console.log(`Done. query_daily rows ~${n}, url_keywords rows ~${pg.length}.`);
