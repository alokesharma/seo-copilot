// Pull GSC page-level data into local D1, day by day. DUAL PULL per day:
//  - global (all countries): clicks / impressions / ctr / global position
//  - India only (country=ind): India position -> position_in (the one we display)
// Resumable via meta.backfill_cursor. Re-runnable (INSERT OR REPLACE).
//   node scripts/backfill.mjs [--days=490] [--from=YYYY-MM-DD]
import { gscQuery } from "./lib/gsc.mjs";
import { runFile, setMeta, getMeta, esc } from "./lib/d1.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const DAYS = parseInt(args.days || "490", 10);
const iso = (d) => d.toISOString().slice(0, 10);
const segmentOf = (url) => {
  try { const p = new URL(url).pathname.split("/").filter(Boolean); return p.length ? `/${p[0]}/` : "/"; }
  catch { return "/"; }
};

const endDate = args.to ? new Date(args.to) : new Date(Date.now() - 3 * 864e5); // GSC lag ~2-3 days
const startDate = new Date(endDate.getTime() - DAYS * 864e5);
const cursor = args.from || getMeta("backfill_cursor");
let day = new Date(cursor ? new Date(cursor).getTime() + 864e5 : startDate.getTime());
if (day < startDate) day = new Date(startDate);

console.log(`Backfill (dual pull) ${iso(day)} -> ${iso(endDate)}`);

let buf = [], bufRows = 0, total = 0;
async function flush() { if (buf.length) { runFile(buf.join("\n")); total += bufRows; buf = []; bufRows = 0; } }

for (; day <= endDate; day = new Date(day.getTime() + 864e5)) {
  const d = iso(day);
  let global, india;
  try {
    global = await gscQuery({ startDate: d, endDate: d, dimensions: ["page"] });
    india = await gscQuery({ startDate: d, endDate: d, dimensions: ["page"], country: "ind" });
  } catch (e) {
    console.error(`  ${d}  ERROR ${e.message} — stopping (safe to re-run to resume).`);
    break;
  }
  const posIn = new Map(india.map((r) => [r.keys[0], r.position]));
  for (const r of global) {
    const url = r.keys[0];
    buf.push(
      `INSERT OR REPLACE INTO gsc_daily(date,url,segment,clicks,impressions,ctr,position,position_in) ` +
      `VALUES('${d}','${esc(url)}','${segmentOf(url)}',${r.clicks | 0},${r.impressions | 0},` +
      `${(r.ctr || 0).toFixed(4)},${(r.position || 0).toFixed(1)},${(posIn.get(url) ?? r.position ?? 0).toFixed(1)});`
    );
    bufRows++;
  }
  process.stdout.write(`  ${d}  ${global.length} urls (india ${india.length})\n`);
  if (bufRows >= 8000) await flush();
  setMeta("backfill_cursor", d);
}
await flush();
setMeta("backfill_last_run", new Date().toISOString());
console.log(`Done. ~${total} rows.`);
