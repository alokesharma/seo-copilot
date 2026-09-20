// Ahrefs back-history: TRUE last-edit dates via strict normalized body hashing +
// template-rollout filtering. 100%-truth rules:
//  - body = article only (nav/footer/author/testimonials/breadcrumbs stripped)
//  - change = exact hash mismatch (no tolerance — catches same-length edits)
//  - TEMPLATE FILTER: a boundary where >=25% of scanned pages changed with tiny
//    word deltas (median <=5) is a sitewide rollout, NOT editorial -> discarded.
//  - a page is only dated by a surviving REAL event; else last_changed stays NULL.
//   NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/freshness-ahrefs.mjs [--limit=6000] [--concurrency=12]
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { query, runFile, esc } from "./lib/d1.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const LIMIT = parseInt(args.limit || "6000", 10);
const CONC = parseInt(args.concurrency || "12", 10);
const MONTHS = 16;
const PROJECT_ID = 5340273;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function token() {
  if (process.env.AHREFS_TOKEN) return process.env.AHREFS_TOKEN;
  const p = new URL("../.dev.vars", import.meta.url).pathname;
  if (existsSync(p)) { const m = readFileSync(p, "utf8").match(/^AHREFS_TOKEN=(.+)$/m); if (m) return m[1].trim(); }
  throw new Error("AHREFS_TOKEN not set.");
}
const TOKEN = token();

// Strict article-body normalisation (validated on fastag + e-challan-UP).
function normBody(md) {
  let t = md;
  const h = t.search(/(^|\n)#\s/); if (h >= 0) t = t.slice(h);
  const f = t.search(/Was this article helpful|Written by|Reviewed by|the site Technology &amp;? Services/i); if (f > 0) t = t.slice(0, f); // crop BEFORE the feedback widget + rotating Recent-Articles feed
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");                                    // links -> text
  t = t.replace(/What our customers[\s\S]*?(?=#+\s*\*?\*?Frequently Asked|$)/i, " "); // testimonials
  t = t.replace(/^.*\\>.*$/gm, " ").replace(/^.*Home\s*&gt;.*$/gim, " ");           // breadcrumbs
  t = t.replace(/\s+/g, " ").trim();
  return { hash: createHash("sha256").update(t).digest("hex").slice(0, 16), words: t.split(" ").length, text: t };
}

const cache = new Map();
async function snapshot(url, dateISO) {
  const key = url + "|" + dateISO;
  if (cache.has(key)) return cache.get(key);
  const u = new URL("https://api.ahrefs.com/v3/site-audit/page-content");
  u.searchParams.set("select", "crawl_datetime,page_text_md");
  u.searchParams.set("target_url", url);
  u.searchParams.set("project_id", PROJECT_ID);
  u.searchParams.set("date", dateISO + "T00:00:00");
  let res = null;
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(u, { headers: { Authorization: "Bearer " + TOKEN, Accept: "application/json" } });
      if (r.status === 429 || r.status >= 500) { await sleep(1000 * (a + 1)); continue; }
      if (!r.ok) { cache.set(key, null); return null; }
      res = await r.json(); break;
    } catch { await sleep(1000 * (a + 1)); }
  }
  const pc = res && res["page-content"];
  if (!pc || !pc.page_text_md) { cache.set(key, null); return null; }
  const out = { crawl: (pc.crawl_datetime || "").slice(0, 10), ...normBody(pc.page_text_md) };
  cache.set(key, out);
  return out;
}

// Monthly grid oldest -> newest.
const grid = [];
for (let i = MONTHS; i >= 0; i--) { const d = new Date(); d.setMonth(d.getMonth() - i); grid.push(d.toISOString().slice(0, 10)); }

// Pages: everything with traffic that SF hasn't already dated with a REAL event.
// --urls=a,b,c  overrides with an explicit list (surgical mode, saves API units).
const targets = args.urls
  ? args.urls.split(",")
  : query(
      `SELECT c.url url FROM page_content_changes c
         JOIN url_windows t ON t.url=c.url
        WHERE c.last_changed IS NULL AND t.clicks_90d > 20
        ORDER BY t.clicks_90d DESC LIMIT ${LIMIT}`
    ).map((r) => r.url);
console.log(`PASS 1: scanning ${targets.length} pages × ${grid.length} snapshots for change events…`);

// PASS 1 — collect ALL boundary events per page (no early stop; needed for the
// template filter to see mass-boundaries).
const events = [];            // {url, boundary (older crawl date), newerCrawl, delta}
const scanned = new Set();
let done = 0;
async function scanPage(url) {
  const snaps = [];
  for (const g of grid) { const s = await snapshot(url, g); if (s) snaps.push({ g, ...s }); }
  done++;
  if (done % 25 === 0) process.stdout.write(`\r  ${done}/${targets.length}`);
  if (snaps.length < 2) return;
  scanned.add(url);
  // dedupe consecutive identical crawls, then find hash boundaries
  const uniq = snaps.filter((s, i) => i === 0 || s.crawl !== snaps[i - 1].crawl);
  for (let i = 1; i < uniq.length; i++) {
    if (uniq[i].hash !== uniq[i - 1].hash)
      events.push({ url, boundary: uniq[i].crawl, delta: Math.abs(uniq[i].words - uniq[i - 1].words),
        gPrev: uniq[i - 1].g, gCurr: uniq[i].g });
  }
}
const q1 = [...targets];
await Promise.all(Array.from({ length: CONC }, async () => { while (q1.length) await scanPage(q1.shift()); }));
console.log(`\nPASS 2: ${events.length} raw events across ${scanned.size} scanned pages — filtering template rollouts…`);

// PASS 2 — template filter: group events by boundary crawl date.
const byBoundary = new Map();
for (const e of events) { if (!byBoundary.has(e.boundary)) byBoundary.set(e.boundary, []); byBoundary.get(e.boundary).push(e); }
const templateBoundaries = new Set();
for (const [b, list] of byBoundary) {
  const share = list.length / Math.max(scanned.size, 1);
  const deltas = list.map((e) => e.delta).sort((a, b2) => a - b2);
  const median = deltas[Math.floor(deltas.length / 2)];
  // Two gates: mass + tiny deltas = chrome injection; OR sheer mass (nobody
  // hand-edits 40%+ of the site in one crawl) regardless of delta.
  if ((share >= 0.2 && median <= 8) || share >= 0.4) {
    templateBoundaries.add(b);
    console.log(`  TEMPLATE ROLLOUT detected @ ${b}: ${list.length}/${scanned.size} pages, median Δ${median} words -> ignored`);
  }
}
// PASS 3 — signature salvage: at a template boundary, a rollout injects the SAME
// words on every page; a real edit changes UNIQUE words. Compare each event's
// word-level diff against the boundary's common signature; big residual = real
// edit that merely coincided with the rollout -> KEEP it.
const wordSet = (t) => new Set(t.split(" "));
function diffSets(aText, bText) {
  const A = wordSet(aText), B = wordSet(bText);
  return { added: [...B].filter((w) => !A.has(w)), removed: [...A].filter((w) => !B.has(w)) };
}
const salvaged = [];
for (const b of templateBoundaries) {
  const list = events.filter((e) => e.boundary === b);
  const diffs = list.map((e) => {
    const a = cache.get(e.url + "|" + e.gPrev), c = cache.get(e.url + "|" + e.gCurr);
    return a && c ? { e, ...diffSets(a.text, c.text) } : null;
  }).filter(Boolean);
  if (diffs.length < 5) continue;
  // signature = words added/removed on >=60% of affected pages
  const freq = (key) => {
    const m = new Map();
    for (const d of diffs) for (const w of new Set(d[key])) m.set(w, (m.get(w) || 0) + 1);
    return new Set([...m].filter(([, n]) => n >= diffs.length * 0.6).map(([w]) => w));
  };
  const sigA = freq("added"), sigR = freq("removed");
  for (const d of diffs) {
    const residual = d.added.filter((w) => !sigA.has(w)).length + d.removed.filter((w) => !sigR.has(w)).length;
    if (residual >= 12) { salvaged.push(d.e); }
  }
  if (salvaged.length) console.log(`  salvaged ${salvaged.filter((e) => e.boundary === b).length} REAL edits hidden inside rollout @ ${b}`);
}
const real = events.filter((e) => !templateBoundaries.has(e.boundary)).concat(salvaged);

// Latest surviving real event per page -> last_changed.
const latest = new Map();
for (const e of real) if (!latest.has(e.url) || e.boundary > latest.get(e.url)) latest.set(e.url, e.boundary);

let buf = [];
const flush = () => { if (buf.length) { runFile(buf.join("\n")); buf = []; } };
for (const url of scanned) {
  const lc = latest.get(url);
  if (lc) buf.push(`UPDATE page_content_changes SET last_changed='${lc}' WHERE url='${esc(url)}' AND last_changed IS NULL;`);
  else buf.push(`UPDATE page_content_changes SET tracked_since='${grid[0]}' WHERE url='${esc(url)}' AND last_changed IS NULL;`);
  if (buf.length >= 300) flush();
}
flush();
console.log(`Done. ${latest.size} pages dated with REAL edits; ${scanned.size - latest.size} verified unchanged (≥16 mo); ${templateBoundaries.size} template rollouts ignored.`);
