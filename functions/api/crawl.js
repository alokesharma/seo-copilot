// Crawl data: detect a local Screaming Frog install, or accept a CSV the user
// exports themselves. Either path ends in the same crawl_pages table, so the
// technical agents do not care which was used.
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

// Column headers we need, and the Screaming Frog names they arrive under.
const WANTED = {
  url: ["Address", "URL", "url"],
  status_code: ["Status Code", "status_code"],
  indexability: ["Indexability"],
  indexability_status: ["Indexability Status"],
  title: ["Title 1", "Title"],
  title_len: ["Title 1 Length"],
  meta_desc: ["Meta Description 1"],
  meta_desc_len: ["Meta Description 1 Length"],
  h1: ["H1-1", "H1"],
  h2_1: ["H2-1"],
  meta_robots: ["Meta Robots 1"],
  canonical: ["Canonical Link Element 1"],
  word_count: ["Word Count"],
  crawl_depth: ["Crawl Depth"],
  inlinks: ["Unique Inlinks", "Inlinks"],
  outlinks: ["Outlinks"],
  redirect_url: ["Redirect URL"],
  redirect_type: ["Redirect Type"],
  response_time: ["Response Time"],
  flesch: ["Flesch Reading Ease Score"],
  text_ratio: ["Text Ratio"],
  near_dup_url: ["Closest Near Duplicate Match"],
  similarity: ["Semantic Similarity Score"],
};

function parseCsv(text) {
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export async function onRequestGet({ env }) {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) n, MAX(crawled_at) at FROM crawl_pages`).first().catch(() => null);
  return json({
    pages: r?.n || 0,
    crawled_at: r?.at || null,
    // what the technical agents need to work
    needed_for: ["Crawl errors", "Indexability", "Orphan pages", "Thin content",
                 "Duplicate content", "Heading structure", "Page speed", "Internal linking"],
  });
}

export async function onRequestPost({ env, request }) {
  const text = await request.text();
  if (!text || text.length < 50) return json({ ok: false, error: "That file looks empty." }, 400);

  const rows = parseCsv(text.replace(/^﻿/, ""));
  if (rows.length < 2) return json({ ok: false, error: "No rows found in that CSV." }, 400);

  const header = rows[0].map((h) => h.trim());
  const idx = {};
  for (const [col, names] of Object.entries(WANTED)) {
    const i = names.map((n) => header.indexOf(n)).find((x) => x >= 0);
    if (i !== undefined && i >= 0) idx[col] = i;
  }
  if (idx.url === undefined) {
    return json({ ok: false,
      error: `No URL column. Expected one named "Address" — export the Internal → All tab from Screaming Frog.`,
      found_columns: header.slice(0, 12) }, 400);
  }

  const num = (v) => { const s = String(v ?? "").trim(); if (!s) return null; const n = parseFloat(s.replace(/[^0-9.-]/g, "")); return Number.isFinite(n) ? n : null; };
  const txt = (v, n = 400) => String(v ?? "").slice(0, n);
  const ASSET = /\.(css|js|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|pdf|xml|json)(\?|$)/i;

  const out = [];
  for (const r of rows.slice(1)) {
    const url = txt(r[idx.url], 600);
    if (!/^https?:\/\//.test(url) || ASSET.test(url)) continue;
    const rec = { url };
    for (const c of Object.keys(idx)) {
      if (c === "url") continue;
      const raw = r[idx[c]];
      rec[c] = ["status_code", "title_len", "meta_desc_len", "word_count", "crawl_depth", "inlinks", "outlinks"].includes(c)
        ? (num(raw) === null ? null : Math.round(num(raw)))
        : ["response_time", "flesch", "text_ratio", "similarity"].includes(c) ? num(raw) : txt(raw);
    }
    out.push(rec);
  }
  if (!out.length) return json({ ok: false, error: "No page rows found — every row was an asset or a non-URL." }, 400);

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS crawl_pages (
    url TEXT PRIMARY KEY, status_code INTEGER, indexability TEXT, indexability_status TEXT,
    title TEXT, title_len INTEGER, meta_desc TEXT, meta_desc_len INTEGER, h1 TEXT, h2_1 TEXT,
    meta_robots TEXT, canonical TEXT, word_count INTEGER, crawl_depth INTEGER, inlinks INTEGER,
    outlinks INTEGER, redirect_url TEXT, redirect_type TEXT, response_time REAL, flesch REAL,
    text_ratio REAL, near_dup_url TEXT, similarity REAL, crawled_at TEXT)`).run();

  const cols = ["url", ...Object.keys(WANTED).filter((c) => c !== "url" && idx[c] !== undefined), "crawled_at"];
  const day = new Date().toISOString().slice(0, 10);
  const stmt = env.DB.prepare(
    `INSERT OR REPLACE INTO crawl_pages(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})`);
  const batch = out.map((r) => stmt.bind(...cols.map((c) => (c === "crawled_at" ? day : r[c] ?? null))));
  for (let i = 0; i < batch.length; i += 200) await env.DB.batch(batch.slice(i, i + 200));

  return json({ ok: true, pages: out.length, crawled_at: day,
    columns_found: Object.keys(idx).length,
    note: `Imported ${out.length} pages. Technical agents will use this until you upload a newer crawl.` });
}
