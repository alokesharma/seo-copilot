// Ingest the LATEST Screaming Frog internal_all.csv into D1 `crawl_pages` so the
// Copilot's technical agents (orphans, redirects, crawl errors, indexability,
// missing H1/canonical, thin content) can query real crawl data.
// The raw crawl already exists (~/.seo-copilot/exports/<date>/<ts>/internal_all.csv);
// the freshness pipeline only used Word Count — this ingests the rest.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { runFile, esc, query } from "./lib/d1.mjs";

const EXPORTS = process.env.HOME + "/.seo-copilot/exports";

// newest internal_all.csv across date/ts folders
function latestCsv() {
  const days = readdirSync(EXPORTS).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  for (const day of days.reverse()) {
    const base = `${EXPORTS}/${day}`;
    const tss = readdirSync(base).filter((t) => existsSync(`${base}/${t}/internal_all.csv`)).sort();
    if (tss.length) return { path: `${base}/${tss[tss.length - 1]}/internal_all.csv`, day };
  }
  throw new Error("no internal_all.csv found under " + EXPORTS);
}

// minimal RFC-4180 CSV parser (handles quoted fields, embedded commas/quotes/newlines)
function parseCsv(text) {
  const rows = []; let row = [], field = "", inq = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inq) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inq = false; }
      else field += c;
    } else {
      if (c === '"') inq = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* skip */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const ASSET = /\.(css|js|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|pdf|xml|json)(\?|$)/i;

const { path, day } = latestCsv();
const raw = parseCsv(readFileSync(path, "utf8").replace(/^﻿/, ""));
const header = raw[0];
const col = (name) => header.indexOf(name);
const idx = {
  url: col("Address"), status: col("Status Code"), indexability: col("Indexability"),
  idx_status: col("Indexability Status"), title: col("Title 1"), title_len: col("Title 1 Length"),
  meta: col("Meta Description 1"), meta_len: col("Meta Description 1 Length"), h1: col("H1-1"),
  robots: col("Meta Robots 1"), canonical: col("Canonical Link Element 1"), wc: col("Word Count"),
  depth: col("Crawl Depth"), inlinks: col("Unique Inlinks"), outlinks: col("Outlinks"),
  redirect: col("Redirect URL"), redirect_type: col("Redirect Type"),
  // content-quality signals SF already exports (we were ingesting 18 of 75 columns)
  flesch: col("Flesch Reading Ease Score"), readability: col("Readability"),
  sentences: col("Sentence Count"), avg_words_sentence: col("Average Words Per Sentence"),
  text_ratio: col("Text Ratio"), response_time: col("Response Time"), size_bytes: col("Size (bytes)"),
  h2_1: col("H2-1"), h2_2: col("H2-2"), link_score: col("Link Score"),
  spelling_errors: col("Spelling Errors"), grammar_errors: col("Grammar Errors"),
  // duplicate / similarity signals (agent 34)
  near_dup_url: col("Closest Near Duplicate Match"), near_dup_count: col("No. Near Duplicates"),
  similar_url: col("Closest Semantically Similar Address"), similarity: col("Semantic Similarity Score"), similar_count: col("No. Semantically Similar"),
};
if (idx.url < 0 || idx.status < 0) throw new Error("unexpected CSV header: " + header.slice(0, 6).join(" | "));

const flt = (v) => { const s = String(v ?? "").trim(); if (!s) return null; const n = parseFloat(s.replace(/[^0-9.-]/g, "")); return Number.isFinite(n) ? n : null; };
const num = (v) => { const s = String(v ?? "").trim(); if (!s) return null; const n = parseInt(s.replace(/[^0-9-]/g, ""), 10); return Number.isFinite(n) ? n : null; };
const t = (v, n = 300) => String(v || "").slice(0, n);   // cap text (audit needs the value, not the essay)
const rows = raw.slice(1)
  .filter((r) => r[idx.url] && /^https?:\/\//.test(r[idx.url]) && !ASSET.test(r[idx.url]))
  .map((r) => ({
    url: t(r[idx.url], 600), status: num(r[idx.status]), indexability: t(r[idx.indexability], 40),
    idx_status: t(r[idx.idx_status], 120), title: t(r[idx.title]), title_len: num(r[idx.title_len]),
    meta: t(r[idx.meta], 400), meta_len: num(r[idx.meta_len]), h1: t(r[idx.h1]),
    robots: t(r[idx.robots], 120), canonical: t(r[idx.canonical], 600), wc: num(r[idx.wc]),
    depth: num(r[idx.depth]), inlinks: num(r[idx.inlinks]), outlinks: num(r[idx.outlinks]),
    redirect: t(r[idx.redirect], 600), redirect_type: t(r[idx.redirect_type], 40),
    near_dup_url: idx.near_dup_url >= 0 ? t(r[idx.near_dup_url], 600) : "", near_dup_count: idx.near_dup_count >= 0 ? num(r[idx.near_dup_count]) : null,
    similar_url: idx.similar_url >= 0 ? t(r[idx.similar_url], 600) : "", similarity: idx.similarity >= 0 ? parseFloat(String(r[idx.similarity]).replace(/[^0-9.]/g, "")) || null : null,
    similar_count: idx.similar_count >= 0 ? num(r[idx.similar_count]) : null,
    // NB: flt() keeps null when SF leaves a cell blank. A blank is "not measured"
    // and must never reach an agent as 0 — that is what invented "0 ads on top".
    flesch: flt(r[idx.flesch]), readability: t(r[idx.readability], 40),
    sentences: num(r[idx.sentences]), avg_words_sentence: flt(r[idx.avg_words_sentence]),
    text_ratio: flt(r[idx.text_ratio]), response_time: flt(r[idx.response_time]),
    size_bytes: num(r[idx.size_bytes]), h2_1: t(r[idx.h2_1], 200), h2_2: t(r[idx.h2_2], 200),
    link_score: flt(r[idx.link_score]), spelling_errors: num(r[idx.spelling_errors]),
    grammar_errors: num(r[idx.grammar_errors]),
  }));

// Idempotent (no DROP) so the daily re-run upserts without needing an exclusive
// lock while the team's server is reading the same local D1.
const DDL = `
CREATE TABLE IF NOT EXISTS crawl_pages (
  url TEXT PRIMARY KEY, status_code INTEGER, indexability TEXT, indexability_status TEXT,
  title TEXT, title_len INTEGER, meta_desc TEXT, meta_desc_len INTEGER, h1 TEXT,
  meta_robots TEXT, canonical TEXT, word_count INTEGER, crawl_depth INTEGER,
  inlinks INTEGER, outlinks INTEGER, redirect_url TEXT, redirect_type TEXT, crawled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_crawl_status ON crawl_pages(status_code);
CREATE INDEX IF NOT EXISTS idx_crawl_inlinks ON crawl_pages(inlinks);`;

runFile(DDL);
// additive schema migration for the similarity columns (SQLite has no ADD COLUMN IF NOT EXISTS)
const have = new Set(query(`PRAGMA table_info(crawl_pages)`).map((c) => c.name));
for (const [c, ty] of [["near_dup_url", "TEXT"], ["near_dup_count", "INTEGER"], ["similar_url", "TEXT"], ["similarity", "REAL"], ["similar_count", "INTEGER"],
  ["flesch", "REAL"], ["readability", "TEXT"], ["sentences", "INTEGER"], ["avg_words_sentence", "REAL"],
  ["text_ratio", "REAL"], ["response_time", "REAL"], ["size_bytes", "INTEGER"], ["h2_1", "TEXT"], ["h2_2", "TEXT"],
  ["link_score", "REAL"], ["spelling_errors", "INTEGER"], ["grammar_errors", "INTEGER"]])
  if (!have.has(c)) runFile(`ALTER TABLE crawl_pages ADD COLUMN ${c} ${ty};`);
const cols = "url,status_code,indexability,indexability_status,title,title_len,meta_desc,meta_desc_len,h1,meta_robots,canonical,word_count,crawl_depth,inlinks,outlinks,redirect_url,redirect_type,crawled_at,near_dup_url,near_dup_count,similar_url,similarity,similar_count,flesch,readability,sentences,avg_words_sentence,text_ratio,response_time,size_bytes,h2_1,h2_2,link_score,spelling_errors,grammar_errors";
const q = (s) => `'${esc(s)}'`;   // esc only escapes quotes; wrap in quotes ourselves
const val = (r) => `(${q(r.url)},${r.status ?? "NULL"},${q(r.indexability)},${q(r.idx_status)},${q(r.title)},${r.title_len ?? "NULL"},${q(r.meta)},${r.meta_len ?? "NULL"},${q(r.h1)},${q(r.robots)},${q(r.canonical)},${r.wc ?? "NULL"},${r.depth ?? "NULL"},${r.inlinks ?? "NULL"},${r.outlinks ?? "NULL"},${q(r.redirect)},${q(r.redirect_type)},${q(day)},${q(r.near_dup_url)},${r.near_dup_count ?? "NULL"},${q(r.similar_url)},${r.similarity ?? "NULL"},${r.similar_count ?? "NULL"},${r.flesch ?? "NULL"},${q(r.readability)},${r.sentences ?? "NULL"},${r.avg_words_sentence ?? "NULL"},${r.text_ratio ?? "NULL"},${r.response_time ?? "NULL"},${r.size_bytes ?? "NULL"},${q(r.h2_1)},${q(r.h2_2)},${r.link_score ?? "NULL"},${r.spelling_errors ?? "NULL"},${r.grammar_errors ?? "NULL"})`;
for (let i = 0; i < rows.length; i += 60) {
  const chunk = rows.slice(i, i + 60);
  runFile(`INSERT OR REPLACE INTO crawl_pages(${cols}) VALUES\n${chunk.map(val).join(",\n")};`);
}

const n = query(`SELECT COUNT(*) c FROM crawl_pages`)[0].c;
const orphans = query(`SELECT COUNT(*) c FROM crawl_pages WHERE inlinks=0 AND status_code=200`)[0].c;
const errs = query(`SELECT COUNT(*) c FROM crawl_pages WHERE status_code>=400`)[0].c;
const noH1 = query(`SELECT COUNT(*) c FROM crawl_pages WHERE (h1='' OR h1 IS NULL) AND status_code=200`)[0].c;
console.log(`crawl_pages: ${n} pages from ${day}. orphans(inlinks=0,200)=${orphans}, 4xx/5xx=${errs}, missing-H1=${noH1}`);
// Coverage of the newly ingested columns. A column at 0 means SF is not producing
// it (analysis switched off), NOT that every page scores zero.
const cov = query(`SELECT
  SUM(CASE WHEN flesch IS NOT NULL THEN 1 ELSE 0 END) flesch,
  SUM(CASE WHEN response_time IS NOT NULL THEN 1 ELSE 0 END) response_time,
  SUM(CASE WHEN text_ratio IS NOT NULL THEN 1 ELSE 0 END) text_ratio,
  SUM(CASE WHEN h2_1<>'' THEN 1 ELSE 0 END) h2,
  SUM(CASE WHEN link_score IS NOT NULL THEN 1 ELSE 0 END) link_score,
  SUM(CASE WHEN similarity IS NOT NULL THEN 1 ELSE 0 END) similarity,
  SUM(CASE WHEN spelling_errors IS NOT NULL THEN 1 ELSE 0 END) spelling
  FROM crawl_pages`)[0];
console.log("column coverage of " + n + ": " + Object.entries(cov).map(([k, v]) => `${k}=${v}`).join(", "));
