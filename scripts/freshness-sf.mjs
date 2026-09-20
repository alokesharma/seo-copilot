// Real content-freshness from the existing daily Screaming Frog crawls.
// Signal = Word Count delta (validated: stable per page; SF's Hash is noise).
// Reads ~/.seo-copilot/exports/<date>/<ts>/internal_all.csv chronologically,
// detects the last crawl date each page's body changed, writes page_content_changes.
//
// Edge cases handled (see prior dashboard HANDOFF.md):
//  - Partial/failed crawl  -> skip the whole crawl if valid-row count < 90% of max
//  - Failed page (wc 0/'')  -> ignore that row (don't count as a change)
//  - New page               -> baseline (tracked_since), not a change
//  - Missing page one day    -> just absent; carry last known state
//  - URL normalisation       -> trailing slash + https + strip #/query
//   node scripts/freshness-sf.mjs
// FALSE-FRESH FIXES (2026-08-04): the word-count edit signal is magnitude-AGNOSTIC
// now. A page is credited with an edit ONLY if its word delta is (a) >=10 words
// (tiny = dynamic counter/date), (b) NOT on a mass-change day (>=50 pages & >=4x
// the normal daily change count = sitewide nav/footer/widget change), and (c) NOT
// part of an identical-signed-delta cluster (>=8 pages, ±1 day = sitewide element).
// Fails SAFE: a real edit coinciding with a sitewide day, or under 10 words, is
// MISSED (shown not-Fresh), never falsely Fresh — recoverable via the ✎ attest
// button. Definitive fix for the missed cases = compare BODY CONTENT (SF custom
// extraction / body hash), not word count.
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { runFile, esc, query } from "./lib/d1.mjs";

const ROOT = process.env.HOME + "/.seo-copilot/exports";
if (!existsSync(ROOT)) { console.error("No SF exports at " + ROOT); process.exit(1); }

const norm = (u) => {
  try { const x = new URL(u.trim()); x.hash = ""; x.search = "";
    let s = x.toString(); return s.endsWith("/") ? s : s + "/"; } catch { return u.trim(); }
};

// Minimal robust CSV parser (quoted fields, embedded commas/newlines).
function parseCSV(text) {
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Gather crawls in date order.
const dates = readdirSync(ROOT).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
const crawls = [];
for (const d of dates) {
  const dir = `${ROOT}/${d}`;
  // merge ALL exports for the day (main crawl + supplemental blind-spot crawl)
  const csvs = readdirSync(dir).filter((x) => /^\d/.test(x)).sort()
    .map((ts) => `${dir}/${ts}/internal_all.csv`).filter((f) => existsSync(f));
  if (csvs.length) crawls.push({ date: d, csvs });
}
console.log(`Found ${crawls.length} crawls (${dates[0]} → ${dates[dates.length - 1]}).`);

// Parse each crawl -> map(url -> wordCount), applying the partial-crawl guard.
const perCrawl = [];
let maxRows = 0;
for (const c of crawls) {
  let rows = [];
  for (const f of c.csvs) {
    const part = parseCSV(readFileSync(f, "utf8").replace(/^\uFEFF/, ""));
    rows = rows.length ? rows.concat(part.slice(1)) : part; // keep one header
  }
  const header = rows[0].map((h) => h.replace(/^﻿/, ""));
  const iAddr = header.indexOf("Address"), iWc = header.indexOf("Word Count");
  const iCode = header.findIndex((h) => /status code/i.test(h));
  const m = new Map();
  for (let r = 1; r < rows.length; r++) {
    const addr = rows[r][iAddr]; if (!addr) continue;
    const wc = parseInt(rows[r][iWc], 10);
    const code = iCode >= 0 ? parseInt(rows[r][iCode], 10) : 200;
    if (!Number.isFinite(wc) || wc <= 0) continue;      // failed page -> ignore
    if (code && code !== 200) continue;                  // non-200 -> ignore
    m.set(norm(addr), wc);
  }
  maxRows = Math.max(maxRows, m.size);
  perCrawl.push({ date: c.date, wc: m });
}
// Partial-crawl policy (v2, 2026-07-25): a partial crawl's PRESENT rows are real
// observations of those pages — only its ABSENCES are meaningless (and absence
// never creates a change event; bad rows are already dropped by the wc>0 /
// status-200 filters above). Dropping whole partial crawls once delayed a real
// edit's confirmation by a day (Jul-24 partial held the first sighting). So we
// KEEP every crawl's valid rows; the persist-≥2-crawls rule still guards truth.
const partial = perCrawl.filter((c) => c.wc.size < maxRows * 0.9).length;
const good = perCrawl;
console.log(`Using all ${good.length} crawls (${partial} partial — their present rows are valid observations). Max pages ${maxRows}.`);

// Walk chronologically, detect word-count changes.
// Build per-URL word-count series, then DEBOUNCE single-crawl blips (a dynamic
// element flickers +/- for one crawl then reverts — NOT a real edit). Only a
// change that persists is counted. Kills false positives like fastag 1866→1876→1866.
const seriesByUrl = new Map();
for (const c of good) for (const [url, wc] of c.wc) {
  if (!seriesByUrl.has(url)) seriesByUrl.set(url, []);
  seriesByUrl.get(url).push({ date: c.date, wc });
}
// Pass 1: per-URL change events (persist >=2 crawls to kill 1-crawl blips).
// delta is SIGNED — a sitewide template change produces the SAME signed delta on
// many unrelated pages; a real editorial edit produces a delta unique to its page.
const events = []; // {url, date, delta (signed)}
const baseInfo = new Map();
for (const [url, ser] of seriesByUrl) {
  const runs = [];
  for (const { date, wc } of ser) {
    if (runs.length && runs[runs.length - 1].wc === wc) runs[runs.length - 1].len++;
    else runs.push({ wc, date, len: 1 });
  }
  const stable = runs.filter((r, i) => r.len >= 2 || i === 0);
  let prev = stable[0]?.wc;
  for (let i = 1; i < stable.length; i++) if (stable[i].wc !== prev) {
    // MIN_DELTA: a genuine content refresh moves many words. A ±1–9 word shift is
    // a dynamic element (counter, "as on <date>", rotating stat) — never credited
    // as an editorial edit. Real edits in this data are dozens–hundreds of words.
    if (Math.abs(stable[i].wc - prev) >= 10)
      events.push({ url, date: stable[i].date, delta: stable[i].wc - prev });
    prev = stable[i].wc;
  }
  baseInfo.set(url, { tracked_since: ser[0].date, last_wc: stable[stable.length - 1]?.wc ?? ser[ser.length - 1].wc });
}

// Pass 2: TEMPLATE/SITEWIDE FILTER — magnitude-agnostic, two complementary signals.
const byDate = new Map();
for (const e of events) { if (!byDate.has(e.date)) byDate.set(e.date, []); byDate.get(e.date).push(e); }

// (a) MASS-CHANGE DAY: a crawl date with an abnormal number of changed pages
// relative to a normal editorial day. No content team edits 50+ pages in a day;
// this is a sitewide nav/footer/widget change. Whole day quarantined (no escape
// hatch — word count can't prove a real edit apart from a template change of the
// same size, so we stay conservative: 0% false "Fresh").
const dailyCounts = [...byDate.values()].map((l) => l.length).sort((a, b) => a - b);
const medianDaily = dailyCounts[Math.floor(dailyCounts.length / 2)] || 0;
const templateDays = new Set();
for (const [d, list] of byDate) {
  if (list.length >= 50 && list.length >= 4 * Math.max(medianDaily, 5)) {
    templateDays.add(d);
    console.log(`MASS-CHANGE DAY @ ${d}: ${list.length} pages changed (normal day ~${medianDaily}) -> quarantined (sitewide, not editorial)`);
  }
}

// (b) IDENTICAL-DELTA CLUSTER: same signed word-delta on many unrelated pages
// within a ±1-day window is a sitewide element change even if the day isn't huge
// (catches slow rollouts / crawl-date smearing from partial crawls).
const CLUSTER_MIN = 8;
function clusterSize(e) {
  let c = 0;
  for (const e2 of byDate.get(e.date) || []) if (e2.delta === e.delta) c++;
  for (const off of [-1, 1]) {
    const nd = shiftDate(e.date, off);
    for (const e2 of byDate.get(nd) || []) if (e2.delta === e.delta) c++;
  }
  return c;
}
const real = events.filter((e) =>
  !templateDays.has(e.date) && clusterSize(e) < CLUSTER_MIN);
const droppedCluster = events.filter((e) => !templateDays.has(e.date) && clusterSize(e) >= CLUSTER_MIN).length;
if (droppedCluster) console.log(`Identical-delta clusters: dropped ${droppedCluster} sitewide-change events on non-mass days.`);

const state = new Map();
for (const [url, info] of baseInfo) {
  const mine = real.filter((e) => e.url === url);
  const last_changed = mine.length ? mine[mine.length - 1].date : null;
  state.set(url, { ...info, last_changed, changes: mine.length });
}

function shiftDate(d, off) {
  const t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + off);
  return t.toISOString().slice(0, 10);
}

// MERGE, never clobber: Ahrefs-derived history (pre-SF-window last_changed,
// older tracked_since, date_precision) must survive every SF re-ingest.
const existing = new Map(query(
  `SELECT url, tracked_since, last_changed, date_precision FROM page_content_changes`
).map((r) => [r.url, r]));
const sfStart = good[0]?.date || "2026-06-26";

const now = new Date().toISOString();
let buf = [];
const flush = () => { if (buf.length) { runFile(buf.join("\n")); buf = []; } };
for (const [url, s] of state) {
  const ex = existing.get(url);
  // ATTESTED dates (owner-confirmed) are protected: only a LATER SF-observed
  // change may supersede them.
  if (ex?.date_precision === "attested" && (!s.last_changed || s.last_changed <= ex.last_changed)) {
    buf.push(
      `INSERT OR REPLACE INTO page_content_changes(url,tracked_since,last_changed,changes_in_window,last_word_count,computed_at,date_precision) ` +
      `VALUES('${esc(url)}','${ex.tracked_since && ex.tracked_since < s.tracked_since ? ex.tracked_since : s.tracked_since}','${ex.last_changed}',${s.changes},${s.last_wc},'${now}','attested');`
    );
    if (buf.length >= 2000) flush();
    continue;
  }
  // SF found a change -> SF wins (daily precision). Else keep an existing date
  // only if it PRE-dates the SF window (Ahrefs history SF can't see).
  const last = s.last_changed || (ex?.last_changed && ex.last_changed < sfStart ? ex.last_changed : null);
  const precision = s.last_changed ? "day" : (ex?.last_changed && ex.last_changed < sfStart ? (ex.date_precision || "day") : "day");
  const tracked = ex?.tracked_since && ex.tracked_since < s.tracked_since ? ex.tracked_since : s.tracked_since;
  buf.push(
    `INSERT OR REPLACE INTO page_content_changes(url,tracked_since,last_changed,changes_in_window,last_word_count,computed_at,date_precision) ` +
    `VALUES('${esc(url)}','${tracked}',${last ? `'${last}'` : "NULL"},${s.changes},${s.last_wc},'${now}','${precision}');`
  );
  if (buf.length >= 2000) flush();
}
flush();
const changed = [...state.values()].filter((s) => s.last_changed).length;
console.log(`Done. ${state.size} pages tracked, ${changed} changed within the window.`);
