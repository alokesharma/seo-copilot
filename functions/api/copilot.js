import { json } from "./_lib.js";
import { getSerp, serpFeatures } from "./_serp.js";
import { AGENTS, M, U, SCHEMA_RULES } from "./_agents.js";

/* ═══════════════════════════════════════════════════════════════════════
   SEO Copilot engine v3.
   • Every agent is SCOPED to the Page Universe (product hubs + top traffic),
     never a random sweep of 5,300 URLs.
   • Diagnosis is COMPUTED in SQL (a `diagnosis`/`verdict`/`cause` column),
     never narrated by the model.
   • ONE Gemini call produces only: headline + the single action + deliverable.
   • Grounding gate: numbers the evidence can't back are stripped.
   • Response carries typed columns + a layout so the UI can render properly.
   ═══════════════════════════════════════════════════════════════════════ */

// The site under analysis. Set once at setup (Config tab) and stored in app_config;
// every query and URL helper reads it, so this tool works for any property.
let SITE = "";
export const setSite = (v) => { SITE = String(v || "").replace(/\/+$/, ""); };
export const getSite = () => SITE;
// bare domain for APIs that want "example.com" rather than a full URL
export const BARE = () => SITE.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
// is this URL ours?
const isOurs = (u) => { const b = BARE(); return !!b && String(u || "").includes(b); };
// Keys live in app_config so the Config tab is the single place to set them.
// Environment variables still win, for a developer running from .dev.vars.
let KEYS = null;
async function loadKeys(env) {
  if (KEYS) return KEYS;
  const { results } = await env.DB.prepare("SELECT key, value FROM app_config WHERE key LIKE 'keys.%'").all().catch(() => ({ results: [] }));
  const cfg = Object.fromEntries((results || []).map((r) => [r.key.replace("keys.", ""), r.value]));
  KEYS = {
    gemini: env.GEMINI_API_KEY || cfg.gemini || "",
    ahrefs: env.AHREFS_TOKEN || cfg.ahrefs || "",
    serpapi: env.SERPAPI_KEY || cfg.serpapi || "",
    firecrawl: env.FIRECRAWL_KEY || cfg.firecrawl || "",
    bing: keys().bing || cfg.bing || "",
  };
  return KEYS;
}
export const keys = () => KEYS || {};
// Which source does an agent need, and is that key present?
const SRC_KEY = { ahrefs: "ahrefs", serp: "serpapi", news: "serpapi", scrape: "firecrawl", bing: "bing" };
const agentReady = (a) => { const need = SRC_KEY[a.src]; return !need || !!(KEYS || {})[need]; };

async function loadSite(env) {
  if (SITE) return SITE;
  const r = await env.DB.prepare("SELECT value FROM app_config WHERE key='site.url'").first().catch(() => null);
  SITE = String(r?.value || "").replace(/\/+$/, "");
  return SITE;
}
const RELAY = "http://127.0.0.1:8799";
const ISO = /^\d{4}-\d{2}-\d{2}$/, SEG = /^\/[a-z0-9-]+\/$/;
const shift = (iso, d) => new Date(Date.parse(iso) + d * 864e5).toISOString().slice(0, 10);
const todayISO = () => new Date().toISOString().slice(0, 10);

function scope({ from, to, segment }) {
  if (!ISO.test(from || "") || !ISO.test(to || "")) throw new Error("bad date range");
  const seg = segment && segment !== "ALL" ? (SEG.test(segment) ? segment : null) : "";
  if (seg === null) throw new Error("bad segment");
  const brand = BARE().split(".")[0];
  const s = { from, to, seg,
    // the site as a SQL literal, for replace(url, …) in agent queries
    SITE: `'${SITE.replace(/'/g, "''")}'`,
    // exclude the site's own brand queries — CTR on "brandname" tells you nothing
    notBrand: brand ? ` AND lower(COALESCE((SELECT uk.query FROM url_keywords uk WHERE uk.url=e.url ORDER BY uk.impressions DESC LIMIT 1),'')) NOT LIKE '%${brand}%'` : "",
    segCol: seg ? ` AND segment='${seg}'` : "", segG: seg ? ` AND g.segment='${seg}'` : "",
    segU: seg ? ` AND path LIKE '${seg}%'` : "", segU2: seg ? ` AND u.path LIKE '${seg}%'` : "",
    // for agents grouping query_daily: keep only queries whose ranking page is in the folder
    segQ: seg ? ` AND EXISTS (SELECT 1 FROM url_keywords uk JOIN page_universe u ON u.url=uk.url WHERE uk.query=q.query AND u.path LIKE '${seg}%')` : "",
    segCP: seg ? ` AND cp.url LIKE '${SITE}${seg}%'` : "",
    // when a folder is selected, the page we NAME must also be inside it
    segPage: seg ? ` AND u.path LIKE '${seg}%'` : "",
    d7: shift(to, -7), d14: shift(to, -14), d31: shift(to, -31), d28: shift(to, -28), d56: shift(to, -56), d62: shift(to, -62), d90: shift(to, -90), d180: shift(to, -180) };
  // the user's period, and the equal-length period right before it (for before/after agents)
  s.len = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 864e5));
  s.prevFrom = shift(from, -s.len); s.prevTo = from;
  const fmt = (d) => new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  s.W = { range: `${fmt(from)} – ${fmt(to)}`, vsPrev: `${fmt(from)} – ${fmt(to)} vs ${fmt(s.prevFrom)} – ${fmt(s.prevTo)}`,
    week: `${fmt(s.d7)} – ${fmt(to)} vs ${fmt(s.d14)} – ${fmt(s.d7)}`, months: `latest full month vs the month before`, rank28: `${fmt(s.d28)} – ${fmt(to)} vs ${fmt(s.d56)} – ${fmt(s.d28)}`, universe: `last 90 days of traffic (page importance) · ${fmt(from)} – ${fmt(to)} for metrics`, live: `live, right now` };
  s.TOPQ = (n) => `SELECT q.query, SUM(q.impressions) impressions, SUM(q.clicks) clicks, ROUND(SUM(q.position_in*q.impressions)/NULLIF(SUM(q.impressions),0),1) pos,
    (SELECT u.path FROM url_keywords uk JOIN page_universe u ON u.url=uk.url WHERE uk.query=q.query${seg ? ` AND u.path LIKE '${seg}%'` : ""} ORDER BY uk.clicks DESC LIMIT 1) page
    FROM query_daily q WHERE q.date>'${from}' AND q.date<='${to}'${seg ? ` AND EXISTS (SELECT 1 FROM url_keywords uk JOIN page_universe u ON u.url=uk.url WHERE uk.query=q.query AND u.path LIKE '${seg}%')` : ""}
    GROUP BY q.query ORDER BY SUM(q.impressions) DESC LIMIT ${n}`;
  return s;
}

/* ── column presentation map: SQL alias → human label + type ── */
const T = { path: "path", int: "int", pct: "pct", pos: "pos", txt: "text", bad: "badge", date: "date", d: "delta" };
const COL = {
  page: ["Page", T.path], url: ["Page", T.path], worst_page: ["Worst page", T.path], top_page: ["Example page", T.path],
  current_page: ["Ranking page", T.path], existing_page: ["Existing page", T.path], winner: ["Winner", T.path], loser: ["Loser", T.path],
  redirects_to: ["Redirects to", T.path], then_to: ["Then to", T.path], link_from: ["Link from", T.path],
  page_type: ["Type", T.bad], query: ["Query", T.txt], top_query: ["Top query", T.txt], keyword: ["Keyword", T.txt],
  clicks: ["Clicks", T.int], impressions: ["Impressions", T.int], clicks_before: ["Clicks before", T.int], clicks_now: ["Clicks now", T.int],
  clicks_lost: ["Clicks lost", T.int], missed_clicks: ["Clicks missed/mo", T.int], clicks_at_risk: ["Clicks at risk", T.int],
  impressions_at_risk: ["Impressions at risk", T.int], this_week: ["This week", T.int], last_week: ["Last week", T.int],
  change: ["Change", T.d], winner_clicks: ["Winner clicks", T.int], loser_clicks: ["Loser clicks", T.int], loser_impressions: ["Loser impressions", T.int],
  pages: ["Pages", T.int], words: ["Words", T.int], inlinks: ["Inlinks", T.int], current_inlinks: ["Inlinks", T.int], depth: ["Depth", T.int],
  pos: ["Position", T.pos], pos_before: ["Position before", T.pos], pos_now: ["Position now", T.pos],
  winner_pos: ["Winner pos", T.pos], loser_pos: ["Loser pos", T.pos],
  ctr_pct: ["CTR", T.pct], expected_ctr_pct: ["Expected CTR", T.pct], ctr_before_pct: ["CTR before", T.pct], ctr_now_pct: ["CTR now", T.pct],
  loser_share_pct: ["Loser share", T.pct],
  diagnosis: ["Diagnosis", T.bad], verdict: ["Verdict", T.bad], cause: ["Cause", T.txt], kind: ["Type", T.bad], status: ["Status", T.bad],
  last_edit: ["Last edit", T.date], days_since_edit: ["Days stale", T.int], lastmod: ["Changed", T.date], month: ["Month", T.txt], period: ["Period", T.txt],
  current_title: ["Current title", T.txt], title_chars: ["Chars", T.int], current_meta: ["Current description", T.txt], meta_chars: ["Chars", T.int],
  shared_text: ["Shared text", T.txt], indexability: ["Indexable", T.bad], indexability_status: ["Reason", T.txt],
  volume: ["Volume/mo (Ahrefs est.)", T.int], difficulty: ["Difficulty (Ahrefs est.)", T.int], winnability: ["Winnable", T.int], parent_topic: ["Parent topic", T.txt],
  domain: ["Domain", T.txt], domain_rating: ["DR", T.int], referring_dr: ["Referring DR", T.int], links: ["Links", T.int],
  anchor: ["Anchor text", T.txt], share_pct: ["Share", T.pct], referring_page: ["Referring page", T.txt], our_page: ["Our page", T.path],
  lost_reason: ["Why lost", T.txt], lost_on: ["Lost on", T.date], site: ["Site", T.txt], title: ["Title", T.txt], position: ["Position", T.pos],
  schema_found: ["Schema found", T.txt], schema_missing: ["Missing", T.bad], issues: ["Issues", T.txt],
  source: ["Source", T.txt], date: ["Date", T.date], headline: ["Headline", T.txt], matched: ["Matches our query", T.txt],
  bing_code: ["Bing code", T.bad], google_impressions: ["Google impressions", T.int], question: ["Question", T.txt],
};
const titleCase = (k) => k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
// A column that says the same thing on every row carries no information — it is
// noise that makes the table look fuller than it is. Where every row shares one
// diagnosis, the fact belongs in a caption above the table, not in 25 cells.
function uniformNote(rows) {
  if (!rows?.length) return null;
  for (const k of ["diagnosis", "cause", "verdict"]) {
    if (!(k in rows[0])) continue;
    const vals = new Set(rows.map((r) => String(r[k] ?? "")));
    if (vals.size === 1 && [...vals][0]) return { key: k, text: [...vals][0] };
  }
  return null;
}
// A diagnosis that only BUCKETS a number already in the table ("average position
// 4–6" next to a Position column) tells the reader nothing they cannot see. Drop it.
// A column earns its place by adding a fact no other column carries.
const BUCKETS = new Set(["striking_distance", "weekly_kpi", "crawl_error", "duplicate_content",
  "thin_content", "indexability", "heading_structure", "slow_pages", "update_opportunity"]);
function redundantKey(agent, rows) {
  if (!BUCKETS.has(agent) || !rows?.length) return null;
  for (const k of ["diagnosis", "cause"]) if (k in rows[0]) return k;
  return null;
}
function columnsOf(rows, drop) {
  if (!rows?.length) return [];
  // union of keys, not just the first row — a column present on only some rows
  // (a suggested source page, say) must still get a header
  const keys = []; const seen = new Set();
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); keys.push(k); }
  return keys.filter((k) => k !== drop).map((k) => {
    const [label, type] = COL[k] || [titleCase(k), typeof rows[0][k] === "number" ? T.int : T.txt];
    return { key: k, label, type, align: [T.int, T.pct, T.pos, T.d].includes(type) ? "right" : "left" };
  });
}

/* ── tools ── */
async function runSql(env, sql, steps, label) {
  const t = Date.now();
  // The local D1 file is shared with the nightly crawl/universe loaders, so a
  // query can hit transient lock contention. Retry briefly before failing closed.
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, attempt * 600));
    try {
      const { results } = await env.DB.prepare(sql).all();
      steps.push({ tool: "sql", ok: true, label, detail: `${results.length} rows`, ms: Date.now() - t });
      return results;
    } catch (e) {
      last = e.message || String(e);
      if (!/D1_ERROR|internal error|locked|busy|Failed to parse body/i.test(last)) break;
    }
  }
  steps.push({ tool: "sql", ok: false, label, detail: last, ms: Date.now() - t });
  return [];
}
async function cacheGet(env, key, ttlDays) {
  try { await env.DB.prepare(`CREATE TABLE IF NOT EXISTS api_cache(key TEXT PRIMARY KEY, json TEXT, fetched_at TEXT)`).run();
    const r = await env.DB.prepare(`SELECT json, fetched_at FROM api_cache WHERE key=?`).bind(key).first();
    if (r && (Date.now() - Date.parse(r.fetched_at)) / 864e5 < ttlDays) return JSON.parse(r.json); } catch {}
  return null;
}
const cachePut = async (env, key, v) => { try { await env.DB.prepare(`INSERT OR REPLACE INTO api_cache(key,json,fetched_at) VALUES(?,?,?)`).bind(key, JSON.stringify(v), new Date().toISOString()).run(); } catch {} };
async function viaRelay(direct, relay, ms = 40000) {
  let err = "";
  for (const [via, go] of [["direct", direct], ["relay", relay]]) { try { const r = await go(ms); return { d: await r.json(), via }; } catch (e) { err = e.message; } }
  return { d: null, via: "", err };
}
async function serpFor(env, query, steps) {
  const t = Date.now(); const { data, error, stale } = await getSerp(env, query);
  steps.push({ tool: "serp", ok: !error, label: `Google SERP · ${query}`, detail: error || (stale ? "cached" : "live"), ms: Date.now() - t });
  return error ? null : serpFeatures(data);
}
async function scrape(env, url, steps, formats = ["markdown"]) {
  const key = `fc:${formats.join(",")}:${url}`; const c = await cacheGet(env, key, 3); const t = Date.now();
  if (c) { steps.push({ tool: "scrape", ok: true, label: `Page content · ${url.replace(SITE, "")}`, detail: "cached", ms: 0 }); return c; }
  const body = JSON.stringify({ url, formats, onlyMainContent: !formats.includes("rawHtml") });
  const { d, err } = await viaRelay((ms) => fetch("https://api.firecrawl.dev/v2/scrape", { method: "POST", headers: { authorization: `Bearer ${keys().firecrawl}`, "content-type": "application/json" }, body, signal: AbortSignal.timeout(ms) }),
    (ms) => fetch(`${RELAY}/scrape`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, formats }), signal: AbortSignal.timeout(ms) }), 50000);
  if (!d) { steps.push({ tool: "scrape", ok: false, label: `Page content · ${url.replace(SITE, "")}`, detail: err, ms: Date.now() - t }); return null; }
  const md = d?.data?.markdown || "", html = d?.data?.rawHtml || "";
  const out = formats.includes("rawHtml") ? jsonld(url, html, d?.data?.metadata?.title)
    : (md ? { url, title: d?.data?.metadata?.title, headings: (md.match(/^#{1,3} .+$/gm) || []).map((h) => h.replace(/^#+\s*/, "")).slice(0, 40), excerpt: md.slice(0, 2500), words: md.split(/\s+/).length } : null);
  steps.push({ tool: "scrape", ok: !!out, label: `Page content · ${url.replace(SITE, "")}`, detail: out ? `${(md || html).length} chars` : "no content", ms: Date.now() - t });
  if (out) await cachePut(env, key, out);
  return out;
}
function jsonld(url, html, title) {
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => { try { return JSON.parse(m[1].trim()); } catch { return null; } }).filter(Boolean);
  const flat = blocks.flatMap((b) => (b["@graph"] ? b["@graph"] : [b]));
  const types = [...new Set(flat.map((b) => [].concat(b["@type"] || "?").join("/")))];
  const issues = [];
  for (const b of flat) { const ty = [].concat(b["@type"] || "");
    if (ty.includes("FAQPage") && !(b.mainEntity || []).length) issues.push("FAQPage has no questions");
    if (ty.includes("BreadcrumbList") && !(b.itemListElement || []).length) issues.push("BreadcrumbList has no items");
    if (ty.some((x) => /Product|FinancialProduct|Offer/.test(x)) && !(b.offers || b.price)) issues.push(`${ty.join("/")} has no price/offers`);
    if (ty.some((x) => /Article|BlogPosting/.test(x))) { if (!b.author) issues.push("Article has no author"); if (!b.dateModified && !b.datePublished) issues.push("Article has no dates"); } }
  return { url, title, types, count: flat.length, issues: [...new Set(issues)], sample: JSON.stringify(flat[0] || null).slice(0, 600) };
}
const fetchXml = async (u) => (await fetch(u, { headers: { "user-agent": "seo-copilot" }, signal: AbortSignal.timeout(20000) })).text();
const xtag = (x, t) => (x.match(new RegExp(`<${t}>(.*?)</${t}>`)) || [])[1];
async function sitemapRecent(domain, steps, days = 45) {
  const t = Date.now(); const dom = String(domain).replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  try {
    const xml = await fetchXml(`https://${dom}/sitemap.xml`); let rows = [], kids = 0;
    const parse = (x, fb) => [...x.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => ({ url: xtag(m[1], "loc"), lastmod: xtag(m[1], "lastmod") || fb })).filter((e) => e.url);
    if (/<sitemapindex/.test(xml)) {
      const kidsArr = [...xml.matchAll(/<sitemap>([\s\S]*?)<\/sitemap>/g)].map((m) => ({ loc: xtag(m[1], "loc"), lastmod: xtag(m[1], "lastmod") })).filter((k) => k.loc)
        .sort((a, b) => (Date.parse(b.lastmod) || 0) - (Date.parse(a.lastmod) || 0)).slice(0, 14);
      kids = kidsArr.length; rows = (await Promise.all(kidsArr.map(async (k) => { try { return parse(await fetchXml(k.loc), k.lastmod); } catch { return []; } }))).flat();
    } else rows = parse(xml);
    const cutoff = Date.now() - days * 864e5;
    const recent = rows.filter((e) => e.lastmod && Date.parse(e.lastmod) >= cutoff).sort((a, b) => Date.parse(b.lastmod) - Date.parse(a.lastmod));
    steps.push({ tool: "sitemap", ok: true, label: `${dom} sitemap`, detail: `${recent.length} changed in ${days}d of ${rows.length}${kids ? ` · ${kids} child maps` : ""}`, ms: Date.now() - t });
    return { recent, total: rows.length, dom };
  } catch (e) { steps.push({ tool: "sitemap", ok: false, label: `${dom} sitemap`, detail: e.message, ms: Date.now() - t }); return { recent: [], total: 0, dom }; }
}
async function ahrefs(env, path, params, steps, label) {
  const key = `ah:${path}:${JSON.stringify(params)}`; const c = await cacheGet(env, key, 7); const t = Date.now();
  if (c) { steps.push({ tool: "ahrefs", ok: true, label, detail: "cached · 0 units", ms: 0 }); return c; }
  const qs = new URLSearchParams(params).toString();
  const { d, err } = await viaRelay((ms) => fetch(`https://api.ahrefs.com/v3/${path}?${qs}`, { headers: { authorization: `Bearer ${keys().ahrefs}`, accept: "application/json" }, signal: AbortSignal.timeout(ms) }),
    (ms) => fetch(`${RELAY}/ahrefs?path=${encodeURIComponent(path)}&${qs}`, { signal: AbortSignal.timeout(ms) }));
  if (!d || d.error) { steps.push({ tool: "ahrefs", ok: false, label, detail: d?.error || err, ms: Date.now() - t }); return null; }
  steps.push({ tool: "ahrefs", ok: true, label, detail: "live", ms: Date.now() - t }); await cachePut(env, key, d); return d;
}
async function bingApi(env, method, steps) {
  const key = `bing:${method}`; const c = await cacheGet(env, key, 1); const t = Date.now();
  if (c) { steps.push({ tool: "bing", ok: true, label: `Bing · ${method}`, detail: "cached", ms: 0 }); return c; }
  const qs = `siteUrl=${encodeURIComponent(SITE + "/")}`;
  const { d, err } = await viaRelay((ms) => fetch(`https://ssl.bing.com/webmaster/api.svc/json/${method}?apikey=${keys().bing}&${qs}`, { signal: AbortSignal.timeout(ms) }),
    (ms) => fetch(`${RELAY}/bing?method=${method}&${qs}`, { signal: AbortSignal.timeout(ms) }));
  if (!d || d.ErrorCode !== undefined) { steps.push({ tool: "bing", ok: false, label: `Bing · ${method}`, detail: d?.Message || err, ms: Date.now() - t }); return null; }
  steps.push({ tool: "bing", ok: true, label: `Bing · ${method}`, detail: `${(d.d || []).length} rows`, ms: Date.now() - t }); await cachePut(env, key, d.d); return d.d;
}
async function newsFor(env, q, steps) {
  const key = `news:${q}`; const c = await cacheGet(env, key, 1); const t = Date.now();
  if (c) { steps.push({ tool: "news", ok: true, label: `News · ${q}`, detail: "cached", ms: 0 }); return c; }
  const { d, err } = await viaRelay((ms) => fetch(`https://serpapi.com/search.json?engine=google_news&q=${encodeURIComponent(q)}&gl=in&hl=en&api_key=${keys().serpapi}`, { signal: AbortSignal.timeout(ms) }),
    (ms) => fetch(`${RELAY}/serp?engine=google_news&q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(ms) }), 25000);
  if (!d) { steps.push({ tool: "news", ok: false, label: `News · ${q}`, detail: err, ms: Date.now() - t }); return []; }
  const items = (d.news_results || []).slice(0, 10).map((n) => ({ headline: n.title, source: n.source?.name || n.source || "", date: (n.date || "").split(",")[0] }));
  steps.push({ tool: "news", ok: true, label: `News · ${q}`, detail: `${items.length} stories`, ms: Date.now() - t }); await cachePut(env, key, items); return items;
}
const pathOf = (u) => String(u || "").replace(SITE, "") || "/";
// a competitor brand's own name, from its domain, plus any brand terms the caller passes
const competitorBrands = (domain) => {
  const stem = String(domain || "").replace(/^https?:\/\//, "").replace(/^www\./, "").split(".")[0];
  return stem ? [stem, stem.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()] : [];
};
const domainIn = (q, fb = "") => (q || "").match(/([a-z0-9-]+\.(?:com|in|co\.in|net|org))/i)?.[1] || fb;
const quotedIn = (q, fb) => (q || "").match(/["“](.+?)["”]/)?.[1] || fb;
const STOP = new Set(["the", "a", "an", "in", "for", "to", "of", "and", "or", "my", "how", "what", "is", "best", "online", "india", "check", "insurance"]);
const toks = (s) => String(s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));

/* ── tool-driven agents ── */
const TOOLKIT = {
  async backlink_gap(env, s, q, steps) {
    const comp = domainIn(q);
    const theirs = await ahrefs(env, "site-explorer/refdomains", { target: comp, mode: "subdomains", history: "live", select: "domain,domain_rating,links_to_target,is_spam", order_by: "domain_rating:desc", limit: 40, where: JSON.stringify({ and: [{ field: "is_spam", is: ["eq", false] }, { field: "domain_rating", is: ["gte", 30] }] }) }, steps, `Top referring domains · ${comp}`);
    const JUNK = /^(goo\.gl|bit\.ly|t\.co|tinyurl|lnkd\.in|ow\.ly|buff\.ly|rebrand\.ly|cutt\.ly|shorturl|w\.wiki|amp\.gs)$|\.gov(\.|$)|\.nic\.in$/i;
    const cand = (theirs?.refdomains || []).filter((r) => !JUNK.test(r.domain)); if (!cand.length) return { rows: [], meta: { competitor: comp, why_empty: `Ahrefs returned no non-spam referring domain above DR 30 for ${comp}, so there is no gap to report. Re-run naming a different competitor in the box.` } };
    // prove membership: ask Ahrefs which of exactly these domains link to us
    const mine = await ahrefs(env, "site-explorer/refdomains", { target: BARE(), mode: "subdomains", history: "live", select: "domain,links_to_target", limit: 1000,
      where: JSON.stringify({ or: cand.map((c) => ({ field: "domain", is: ["eq", c.domain] })) }) }, steps, `Which of those ${cand.length} link to us?`);
    if (!mine) return { rows: [], meta: { competitor: comp, incomplete: "Could not verify our own links; nothing claimed." } };
    const have = new Set((mine.refdomains || []).map((r) => r.domain));
    // platforms nobody can pitch for a link: chat apps, shorteners, app hosts
    const UNPITCHABLE = /(^|\.)(t\.me|telegram\.me|wa\.me|vercel\.app|netlify\.app|herokuapp\.com|firebaseapp\.com|web\.app|waze\.com|goo\.gl|bit\.ly|linktr\.ee|pinterest\.|facebook\.com|twitter\.com|x\.com|instagram\.com)$/i;
    return { rows: cand.filter((r) => !have.has(r.domain) && !UNPITCHABLE.test(r.domain)).slice(0, 25).map((r) => ({
        domain: r.domain, domain_rating: r.domain_rating, links_to_competitor: r.links_to_target,
        tier: r.domain_rating >= 70 ? "high authority — pitch first" : r.domain_rating >= 40 ? "mid authority" : "low authority" })),
      meta: { competitor: comp, candidates_checked: cand.length, of_those_already_linking_to_us: have.size } };
  },
  async link_prospects(env, s, q, steps) {
    const top = await runSql(env, s.TOPQ(1), steps, "Our biggest query");
    const topic = quotedIn(q, top[0]?.query || "car insurance");
    const serp = await serpFor(env, topic, steps);
    const NC = /\.gov\.|\.gov$|\.nic\.in|parivahan|police|wikipedia|\.edu/i;
    const sites = (serp?.top_organic || []).filter((o) => !isOurs(o.link) && !NC.test(o.link)).slice(0, 6);
    if (!sites.length) return { rows: [], meta: { topic, why_empty: `The top results for "${topic}" are government, police or encyclopedic sites, which never link out commercially — so there is no prospect to pitch here. Re-run naming a commercial query in the box.` } };
    const hosts = sites.map((o) => new URL(o.link).hostname.replace(/^www\./, ""));
    // do they already link to us? (must be checked before calling anything a "prospect")
    const linked = await ahrefs(env, "site-explorer/refdomains", { target: BARE(), mode: "subdomains", history: "live", select: "domain,links_to_target", limit: 1000,
      where: JSON.stringify({ or: hosts.map((h) => ({ field: "domain", is: ["substring", h] })) }) }, steps, "Do these sites already link to us?");
    if (!linked) return { rows: [], meta: { topic, incomplete: "Could not verify existing links; not showing prospects we may already have." } };
    const already = new Map((linked.refdomains || []).map((r) => [r.domain.replace(/^www\./, ""), r.links_to_target]));
    const drs = await Promise.all(hosts.map((h) => ahrefs(env, "site-explorer/domain-rating", { target: h, date: todayISO() }, steps, `DR · ${h}`)));
    return { rows: sites.map((o, i) => { const h = hosts[i], n = already.get(h);
      return { site: h, title: (o.title || "").slice(0, 60), position: o.position, domain_rating: drs[i]?.domain_rating?.domain_rating ?? null,
        already_links_to_us: n ? `yes — ${n} link${n > 1 ? "s" : ""}` : "no",
        diagnosis: n ? "already links to us — nurture, do not pitch" : "ranks for our topic, no link yet" }; }), meta: { topic } };
  },
  async keyword_gap(env, s, q, steps) {
    // Ahrefs shows what a rival ranks for. Search Console shows what WE actually get.
    // A gap is only claimed when Ahrefs proves their ranking AND our own data proves
    // we earn nothing — never from the agent's name.
    const comp = domainIn(q);
    const d = await ahrefs(env, "site-explorer/organic-keywords", { target: comp, country: "in", mode: "subdomains",
      date: todayISO(), select: "keyword,volume,best_position,best_position_url", order_by: "volume:desc", limit: 300,
      where: JSON.stringify({ and: [{ field: "best_position", is: ["lte", 10] }, { field: "volume", is: ["gte", 500] }] }) }, steps, `What ${comp} ranks for`);
    // RELEVANCE: a rival's keyword is only a gap for US if it is our business.
    // Policybazaar ranks for "gold rate today"; chasing that would be nonsense.
    // The vocabulary comes from the FIRST TWO path segments of our own pages —
    // those name the business (car-insurance, traffic-rules, rto). Deeper segments
    // are mostly city names, and matching on those let "gold rate today bangalore"
    // through on the word "bangalore".
    const vocabRows = await runSql(env, `SELECT DISTINCT
        lower(replace(substr(path, 2, CASE WHEN instr(substr(path,2),'/')>0
          THEN instr(substr(path,2),'/')-1 ELSE length(path) END), '-', ' ')) seg
      FROM page_universe WHERE tier=1`, steps, "Our own business vocabulary");
    const GEO_STOP = new Set(["delhi","mumbai","bangalore","bengaluru","hyderabad","chennai","kolkata","pune","ahmedabad","jaipur","lucknow","noida","gurgaon","gurugram","telangana","maharashtra","karnataka","kerala","gujarat","punjab","rajasthan","haryana","bihar","odisha","assam","goa","india","indian"]);
    const STOP = new Set(["the","and","for","with","your","that","from","this","online","check","how","what","best","new","top","guide","blogs","articles","info"]);
    const vocab = new Set();
    for (const r of vocabRows) for (const w of String(r.seg).split(/\s+/))
      if (w.length >= 4 && !STOP.has(w) && !GEO_STOP.has(w)) vocab.add(w);
    const relevant = (kw) => String(kw).toLowerCase().split(/\s+/).some((w) => w.length >= 4 && vocab.has(w));
    const allKws = (d?.keywords || []).filter((k) => k.keyword);
    // A rival's BRANDED query is not a gap — nobody outranks a brand for its own
    // name. "max life insurance" is their demand, not ours.
    // Competitor brand names are DERIVED from the user's own data: a query that a rival
    // ranks top-3 for, that we get no impressions on, and that contains a word from the
    // rival's own domain, is their brand term. No hardcoded industry list.
    const BRANDS = (competitorBrands(comp) || []);
    const brandWord = BARE().split(".")[0];
    const branded = (kw) => { const s = String(kw).toLowerCase(); return BRANDS.some((b) => s.includes(b)) && !(brandWord && s.includes(brandWord)); };
    const onTopic = allKws.filter((k) => relevant(k.keyword));
    const brandedOut = onTopic.filter((k) => branded(k.keyword)).length;
    const kws = onTopic.filter((k) => !branded(k.keyword));
    if (!allKws.length) return { rows: [], meta: { competitor: comp, why_empty: `Ahrefs returned no keyword for ${comp} ranking in the top 10 with 500+ monthly searches in India. Re-run naming a different competitor in the box.` } };
    if (!kws.length) return { rows: [], meta: { competitor: comp, why_empty: `${comp} ranks for ${allKws.length} high-volume keywords, but after removing off-topic subjects and their own branded queries, none is a gap we could realistically win.` } };
    // our own impressions for exactly these keywords, from Search Console
    const list = kws.slice(0, 300).map((k) => `'${String(k.keyword).replace(/'/g, "''")}'`).join(",");
    const mine = await runSql(env, `SELECT query, SUM(impressions) impressions, SUM(clicks) clicks,
        ROUND(SUM(position_in*impressions)/NULLIF(SUM(impressions),0),1) pos
      FROM query_daily WHERE date>'${s.from}' AND date<='${s.to}' AND query IN (${list}) GROUP BY query`, steps, "What we earn for those keywords");
    const ours = new Map(mine.map((r) => [r.query, r]));
    const rows = kws.map((k) => {
      const o = ours.get(k.keyword);
      return { keyword: k.keyword, monthly_volume: k.volume, their_position: k.best_position,
        their_page: String(k.best_position_url || "").replace(/^https?:\/\/(www\.)?/, "").slice(0, 52),
        our_impressions: o ? o.impressions : 0, our_position: o ? o.pos : null,
        diagnosis: !o ? "we earn nothing for this — no page of ours appears at all"
          : o.pos > 20 ? "we appear but far off page 1"
          : o.pos > 10 ? "we rank page 2 — closest to winnable"
          : "we already rank page 1 for this" };
    }).filter((r) => r.diagnosis !== "we already rank page 1 for this");
    rows.sort((a, b) => (b.monthly_volume || 0) - (a.monthly_volume || 0));
    const none = rows.filter((r) => r.our_impressions === 0).length;
    return { rows: rows.slice(0, 25), meta: { competitor: comp,
      keywords_checked: `${kws.length} usable of ${allKws.length} checked — ${allKws.length - onTopic.length} were off-topic for our business, ${brandedOut} were another insurer's branded query that nobody else can win`,
      we_earn_nothing_for: none, note: "Volume and their position come from Ahrefs. Our impressions and position come from Search Console for the same date range." } };
  },
  async content_audit(env, s, q, steps) {
    // A VERDICT agent: every row ends in keep / update / merge / kill.
    // "clicks down" is a measurement, not a decision, and may never appear here.
    // MERGE uses duplicate TITLES, not semantic similarity: the crawl does not
    // run near-duplicate analysis, so a similarity-based merge would be unprovable.
    const rows = await runSql(env, `WITH cur AS (SELECT url, SUM(clicks) c, SUM(impressions) i, SUM(position_in*impressions)/NULLIF(SUM(impressions),0) p
          FROM gsc_daily WHERE date>'${s.from}' AND date<='${s.to}'${s.segCol} GROUP BY url),
        prev AS (SELECT url, SUM(clicks) c, SUM(impressions) i, SUM(position_in*impressions)/NULLIF(SUM(impressions),0) p
          FROM gsc_daily WHERE date>'${s.prevFrom}' AND date<='${s.prevTo}'${s.segCol} GROUP BY url)
      SELECT u.url, u.path page, u.page_type, COALESCE(prev.c,0) clicks_before, COALESCE(cur.c,0) clicks_now,
        COALESCE(prev.c,0)-COALESCE(cur.c,0) clicks_lost, ROUND(prev.p,1) pos_before, ROUND(cur.p,1) pos_now,
        COALESCE(cp.word_count, pc.last_word_count) words, cp.title,
        CASE WHEN cur.p IS NULL THEN 'no impressions in the current period'
          WHEN cur.p-prev.p>=0.5 THEN 'lost ranking'
          WHEN COALESCE(cur.c,0)*1.0/NULLIF(cur.i,0) < prev.c*0.8/NULLIF(prev.i,0) THEN 'CTR fell, rank held'
          WHEN cur.i<prev.i*0.8 THEN 'search demand fell' ELSE 'mixed' END cause,
        (SELECT u2.path FROM crawl_pages c2 JOIN page_universe u2 ON u2.url=c2.url
          WHERE c2.title=cp.title AND cp.title<>'' AND c2.url<>u.url AND u2.tier=1
          ORDER BY u2.clicks_90 DESC LIMIT 1) twin_path,
        (SELECT u2.clicks_90 FROM crawl_pages c2 JOIN page_universe u2 ON u2.url=c2.url
          WHERE c2.title=cp.title AND cp.title<>'' AND c2.url<>u.url AND u2.tier=1
          ORDER BY u2.clicks_90 DESC LIMIT 1) twin_clicks
      FROM page_universe u
        LEFT JOIN cur ON cur.url=u.url LEFT JOIN prev ON prev.url=u.url
        LEFT JOIN crawl_pages cp ON cp.url=u.url LEFT JOIN page_content_changes pc ON pc.url=u.url
      -- the segment must filter the PAGES, not just the traffic rows. Without this
      -- the zero-click branch below let every priority page through any folder filter.
      WHERE u.tier=1${s.segU2} AND (COALESCE(prev.c,0)>=50 OR COALESCE(cur.c,0)=0)
      ORDER BY COALESCE(prev.c,0) DESC`, steps, "Traffic, rank, depth and duplicate titles");
    if (!rows.length) return { rows: [] };
    // Ahrefs: domains linking to each page. Killing a linked page destroys equity,
    // so this is a hard veto on the kill verdict, not a nice-to-have.
    const bl = await ahrefs(env, "site-explorer/pages-by-backlinks", { target: BARE(), mode: "subdomains", history: "live", select: "url_to,refdomains_target,url_rating_target", order_by: "refdomains_target:desc", limit: 1000 }, steps, "Ahrefs referring domains per page");
    const norm = (u) => String(u || "").replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();
    const links = new Map();
    for (const r of bl?.pages || []) { const k = norm(r.url_to); const p = links.get(k); if (!p || r.refdomains_target > p.rd) links.set(k, { rd: r.refdomains_target, ur: r.url_rating_target }); }
    const linksKnown = !!bl;
    const out = rows.map((r) => {
      const L = links.get(norm(r.url)) || { rd: 0, ur: null };
      const before = r.clicks_before || 0, now = r.clicks_now || 0;
      const dropPct = before > 0 ? Math.round(100 * (before - now) / before) : 0;
      const twin = r.twin_path && r.twin_path !== r.page && (r.twin_clicks || 0) > now;
      let verdict, why;
      if (twin) { verdict = `merge into ${r.twin_path}`; why = `identical title to a page earning more clicks`; }
      else if (now === 0 && r.words > 0 && r.words < 300 && linksKnown && L.rd === 0) { verdict = "kill"; why = `no clicks, ${r.words} words, no referring domains`; }
      else if (now === 0 && !(r.words > 0)) { verdict = "keep"; why = "no clicks, and the crawl never read this page — not assessable, check it manually"; }
      else if (dropPct >= 25) { verdict = "update"; why = `clicks fell ${dropPct}%${L.rd ? `; ${L.rd} referring domains make it worth saving` : ""}`; }
      else { verdict = "keep"; why = now >= before ? "clicks flat or up" : `clicks fell ${dropPct}%, under the 25% action line`; }
      if (verdict === "kill" && L.rd > 0) { verdict = "update"; why = `no clicks but ${L.rd} domains link here — rewrite, do not delete`; }
      return { page: r.page, page_type: r.page_type, clicks_before: before, clicks_now: now,
        clicks_lost: Math.max(0, before - now), pos_before: r.pos_before, pos_now: r.pos_now,
        words: r.words, referring_domains: linksKnown ? L.rd : "unchecked",
        cause: before > now ? r.cause : "not losing clicks", verdict, why };
    });
    const order = { kill: 0, merge: 1, "update": 2, keep: 4 };
    out.sort((a, b) => ((order[a.verdict.split(" ")[0]] ?? 3) - (order[b.verdict.split(" ")[0]] ?? 3)) || (b.clicks_lost - a.clicks_lost) || (b.clicks_before - a.clicks_before));
    const tally = out.reduce((m, r) => { const k = r.verdict.split(" ")[0]; m[k] = (m[k] || 0) + 1; return m; }, {});
    const absent = ["merge", "kill"].filter((v) => !tally[v]);
    return { rows: out.slice(0, 30), meta: { verdicts: tally,
      ...(absent.length ? { no_page_qualified_for: `${absent.join(" or ")} — checked every page in scope and none met the rule below` } : {}),
      rule: "merge = identical title to a stronger page; kill = no clicks, under 300 words, no referring domains; update = clicks down 25%+; keep = everything else. A page other sites link to is never killed.",
      not_assessed: "Semantic near-duplicates are not available — the nightly crawl does not run Screaming Frog's near-duplicate analysis, so merge is judged on identical titles only." } };
  },
  async lost_links(env, s, q, steps) {
    // Pull deep, then DEDUPE. One page published in 20 locales (…?locale=de, ?locale=fr)
    // is ONE lost link, not 20 — without this, a single source floods every row.
    const d = await ahrefs(env, "site-explorer/all-backlinks", { target: BARE(), mode: "subdomains", history: `since:${shift(todayISO(), -90)}`, select: "url_from,url_to,anchor,domain_rating_source,lost_reason,last_seen", order_by: "domain_rating_source:desc", limit: 400, where: JSON.stringify({ field: "is_lost", is: ["eq", true] }) }, steps, "Ahrefs lost backlinks");
    const bare = (u) => String(u || "").replace(/^https?:\/\//, "").replace(/[?#].*$/, "").replace(/\/$/, "");
    const host = (u) => bare(u).split("/")[0];
    const seen = new Set(), perDomain = new Map(), out = [];
    const all = (d?.backlinks || []).map((b) => ({ b, recoverable: /removedfromhtml/i.test(b.lost_reason || "") }))
      // a link we could actually win back outranks a dead page, whatever its DR
      .sort((x, y) => (y.recoverable - x.recoverable) || ((y.b.domain_rating_source || 0) - (x.b.domain_rating_source || 0)));
    for (const { b, recoverable } of all) {
      const key = bare(b.url_from) + " -> " + bare(b.url_to);
      if (seen.has(key)) continue;
      const h = host(b.url_from);
      const n = perDomain.get(h) || 0;
      if (n >= 3) continue;                       // no single domain may own the table
      seen.add(key); perDomain.set(h, n + 1);
      out.push({ referring_page: bare(b.url_from).slice(0, 70), our_page: pathOf(b.url_to), referring_dr: b.domain_rating_source,
        anchor: (b.anchor || "").slice(0, 40), lost_reason: b.lost_reason || "", lost_on: (b.last_seen || "").slice(0, 10),
        diagnosis: recoverable ? "link removed from a live page — worth an email" : "referring page is gone or redirected — low odds" });
      if (out.length >= 25) break;
    }
    const fetched = (d?.backlinks || []).length;
    // NEVER expose the API fetch ceiling as a count of findings — 400 is where we
    // stopped reading, not how many links were lost.
    return { rows: out, meta: {
      scanned: fetched >= 400 ? "the 400 highest-authority lost links (scan limit — the real total is higher and is not known here)" : `${fetched} lost links`,
      shown_after_deduplication: out.length,
      note: "Locale and query-string variants of one page are merged, and no single domain may hold more than 3 rows." } };
  },
  async anchors(env, s, q, steps) {
    const d = await ahrefs(env, "site-explorer/anchors", { target: BARE(), mode: "subdomains", history: "live", select: "anchor,links_to_target,refdomains", order_by: "links_to_target:desc", limit: 25 }, steps, "Ahrefs anchor text");
    // Share must be computed on REFERRING DOMAINS. Raw link counts let one sitewide
    // footer link ("Group company", 353,763 links from one site) masquerade as
    // site-wide over-optimisation risk.
    const rows = (d?.anchors || []).filter((r) => (r.refdomains ?? 0) > 0);
    const tot = rows.reduce((a, r) => a + (r.refdomains || 0), 0) || 1;
    const sorted = [...rows].sort((a, b) => (b.refdomains || 0) - (a.refdomains || 0));
    return { rows: sorted.slice(0, 25).map((r) => { const share = Math.round(1000 * (r.refdomains || 0) / tot) / 10;
      return { anchor: (r.anchor || "(empty)").slice(0, 45), referring_domains: r.refdomains, links: r.links_to_target,
        share_of_domains_pct: share,
        diagnosis: (BARE().split(".")[0] && new RegExp(BARE().split(".")[0], "i").test(r.anchor)) ? "branded — healthy" : share > 5 ? "high share of linking domains, non-branded — watch for over-optimisation" : "descriptive" }; }),
      meta: { basis: `Share is of the ${tot} referring domains across these anchors, not of raw link counts — one sitewide footer link is a single relationship, not thousands of votes.` } };
  },
  async toxic_links(env, s, q, steps) {
    const d = await ahrefs(env, "site-explorer/refdomains", { target: BARE(), mode: "subdomains", history: "live", select: "domain,domain_rating,links_to_target,is_spam", order_by: "links_to_target:desc", limit: 60, where: JSON.stringify({ or: [{ field: "is_spam", is: ["eq", true] }, { field: "domain_rating", is: ["lt", 5] }] }) }, steps, "Ahrefs spam/low-DR domains");
    // A high-authority host (firebaseapp.com, github.io, blogspot) carries a spam
    // flag because of what OTHER people publish on it. Disavowing Google's own
    // hosting would be actively harmful, so authority vetoes the spam flag.
    const PLATFORM = /(^|\.)(firebaseapp\.com|web\.app|github\.io|blogspot\.|wordpress\.com|medium\.com|wixsite\.com|weebly\.com|herokuapp\.com|netlify\.app|vercel\.app|appspot\.com|amazonaws\.com|cloudfront\.net|notion\.site|substack\.com)$/i;
    const all = (d?.refdomains || []).map((r) => {
      const dr = r.domain_rating ?? 0, plat = PLATFORM.test(r.domain);
      if (plat) return { ...r, verdict: `shared hosting platform (DR ${dr}) — the platform is not spam, check the individual page before acting` };
      if (r.is_spam && dr < 30) return { ...r, verdict: "flagged spam and low authority — worth disavowing" };
      if (r.is_spam) return { ...r, verdict: `flagged spam but DR ${dr} — verify before disavowing, authority this high is rarely junk` };
      return { ...r, verdict: "very low authority — usually ignorable" };
    });
    return { rows: all.slice(0, 25).map((r) => ({ domain: r.domain, domain_rating: r.domain_rating, links: r.links_to_target, diagnosis: r.verdict })),
      meta: { note: "Ahrefs flags a domain as spam from its whole profile. A shared host can be flagged for other people's pages, so authority overrides the flag here." } };
  },
  async schema_audit(env, s, q, steps) {
    const pages = await runSql(env, `SELECT url, path, page_type, impressions_90 impressions FROM page_universe WHERE tier=1 AND page_type<>'support'${s.segU} ORDER BY impressions_90 DESC LIMIT 6`, steps, "Top pages + product hubs");
    const ld = await Promise.all(pages.map((p) => scrape(env, p.url, steps, ["rawHtml"])));
    const rows = pages.map((p, i) => {
      if (!ld[i]) return { page: p.path, page_type: p.page_type, impressions: p.impressions, schema_found: "unchecked", schema_missing: "unchecked", issues: "unchecked", diagnosis: "could not read this page — not assessed" };
      const found = ld[i]?.types || [], req = SCHEMA_RULES[p.page_type] || [];
      const missing = req.filter((r) => !r.split("|").some((t) => found.some((f) => f.includes(t))));
      return { page: p.path, page_type: p.page_type, impressions: p.impressions, schema_found: found.join(", ") || "none", schema_missing: missing.join(", ") || "—", issues: (ld[i]?.issues || []).join("; ") || "—",
        diagnosis: !found.length ? "no structured data found" : missing.length ? `missing ${missing.length} required type${missing.length > 1 ? "s" : ""} for a ${p.page_type.replace("_", " ")}` : (ld[i]?.issues || []).length ? "markup present, has faults" : "complete" };
    });
    // the agent promises pages MISSING required schema — return only those, and say
    // plainly how many were checked and found complete
    const bad = rows.filter((r) => /missing|no structured data|has faults/.test(r.diagnosis));
    const okCount = rows.length - bad.length;
    return { rows: bad, meta: { rules: SCHEMA_RULES, pages_checked: rows.length, already_complete: okCount,
      ...(bad.length ? {} : { why_empty: `Checked the ${rows.length} highest-traffic pages and every one already carries the structured data its page type requires.` }) } };
  },
  async faq_schema(env, s, q, steps) {
    const top = await runSql(env, s.TOPQ(1), steps, "Our biggest query");
    const topic = quotedIn(q, top[0]?.query || "car insurance");
    const serp = await serpFor(env, topic, steps);
    const paa = serp?.people_also_ask || [];
    return { rows: paa.map((question) => ({ question, query: topic, page: top[0]?.page || "", diagnosis: "real People-Also-Ask question — answer it on the page" })),
      meta: { topic, page: top[0]?.page, ...(paa.length ? {} : { why_empty: `Google showed no People-Also-Ask box for "${topic}", so there are no real questions to build FAQ schema from. Re-run naming a different query in the box.` }) } };
  },
  async product_schema(env, s, q, steps) {
    const pages = await runSql(env, `SELECT url, path, page_type, impressions_90 impressions FROM page_universe WHERE page_type='money_hub' AND impressions_90>0${s.segU} ORDER BY impressions_90 DESC LIMIT 4`, steps, "Product hubs");
    const ld = await Promise.all(pages.map((p) => scrape(env, p.url, steps, ["rawHtml"])));
    return { rows: pages.map((p, i) => { if (!ld[i]) return { page: p.path, impressions: p.impressions, schema_found: "unchecked", issues: "unchecked", diagnosis: "could not read this page — not assessed" };
      const found = ld[i].types || [];
      const hasProduct = found.some((f) => /Product|FinancialProduct|Offer|Service/.test(f));
      return { page: p.path, impressions: p.impressions, schema_found: found.join(", ") || "none", issues: (ld[i].issues || []).join("; ") || "—", diagnosis: !hasProduct ? "no Product/Offer markup found" : (ld[i].issues || []).some((x) => /price|offer/i.test(x)) ? "Product markup found but it has no price or offers" : "Product/Offer markup found" }; }) };
  },
  async robots(env, s, q, steps) {
    const t = Date.now(); let txt = "";
    try { txt = await (await fetch(`${SITE}/robots.txt`, { signal: AbortSignal.timeout(15000) })).text(); steps.push({ tool: "fetch", ok: true, label: "robots.txt", detail: `${txt.split("\n").length} lines`, ms: Date.now() - t }); }
    catch (e) { steps.push({ tool: "fetch", ok: false, label: "robots.txt", detail: e.message, ms: Date.now() - t }); }
    const blocked = await runSql(env, `SELECT u.path page, u.impressions_90 impressions, cp.indexability_status cause, 'blocked but earns impressions' diagnosis FROM page_universe u JOIN crawl_pages cp ON cp.url=u.url WHERE cp.indexability_status LIKE '%obots%' AND u.impressions_90>0 ORDER BY u.impressions_90 DESC LIMIT 8`, steps, "Blocked pages with traffic");
    return { rows: blocked, meta: { robots_txt: txt.slice(0, 3000) } };
  },
  async content_gap(env, s, q, steps) {
    const top = await runSql(env, s.TOPQ(1), steps, "Our biggest query");
    const topic = quotedIn(q, top[0]?.query || "car insurance");
    const serp = await serpFor(env, topic, steps);
    const org = serp?.top_organic || [];
    const NONCOMMERCIAL = /\.gov\.|\.gov$|\.nic\.in|parivahan|police|rto\.|\.edu|wikipedia/i;
    const rivals = org.filter((o) => !isOurs(o.link) && !NONCOMMERCIAL.test(o.link));
    let comp = null;
    for (const c of rivals.slice(0, 2)) { comp = await scrape(env, c.link, steps); if (comp) break; }
    if (!rivals.length) return { rows: [], meta: { topic, why_empty: `The top results for "${topic}" are government/regulator sites, not content competitors — there is no comparable page to diff against. Re-run naming a commercial query in the box.` } };
    const oursUrl = (org.find((o) => isOurs(o.link)) || {}).link || (top[0]?.page ? SITE + top[0].page : null);
    const ours = oursUrl ? await scrape(env, oursUrl, steps) : null;
    if (!comp) return { rows: [], meta: { topic, incomplete: "Could not read the competitor page." } };
    if (!ours) return { rows: [], meta: { topic, competitor: comp?.url, incomplete: "Could not read OUR page, so a section cannot be called missing. Nothing claimed." } };
    const mine = new Set((ours.headings || []).map((h) => h.toLowerCase()));
    const rows = (comp?.headings || []).filter((h) => h.length > 8).map((h) => ({ section: h.slice(0, 80), on_their_page: "yes", on_our_page: mine.has(h.toLowerCase()) ? "yes" : "no" }))
      .filter((r) => r.on_our_page === "no").slice(0, 25).map((r) => ({ ...r, diagnosis: "they cover it, we don't" }));
    return { rows, meta: { topic, competitor: comp?.url, our_page: oursUrl, paa: serp?.people_also_ask || [] } };
  },
  async readability(env, s, q, steps) {
    const url = (q || "").match(/https?:\/\/\S+/)?.[0] || (await runSql(env, `SELECT url FROM page_universe WHERE tier=1 ORDER BY clicks_90 DESC LIMIT 1`, steps, "Top page"))[0]?.url;
    const p = url && await scrape(env, url, steps);
    if (!p) return { rows: [] };
    const clean = p.excerpt.replace(/[\u200B-\u200D\uFEFF\u2060]/g, "");
    const sentences = clean.split(/[.!?]+/).filter((x) => x.trim().length > 20);
    const rows = sentences.map((x) => ({ passage: x.trim().slice(0, 140), words: x.trim().split(/\s+/).length })).filter((r) => r.words >= 28)
      .sort((a, b) => b.words - a.words).slice(0, 15).map((r) => ({ ...r, diagnosis: r.words > 40 ? "very long sentence — split it" : "long sentence" }));
    return { rows: rows.map((r) => ({ page: pathOf(url), ...r })), meta: { url, words: p.words, headings: p.headings.length } };
  },
  async bing(env, s, q, steps) {
    const [issues, traffic] = await Promise.all([bingApi(env, "GetCrawlIssues", steps), runSql(env, `SELECT url, path, impressions_90 FROM page_universe WHERE impressions_90>0`, steps, "Our traffic pages")]);
    const norm = (u) => String(u || "").toLowerCase().replace(/^https?:\/\//, "").replace(/\?.*$/, "").replace(/\/$/, "");
    const map = new Map(traffic.map((r) => [norm(r.url), r]));
    const rows = (issues || []).filter((i) => map.has(norm(i.Url))).map((i) => ({ page: map.get(norm(i.Url)).path, google_impressions: map.get(norm(i.Url)).impressions_90, bing_code: i.HttpCode || "—", inlinks: i.InLinks, diagnosis: i.HttpCode >= 400 ? "Bing sees an error on a page Google ranks" : "Bing flagged crawl issues" }))
      .sort((a, b) => b.google_impressions - a.google_impressions).slice(0, 25);
    return { rows, meta: { bing_issue_urls: (issues || []).length, our_traffic_pages_checked: traffic.length,
      ...(rows.length ? {} : { why_empty: `Bing reports ${(issues || []).length} URLs with crawl issues, but none of them are pages that earn Google traffic — they are assets and legacy endpoints. Nothing to fix for SEO.` }) } };
  },
  async news(env, s, q, steps) {
    const queries = s.seg ? [`${s.seg.replace(/\//g, " ").trim()} india`, "IRDAI"] : ["insurance india", "IRDAI regulation", "motor vehicle rules india"];
    const [all, mine] = await Promise.all([Promise.all(queries.map((x) => newsFor(env, x, steps))).then((r) => r.flat()),
      runSql(env, `SELECT query FROM query_daily WHERE date>'${s.from}' AND date<='${s.to}' GROUP BY query ORDER BY SUM(impressions) DESC LIMIT 60`, steps, "Our top queries (relevance gate)")]);
    const bag = new Set(mine.flatMap((r) => toks(r.query))); const seen = new Set();
    const rows = all.filter((n) => n.headline && !seen.has(n.headline) && seen.add(n.headline))
      .map((n) => { const hits = [...new Set(toks(n.headline).filter((w) => bag.has(w)))];
        return { ...n, matches_our_queries: hits.length ? hits.slice(0, 4).join(", ") : "none", diagnosis: hits.length >= 2 ? "overlaps topics we already rank for" : hits.length === 1 ? "loose topic overlap" : "no overlap with our queries" }; })
      .sort((a, b) => (b.matches_our_queries !== "none") - (a.matches_our_queries !== "none")).slice(0, 25);
    return { rows };
  },
  async competitor(env, s, q, steps) {
    const dom = domainIn(q);
    const [sm, mine] = await Promise.all([sitemapRecent(dom, steps), runSql(env, `SELECT query FROM query_daily WHERE date>'${s.from}' AND date<='${s.to}' GROUP BY query ORDER BY SUM(impressions) DESC LIMIT 40`, steps, "Our top 40 queries")]);
    const bag = new Set(mine.flatMap((r) => toks(r.query)));
    const scored = sm.recent.map((e) => { const t = toks(decodeURIComponent(e.url).replace(/https?:\/\/[^/]+/, "").replace(/[-/]/g, " "));
      const hits = [...new Set(t.filter((w) => bag.has(w)))]; return { ...e, hits }; }).filter((e) => e.hits.length >= 2)
      .sort((a, b) => b.hits.length - a.hits.length).slice(0, 25);
    return { rows: scored.map((e) => ({ page: e.url.replace(/^https?:\/\/[^/]+/, ""), lastmod: e.lastmod, matched: e.hits.slice(0, 4).join(", "), diagnosis: "overlaps queries we rank for" })),
      meta: { competitor: dom, changed_total: sm.recent.length, sitemap_total: sm.total } };
  },
};

/* ── LLM contract: headline + ONE action + deliverable. No per-row notes. ── */
const outSchema = (need) => { // need: false | "code" | "items"
  const deliverable = { type: "OBJECT", description: "the paste-ready deliverable", properties: {
    title: { type: "STRING", description: "what this is and which page it is for" },
    content: { type: "STRING", description: "complete paste-ready code or text (JSON-LD, corrected file, numbered plan)" },
    items: { type: "ARRAY", description: "one entry per finding row", items: { type: "OBJECT", properties: {
      label: { type: "STRING", description: "the page path from that row" }, before: { type: "STRING", description: "current text, or empty" },
      after: { type: "STRING", description: "your rewrite" }, note: { type: "STRING", description: "one short reason" } }, required: ["label", "after"] } },
  }, required: need === "items" ? ["title", "items"] : need === "code" ? ["title", "content"] : [] };
  const props = {
    clean: { type: "BOOLEAN", description: "true only if the findings show nothing worth acting on" },
    headline: { type: "STRING", description: "ONE sentence, max 22 words, plain English, states the finding not the method" },
    action: { type: "OBJECT", properties: {
      title: { type: "STRING", description: "the single next action, imperative, max 12 words" },
      page: { type: "STRING", description: "the exact page path or query from the findings this applies to" },
      why: { type: "STRING", description: "1-2 sentences. Every number must appear in the findings." },
      impact: { type: "STRING", description: "the headline number from the findings with its label; empty if none" },
    }, required: ["title", "why"] },
  };
  if (need) props.deliverable = deliverable;
  return { type: "OBJECT", properties: props, required: need ? ["clean", "headline", "action", "deliverable"] : ["clean", "headline", "action"] };
};

const SYSTEM = `You are a senior SEO analyst for the website under review. You receive FINDINGS already computed from real Search Console, Screaming Frog crawl, SERP, Ahrefs and Bing data. A "diagnosis"/"verdict"/"cause" column is already computed — trust it, do not re-derive it.
RULES:
- Use ONLY the findings. Every number you write must appear verbatim in them. Never estimate or invent.
- Do not restate a row. The user can read the table. Add the judgement the table cannot show.
- Exactly ONE action, naming a specific page/query from the findings.
- Deliverables must be complete and paste-ready (valid JSON-LD, full robots.txt, real titles under 60 chars).
- NEVER claim something does not exist, is missing, is untargeted, or is an opportunity unless a column in the findings explicitly proves it. If a column says "unchecked", treat it as unknown — say so, never as absence.
- The ACTION VERB must match the computed diagnosis. If the diagnosis says a page/ranking already exists, the action is to IMPROVE it — never to "create" it. Never contradict a findings column.
- Columns marked (est.) are modelled estimates, not measurements. Call them estimates; never state them as observed fact.
- The diagnosis column states a MEASUREMENT, not a cause. Never upgrade it into a cause (e.g. a page ranking below page 1 does NOT mean it is "the wrong page" or "a poor fit" — say only what was measured). If you do not know why, say what is observed and stop.
- Terse, concrete, no preamble, no marketing language.`;

function nums(obj) { const set = new Set(); const add = (v) => { if (v == null || typeof v === "object") return; (String(v).match(/-?\d[\d,]*\.?\d*/g) || []).forEach((n) => { const c = n.replace(/,/g, "");
    for (const x of [c, String(Math.round(+c)), String(Math.abs(+c)), String(Math.abs(Math.round(+c)))]) set.add(x); }); };
  const walk = (x) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === "object") Object.values(x).forEach(walk); else add(x); }; walk(obj); return set; }
function ground(action, set) {
  const bad = (t) => (String(t || "").match(/-?\d[\d,]*\.?\d*/g) || []).filter((n) => { const c = n.replace(/,/g, ""); if (/^\d{1,2}$/.test(c) || /^(19|20)\d{2}$/.test(c)) return false; return !set.has(c) && !set.has(String(Math.round(+c))); });
  const all = [...new Set([...bad(action.title), ...bad(action.why), ...bad(action.impact)])];
  const esc = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (all.length) { if (bad(action.impact).length) action.impact = "";
    action.why = all.reduce((t, n) => t.replace(new RegExp(esc(n), "g"), "that figure"), action.why);
    action.title = all.reduce((t, n) => t.replace(new RegExp(esc(n), "g"), ""), action.title).replace(/\s{2,}/g, " ").trim(); }
  return all.length;
}
async function gemini(env, user, steps, schema) {
  const model = env.GEMINI_MODEL || "gemini-3.7-flash"; const t = Date.now();
  const body = JSON.stringify({ system_instruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 24576, responseMimeType: "application/json", responseSchema: schema } });
  // Gemini returns transient 429/500/503 under load. Retry with backoff so a
  // capacity blip never surfaces to the team as a failed agent.
  let d, last = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((res) => setTimeout(res, [0, 800, 2500, 6000][attempt]));
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${keys().gemini}`,
        { method: "POST", headers: { "content-type": "application/json" }, body });
      d = await r.json();
    } catch (e) { last = String(e.message || e); d = null; continue; }
    if (!d?.error) break;
    last = d.error.message || "call failed";
    const code = d.error.code || 0;
    if (!(code === 429 || code === 500 || code === 502 || code === 503 || /unavailable|overloaded|exhausted|internal/i.test(last))) break;
  }
  if (!d || d.error) throw new Error("Gemini: " + (last || "call failed"));
  const txt = d?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "{}";
  const finish = d?.candidates?.[0]?.finishReason || "";
  steps.push({ tool: "llm", ok: true, label: "Wrote the action", detail: `${model}${finish && finish !== "STOP" ? ` · ${finish}` : ""}`, ms: Date.now() - t });
  try { return JSON.parse(txt); } catch {
    // salvage a truncated object: close it at the last complete field
    for (const cut of [txt.lastIndexOf("},"), txt.lastIndexOf("\","), txt.lastIndexOf("}")]) {
      if (cut > 0) { for (const tail of ["}", "}}", "]}}", "}]}}"]) { try { return JSON.parse(txt.slice(0, cut + 1) + tail); } catch {} } }
    }
    throw new Error("model returned malformed JSON" + (finish ? ` (${finish})` : ""));
  }
}


/* ── Ask anything: when no agent fits, answer straight from the data ──────────
   The 24 agents are curated questions. This is the escape hatch for every other
   question Search Console could answer. The model writes ONE read-only SELECT
   against the schema below; the guard rejects anything that is not a plain read,
   and the numbers come from the database, never from the model. */
const ASK_SCHEMA = `
gsc_daily(date TEXT 'YYYY-MM-DD', url TEXT, segment TEXT, clicks INT, impressions INT, ctr REAL, position_in REAL)
  -- one row per URL per day. position_in is the average rank. ctr is a fraction (0.031 = 3.1%).
query_daily(date TEXT, query TEXT, segment TEXT, clicks INT, impressions INT, ctr REAL, position_in REAL)
  -- one row per SEARCH QUERY per day. Use this for anything about keywords/queries.
url_keywords(url TEXT, query TEXT, segment TEXT, clicks INT, impressions INT, ctr REAL, position_in REAL)
  -- which queries each URL ranks for (no date column — it is a 90-day snapshot).
page_universe(url TEXT, path TEXT, page_type TEXT, tier INT, clicks_90 INT, impressions_90 INT, pos REAL, clicks_prev90 INT)
  -- our page list. tier=1 is the ~145 priority pages. path is the URL without the domain.
crawl_pages(url TEXT, status_code INT, indexability TEXT, title TEXT, meta_desc TEXT, h1 TEXT,
  word_count INT, crawl_depth INT, inlinks INT, response_time REAL, flesch REAL, h2_1 TEXT)
  -- latest site crawl.
cms_published(url TEXT, created TEXT 'YYYY-MM-DD', collection TEXT)  -- when a page was first published.

RULES
- Average a position across days as SUM(position_in*impressions)/NULLIF(SUM(impressions),0), never AVG(position_in).
- A LOWER position number is BETTER. "improved by 2" means the number fell by 2.
- CTR is a fraction: multiply by 100 to show a percentage.
- Always filter dates. Data runs to \${MAXD}.
- Join a URL to its path with: JOIN page_universe u ON u.url = g.url
- Alias every output column to a clear snake_case name. Return at most 25 rows.
- Sort so the most important row is first.`;

const READONLY = (sql) => {
  const s = String(sql || "").trim().replace(/;+\s*$/, "");
  if (!/^(WITH|SELECT)\b/i.test(s)) return "must start with SELECT or WITH";
  if (/;/.test(s)) return "must be a single statement";
  if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|PRAGMA|VACUUM)\b/i.test(s)) return "must be read-only";
  return null;
};

// One planner call sees the CONVERSATION, not just the latest sentence. It decides
// whether a curated agent answers the question, or writes the SQL itself — and for a
// follow-up ("show me such top 5", "now by page", "same but last month") it refines
// the previous query instead of starting from a blank slate. This is what makes
// "such" mean something.
async function plan(env, { question, history, from, to, segment, maxd, mind, ptypes, steps, retry }) {
  const followUp = Array.isArray(history) && history.length > 0;
  const menu = Object.entries(AGENTS).filter(([, a]) => !a.off)
    .map(([k, a]) => `${k}: ${a.name} — ${a.purpose} (scope: ${a.scope})`).join("\n");
  const turns = (history || []).slice(-6).map((h, i) =>
    `[${i + 1}] USER: ${h.question}\n    TOOL: ${h.answer || ""}${h.sql ? `\n    SQL USED: ${h.sql}` : ""}`).join("\n");
  const prompt =
`You are the query planner for an SEO tool. Work out what the user wants and choose ONE of three modes.

CONVERSATION SO FAR (oldest first — the newest question may refer back to these):
${turns || "(none — this is the first question)"}

NEW QUESTION: "${question}"

Resolve every pronoun and reference ("such", "those", "them", "same", "now by page", "top 5 of that")
against the conversation. A follow-up KEEPS the previous filters, dates and definitions unless the new
question changes them. If the previous turn used SQL, start from that SQL and adjust it.

MODE "agent": one of these curated agents genuinely answers the question AS ASKED. A near-miss is
worse than nothing. An agent about PAGES does not answer a question about QUERIES; an agent about
CLICKS does not answer one about POSITIONS or CTR; a fixed-window agent does not answer a question
that names its own dates.
${menu}

MODE "sql": write ONE read-only SQLite SELECT against this schema:
${ASK_SCHEMA.replace("${MAXD}", maxd)}
The date range selected in the UI is ${from} to ${to}. Use it ONLY when the question names no
period of its own. You are NOT limited to it: the tables hold every day from ${mind} to ${maxd},
so write whatever window the question needs. "Year over year" means this period against the same
dates a year earlier. "Last month" means the previous calendar month. Compute those dates
yourself rather than declining because the UI range is short.

Default to answering: daily clicks,
impressions, CTR and position exist for every page and query, so any comparison, threshold, count or
ranking is expressible with CTEs. "Week over week" = the last 7 days vs the 7 before. If the user
asks for a count and then for the items, the items query must use the SAME definition as the count.
Alias output columns clearly, return at most 25 rows, most important first.

Do not invent URL patterns. To filter by kind of page use page_universe.page_type, whose values on
this site are: ${ptypes}. To filter by section use page_universe.path with a LIKE on a real path
prefix. If a question names a section you cannot see in those values, say so rather than guessing
a pattern that matches nothing.

Switching dimension is ALWAYS answerable: "the same for pages" means re-run the previous
definition against gsc_daily grouped by url instead of query_daily grouped by query (and vice
versa). Never decline a request to change the grouping, period, threshold or sort of a previous query.

MODE "none": when the data to answer simply is not in these tables. These tables contain ONLY
what Google Search Console reports about our own site — impressions, clicks, CTR, position — plus
our own crawl. They do NOT contain: total market search volume, competitor rankings, backlinks or
referring domains, revenue or conversions, device or country breakdowns, or anything about a site
we do not own. If the question needs one of those, answer "none" and name what is missing. Do this
even mid-conversation: a follow-up about a different subject is still unanswerable if the data is
absent, and returning a plausible-looking number instead would be a lie.

${followUp
  ? `There IS conversation history. Use it ONLY when the new question refers back to it — "those",
"the same", "top 5 of that", "only the ones". In that case refine the previous query.
If the new question stands on its own, IGNORE the history completely. A question like "top 10
queries by impressions" is answerable from query_daily no matter what was asked before, and must
not be refused because an earlier turn was about something else. Judge each self-contained
question purely on whether the TABLES ABOVE hold the data.`
  : ""}
${retry ? `
Your previous attempt returned nothing usable. Produce the SQL this time — refine the last SQL in the conversation if there is one.` : ""}

Also return "window": the date period the answer actually covers, in plain words.`;
  return gemini(env, prompt, steps, { type: "object", properties: {
      mode: { type: "string", enum: ["agent", "sql", "none"] },
      agent: { type: "string" },
      sql: { type: "string" },
      title: { type: "string", description: "plain-English statement of what is being returned, with any thresholds you chose" },
      window: { type: "string" },
      missing: { type: "string" },
      resolved_question: { type: "string", description: "the question with all references filled in" },
    // `sql` is REQUIRED so the model cannot pick mode "sql" and then omit the query.
    // For mode "agent" or "none" it returns an empty string.
    }, required: ["mode", "sql", "title", "resolved_question"] });
}

/* ── run ── */
async function runAgent(env, key, s, question, steps, dry) {
  const a = AGENTS[key]; let rows = [], extras = {}, meta = {};
  if (a.tool) { const out = await TOOLKIT[a.tool](env, s, question, steps); rows = out.rows || []; meta = out.meta || {}; }
  else {
    const p = runSql(env, a.sql(s), steps, "Evidence");
    const ex = a.extra ? Object.entries(a.extra(s)).map(async ([k, q]) => [k, await runSql(env, q, steps, titleCase(k))]) : [];
    rows = await p; for (const [k, v] of await Promise.all(ex)) extras[k] = v;
    if (key === "internal_linking") {
      // pair each target with a source in the SAME site section, then drop the rows
      // we cannot pair. Doing this BEFORE the model runs means the action can never
      // name a page that is not in the table.
      const sec = (x) => (String(x || "").split("/").filter(Boolean)[0] || "");
      const srcs = (extras.link_from_these || []).map((r) => r.page).filter(Boolean);
      const used = new Set();
      rows = rows.map((r) => {
        const from = srcs.find((x) => x !== r.page && sec(x) === sec(r.page) && !used.has(x + ">" + r.page));
        if (!from || !r.top_query) return null;
        used.add(from + ">" + r.page);
        return { ...r, link_from: from, suggested_anchor: r.top_query };
      }).filter(Boolean);
    }
    if (!dry && a.enrich && rows.length) {
      const keys = [...new Set(rows.map((r) => r[a.enrich.on]).filter(Boolean))].slice(0, a.enrich.n);
      const serps = await Promise.all(keys.map((q) => serpFor(env, q, steps).then((f) => ({ query: q, f }))));
      extras.serp_features = serps.filter((x) => x.f).map(({ query, f }) => ({ query, ai_overview: f.has_ai_overview ? "yes" : "no", featured_snippet: f.has_answer_box ? "yes" : "no", ads_on_top: f.ads_top === null ? "not reported by the SERP API" : f.ads_top, top_result: (f.top_organic?.[0]?.link || "").replace(/^https?:\/\//, "").slice(0, 45), diagnosis: f.has_answer_box ? "snippet takes the click" : f.has_ai_overview ? "AI Overview sits above the organic results" : "no snippet or AI Overview on this query" }));
    }
  }
  return { rows, extras, meta };
}

export async function onRequestGet({ env }) {
  await loadSite(env);
  await loadKeys(env);
  const fresh = await env.DB.prepare(`SELECT (SELECT MAX(date) FROM gsc_daily) gsc, (SELECT MAX(crawled_at) FROM crawl_pages) crawl, (SELECT MAX(built_at) FROM page_universe) universe, (SELECT COUNT(*) FROM page_universe WHERE tier=1) core`).first().catch(() => ({}));
  const LABEL = { ahrefs: "Ahrefs", serpapi: "SerpAPI", firecrawl: "Firecrawl", bing: "Bing" };
  return json({ site: getSite(), freshness: fresh, has_model: !!keys().gemini,
    agents: Object.entries(AGENTS).filter(([, a]) => !a.off).map(([key, a]) => {
      const need = SRC_KEY[a.src], ready = agentReady(a);
      return { key, n: a.n, section: a.section, name: a.name, purpose: a.purpose, scope: a.scope,
        layout: a.layout, src: a.src || null, deliverable: !!a.deliverable,
        // an agent without its key is shown but disabled, with the reason — never a broken run
        ready, needs: ready ? null : LABEL[need] || need };
    }) });
}

export async function onRequestPost({ env, request }) {
  await loadSite(env);
  await loadKeys(env);
  if (!getSite()) return json({ error: "No site configured yet. Open Config and set the site URL you want to analyse." }, 400);
  const b = await request.json().catch(() => ({}));
  let { agent, question, from, to, segment, dry } = b;
  const t0 = Date.now(), steps = [];
  // Free text with no agent chosen: pick the agent whose purpose matches, and lift
  // any /folder/ mentioned in the question into the segment filter. The router only
  // ever CHOOSES an existing agent — it never answers the question itself, so no
  // free-text path can bypass the evidence contract.
  let routed = null;
  if (!agent && question && question.trim().length > 3 && !keys().gemini) {
    return json({ error: "Free-text questions need a Gemini key.",
      no_key: { needs: "Gemini", hint: "Add a free key in Setup. Until then, pick an agent from the list — they all still work." },
      steps: [] }, 200);
  }
  if (!agent && question && question.trim().length > 3) {
    const span = await env.DB.prepare(`SELECT MIN(date) a, MAX(date) b FROM gsc_daily`).first().catch(() => ({}));
    const maxd = span?.b || to, mind = span?.a || from;
    // the page types that actually exist, so the planner never guesses a URL pattern
    const pt = await env.DB.prepare(`SELECT DISTINCT page_type t FROM page_universe WHERE page_type<>'' LIMIT 20`).all().catch(() => ({ results: [] }));
    const ptypes = (pt.results || []).map((r) => r.t).join(", ") || "(none recorded)";
    const segHint = (question.match(/\/[a-z0-9-]+\//) || [])[0];
    // A follow-up can always be answered by refining the previous query, so "none" is
    // simply not offered when there is history. A single flaky call must never reach the
    // screen either, so an unusable plan gets one more attempt before we give up.
    const hasHistory = Array.isArray(b.history) && b.history.length > 0;
    const usable = (p) => p && ((p.mode === "agent" && p.agent && AGENTS[p.agent] && !AGENTS[p.agent].off)
      || (p.mode === "sql" && String(p.sql || "").trim() && !READONLY(p.sql)));
    let p;
    try {
      p = await plan(env, { question, history: b.history, from, to, segment, maxd, mind, ptypes, steps });
      if (!usable(p) && (hasHistory || p?.mode !== "none"))
        p = await plan(env, { question, history: b.history, from, to, segment, maxd, mind, ptypes, steps, retry: true });
    } catch (e) { return json({ error: "Could not plan that question: " + String(e.message || e), steps }, 500); }

    if (p.mode === "agent" && p.agent && AGENTS[p.agent] && !AGENTS[p.agent].off) {
      agent = p.agent;
      routed = { question, resolved: p.resolved_question, agent, segment_from_text: segHint || null };
      if (segHint && (!segment || segment === "ALL")) segment = segHint;
    } else if (p.mode === "sql" && String(p.sql || "").trim()) {
      const bad = READONLY(p.sql);
      if (bad) return json({ error: `The generated query was rejected: it ${bad}.`, no_match: { question }, steps }, 200);
      const sql = p.sql.trim().replace(/;+\s*$/, "");
      const rows = await runSql(env, sql, steps, p.title || "Your question");
      const failed = steps.find((x) => x.tool === "sql" && !x.ok);
      if (failed) return json({ error: "The query could not run: " + failed.detail, no_match: { question }, steps }, 200);
      const uni = uniformNote(rows);
      return json({
        agent: "ask_anything", name: "Your question", purpose: p.title, layout: "findings",
        asked: question, resolved: p.resolved_question, generated_sql: sql,
        scope: { label: "Search Console + site crawl", from, to, segment: segment || "ALL", window: p.window || `${from} → ${to}` },
        freshness: { gsc: maxd }, sources: ["sql"], steps, ms: Date.now() - t0, clean: true,
        headline: rows.length ? p.title : "",
        ...(rows.length ? {} : { empty: { checked: p.window || `${from} → ${to}`, reason: "The query ran and returned no rows, so nothing in the data matches that.", next: "Try a wider period or a looser threshold." } }),
        ...(uni ? { all_rows: uni.text } : {}),
        columns: columnsOf(rows, uni?.key), rows, extras: {},
      });
    } else {
      return json({ error: (p.missing || "No agent or query answers that.").trim(),
        no_match: { question, hint: "Rephrase, or pick an agent from the list.",
          mode: p.mode, resolved: p.resolved_question,
          sql_was: String(p.sql || "").slice(0, 300) || null }, steps }, 200);
    }
  }
  if (!agent && question) return json({ error: "Could not match that to an agent. Pick one from the list, or rephrase — the tool only answers through its agents, so it will not guess.", router_error: routed?.error || null, steps }, 400);
  let s; try { s = scope({ from, to, segment }); } catch (e) { return json({ error: e.message }, 400); }
  const a = AGENTS[agent];
  if (!a) return json({ error: `Unknown agent "${agent}"` }, 400);
  if (!agentReady(a)) {
    const LABEL = { ahrefs: "Ahrefs", serpapi: "SerpAPI", firecrawl: "Firecrawl", bing: "Bing" };
    const need = LABEL[SRC_KEY[a.src]] || SRC_KEY[a.src];
    return json({ error: `This agent needs a ${need} key.`,
      no_key: { needs: need, hint: `Add your ${need} key in Config, then run it again.` }, steps: [] }, 200);
  }
  try {
    const fresh = await env.DB.prepare(`SELECT (SELECT MAX(date) FROM gsc_daily) gsc, (SELECT MAX(crawled_at) FROM crawl_pages) crawl, (SELECT COUNT(*) FROM page_universe WHERE tier=1) core`).first().catch(() => ({}));
    let { rows, extras, meta } = await runAgent(env, agent, s, question, steps, !!dry);
    const base = { agent, n: a.n, section: a.section, name: a.name, purpose: a.purpose, layout: a.layout,
      scope: { label: a.scope, from, to, segment: segment || "ALL", core_pages: fresh?.core ?? null, window: (a.window ? a.window(s) : s.W.range) },
      freshness: { gsc: fresh?.gsc || null, crawl: fresh?.crawl || null },
      sources: [...new Set(steps.map((x) => x.tool).filter((x) => x !== "llm"))],
      steps, ms: Date.now() - t0, meta };

    const failed = steps.filter((x) => !x.ok);
    // FAIL CLOSED: if any evidence source failed, we cannot claim absence — say what broke.
    if (failed.length) {
      return json({ ...base, clean: false, unchecked: true, columns: columnsOf(rows), rows: rows || [],
        empty: { checked: `${a.scope} · ${from} → ${to}`,
          reason: `Could not complete this check — ${failed.map((x) => `${x.label}: ${String(x.detail).slice(0, 90)}`).join("; ")}. Results are withheld rather than shown as fact, because a failed source cannot prove something is missing.`,
          next: "Fix the source above and run again." } });
    }
    const live = !!(a.tool || a.src);
    if (!rows.length) {
      return json({ ...base, clean: true, empty: {
        // live agents read a SERP / third-party API right now, so the date range
        // is not part of what they checked — never tell the user to widen it
        checked: live ? `${a.scope} · checked just now` : `${a.scope} · ${from} → ${to}${segment && segment !== "ALL" ? ` · ${segment}` : ""}`,
        reason: meta?.why_empty || meta?.incomplete || (a.emptyReason ? a.emptyReason(s) : "No pages matched this check — nothing to fix here right now."),
        next: live ? "Run a different agent, or re-run later — this reads live data each time."
                   : "Try a wider date range, or run a different agent." }, columns: [], rows: [] });
    }
    if (dry) return json({ ...base, clean: false, headline: "(evidence only)", columns: columnsOf(rows), rows, extras });

    const payload = { purpose: a.purpose, scope: a.scope, findings: rows.slice(0, 25), ...(Object.keys(extras).length ? { supporting: extras } : {}), ...(meta && Object.keys(meta).length ? { context: meta } : {}) };
    const want = !a.deliverable ? "" : a.deliverSpec ? `\n\nDELIVERABLE IS MANDATORY. ${a.deliverSpec}`
      : a.layout === "before_after"
      ? `\n\nDELIVERABLE IS MANDATORY. Fill deliverable.items with ONE entry per finding row (up to 5): label = that row's page path, before = its current title/description exactly as shown in the findings (or "" if none), after = your rewrite. Titles must be under 60 characters, descriptions under 155, written for that row's top_query, and must not repeat the before text. Set deliverable.title.`
      : a.layout === "code"
      ? `\n\nDELIVERABLE IS MANDATORY. deliverable.content must be the COMPLETE, valid, paste-ready block for the exact page named in your action — real JSON-LD (with @context and @type) or the full corrected file. No placeholders, no "...", no commentary. Set deliverable.title to what it is and which page it is for.`
      : `\n\nDELIVERABLE IS MANDATORY. deliverable.content = a numbered, specific plan (max 6 lines) naming the exact pages/queries from the findings.`;
    const guard = (agent === "robots_txt"
      ? `\n\nSAFETY: do NOT rewrite robots.txt. deliverable.content must be ONLY the lines to ADD (e.g. "Allow: /path") plus a one-line note saying where to add them. Never reproduce or remove existing Disallow rules — you cannot know why they exist.`
      : "") + (a.guard ? `\n\nAGENT RULE: ${a.guard}` : "");
    const need = a.deliverable ? (a.layout === "before_after" ? "items" : "code") : false;
    // Without a model key the evidence is still real and still useful — only the
    // written headline and the recommended action are unavailable. Degrade, do not fail.
    const out = !keys().gemini
      ? { clean: false, headline: "", action: null, _no_model: true }
      : await gemini(env, `AGENT: ${a.name}\nWHAT IT DOES: ${a.purpose}\nSCOPE: ${a.scope}, ${from} → ${to}\n\nFINDINGS (already computed — the user sees these as a table):\n${JSON.stringify(payload).slice(0, 15000)}${want}${guard}`, steps, outSchema(need));
    const stripped = out.action ? ground(out.action, nums({ rows, extras, meta })) : 0;
    let deliv = a.deliverable && out.deliverable && (out.deliverable.content || out.deliverable.items?.length) ? out.deliverable : null;
    // COMPUTED deliverables: built from data, not written by the model
    if (a.computed && agent === "internal_linking") {
      const lines = rows.slice(0, 5).map((r) => `FROM ${r.link_from} -> TO ${r.page} | anchor: "${r.suggested_anchor}"`);
      deliv = lines.length ? { title: "Internal links to add (source page, target page, anchor)", content: lines.join("\n") } : null;
    }
    // A deliverable that claims to be JSON-LD must actually parse. Shipping broken
    // markup is worse than shipping none, so it is withheld with the reason stated.
    if (deliv?.content && /ld\+json|"@context"/.test(deliv.content)) {
      const raw = deliv.content.replace(/<\/?script[^>]*>/g, "").trim();
      try { JSON.parse(raw); }
      catch { deliv = { title: deliv.title, content: null,
        withheld: "The generated structured data did not parse as valid JSON, so it is not shown — copying broken markup onto a page would do more harm than leaving it." }; }
    }
    // SANITISE: strip filler lines the model adds despite instructions; drop the deliverable if nothing real remains
    if (deliv?.content) {
      const FILLER = /^\s*(?:\d+[.)]\s*)?(ensure|validate|review|consider|maintain|keep|monitor|continue|check that|verify|refresh the|update the content)\b/i;
      const kept = deliv.content.split("\n").filter((l) => !FILLER.test(l));
      const cleaned = kept.join("\n").trim();
      deliv = cleaned ? { ...deliv, content: cleaned } : (deliv.items?.length ? { ...deliv, content: undefined } : null);
    }
    // a code-layout deliverable is the content; a parallel items list only confuses
    if (deliv && a.layout === "code" && deliv.content) deliv = { ...deliv, items: undefined };
    // drop no-op "keep doing what you're doing" rewrites
    if (deliv?.items) { const keep = deliv.items.filter((i) => !/^(maintain|keep|continue|no change|retain)\b/i.test(String(i.after || "").trim()));
      deliv = keep.length ? { ...deliv, items: keep } : (deliv.content ? { ...deliv, items: undefined } : null); }
    // if one diagnosis covers every row, state it once above the table instead of
    // repeating it in every cell
    const uni = uniformNote(rows);
    const redundant = redundantKey(agent, rows);
    return json({ ...base, ...(routed ? { routed } : {}), ...(out._no_model ? { no_model: true } : {}), ms: Date.now() - t0, clean: !!out.clean, headline: out.headline || "", action: out.action || null, deliverable: deliv,
      ...(uni && !redundant ? { all_rows: uni.text } : {}),
      columns: columnsOf(rows, redundant || uni?.key), rows,
      extras: Object.fromEntries(Object.entries(extras).map(([k, v]) => { const u = uniformNote(v);
        return [k, { label: titleCase(k), columns: columnsOf(v, u?.key), rows: v, ...(u ? { all_rows: u.text } : {}) }]; })),
      ungrounded: stripped });
  } catch (e) { return json({ error: e.message, steps, ms: Date.now() - t0 }, 500); }
}
