// Page Universe — the single definition of "pages that matter".
// Every Copilot agent scopes to this instead of scanning 5,300 random URLs.
//   tier 1 = money pages (product hubs + revenue tools) + top-50 by clicks/impressions
//   tier 2 = rest of pages with real traffic
//   tier 3 = crawled but no traffic
// Importance uses a FIXED trailing 90d window (stable); agents compute metrics over
// the user's own date range. Rebuilt nightly by com.seocopilot.crawl-ingest.
import { runFile, esc, query } from "./lib/d1.mjs";

import { siteUrl } from "./lib/site.mjs";
const SITE = siteUrl();
const today = new Date().toISOString().slice(0, 10);
const d90 = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
const d180 = new Date(Date.now() - 180 * 864e5).toISOString().slice(0, 10);

// --- page-type classifier -------------------------------------------------
const INS = /^(car-insurance|two-wheeler-insurance|bike-insurance|health-insurance|travel-insurance|international-travel-insurance|life-insurance|term-life-insurance|term-insurance|motor-insurance|third-party-car-insurance|taxi-insurance|commercial-vehicle-insurance|home-insurance|mobile-insurance)$/;
const SUPPORT = /^(contact-us|help|customer-service|careers|myaccount|download|garages|about-us|privacy|terms|sitemap|claim|claims|login|p|s|policy|renew|legal|press|partner|partners)$/;
const TOOLROOT = /^(rto|traffic-rules|auto)$/;
const GUIDE = /^(car-guide|bike-guide|travel-tips|automobile|driving-licence|driving-license|road-tax|health-guide|life-guide|insurance-guide|blog|article|articles|news|glossary)$/;
const TOOLISH = /(check|calculator|status|e-challan|echallan|challan|puc|apply|renew|expiry|number-plate|chassis|vin|hsrp|fastag|fine|penalty|verify|lookup|details-by)/;
const GEO = /(andhra-pradesh|arunachal|assam|bihar|chhattisgarh|goa|gujarat|haryana|himachal|jharkhand|karnataka|kerala|madhya-pradesh|maharashtra|manipur|meghalaya|mizoram|nagaland|odisha|punjab|rajasthan|sikkim|tamil-nadu|telangana|tripura|uttar-pradesh|uttarakhand|west-bengal|jammu|ladakh|puducherry|delhi|new-delhi|mumbai|bangalore|bengaluru|hyderabad|chennai|kolkata|pune|ahmedabad|jaipur|lucknow|noida|gurgaon|gurugram|surat|kanpur|nagpur|indore|bhopal|patna|vadodara|ludhiana|agra|nashik|faridabad|meerut|rajkot|varanasi|amritsar|prayagraj|allahabad|ranchi|coimbatore|vijayawada|madurai|visakhapatnam|thane|navi-mumbai|ghaziabad|chandigarh|guwahati|mysore|mysuru|kochi|cochin|trivandrum|bhubaneswar|dehradun|raipur|jodhpur|kota|gwalior|jabalpur|aurangabad|solapur|tiruchirappalli|salem|warangal|guntur|nellore|bareilly|aligarh|moradabad|saharanpur|gorakhpur|firozabad|jhansi|muzaffarnagar)(-|\/|$)/;

function classify(path) {
  const p = path.toLowerCase();
  const segs = p.split("/").filter(Boolean);
  if (!segs.length) return { type: "home", money: 1 };
  const s0 = segs[0], d = segs.length;
  const geo = segs.slice(1).some((x) => GEO.test(x + "/")) || (d > 1 && GEO.test(segs[d - 1] + "/"));
  if (SUPPORT.test(s0)) return { type: "support", money: 0 };
  if (INS.test(s0)) {
    if (d === 1) return { type: "money_hub", money: 1 };
    if (TOOLISH.test(p)) return { type: geo ? "city_page" : "tool", money: 1 };
    return { type: "money_sub", money: 1 };
  }
  if (TOOLROOT.test(s0) || TOOLISH.test(p)) return { type: geo ? "city_page" : "tool", money: 1 };
  if (GUIDE.test(s0)) return { type: geo ? "city_page" : "article", money: 0 };
  return { type: geo ? "city_page" : "article", money: 0 };
}

// --- pull aggregates ------------------------------------------------------
const cur = query(`SELECT url, SUM(clicks) c, SUM(impressions) i, SUM(position_in*impressions)/NULLIF(SUM(impressions),0) p FROM gsc_daily WHERE date>'${d90}' GROUP BY url`);
const prev = new Map(query(`SELECT url, SUM(clicks) c FROM gsc_daily WHERE date>'${d180}' AND date<='${d90}' GROUP BY url`).map((r) => [r.url, r.c]));
const crawled = query(`SELECT url, status_code, indexability FROM crawl_pages`);

const rows = new Map();
for (const r of cur) rows.set(r.url, { url: r.url, clicks: r.c || 0, impr: r.i || 0, pos: r.p, prev: prev.get(r.url) || 0, crawled: 0 });
for (const r of crawled) { const e = rows.get(r.url); if (e) e.crawled = 1; else rows.set(r.url, { url: r.url, clicks: 0, impr: 0, pos: null, prev: prev.get(r.url) || 0, crawled: 1 }); }

// One page, one row. Search Console reports #anchors and www/non-www variants as
// separate URLs; treating them as distinct pages inflates the universe and hides
// the real page — the homepage was missing entirely because of this.
const bare = SITE.replace(/^https?:\/\//, "").replace(/^www\./, "");
const toPath = (u) => {
  let s = String(u || "").split("#")[0];                       // an anchor is the same page
  s = s.replace(/^https?:\/\/(www\.)?/, "");                   // scheme and www are not identity
  if (bare && s.startsWith(bare)) s = s.slice(bare.length);
  if (!s.startsWith("/")) s = "/" + s;
  return s === "/" ? "/" : s;
};
const merged = new Map();
for (const r of rows.values()) {
  const path = toPath(r.url);
  const e = merged.get(path);
  if (!e) { merged.set(path, { ...r, path }); continue; }
  e.clicks += r.clicks; e.impr += r.impr; e.prev += r.prev;
  e.crawled = e.crawled || r.crawled;
  // keep the canonical https://www form as the row's URL where one exists
  if (/^https:\/\/www\./.test(r.url) && !/^https:\/\/www\./.test(e.url)) e.url = r.url;
  if (r.pos != null && (e.pos == null || r.impr > 0)) e.pos = e.pos == null ? r.pos : e.pos;
}
const all = [...merged.values()].map((r) => {
  const { type, money } = classify(r.path);
  return { ...r, type, money };
});

// ranks + tiers
const byClicks = [...all].sort((a, b) => b.clicks - a.clicks);
byClicks.forEach((r, i) => (r.rank_clicks = i + 1));
const byImpr = [...all].sort((a, b) => b.impr - a.impr);
byImpr.forEach((r, i) => (r.rank_impr = i + 1));
// Rank by the PREVIOUS period too. A page that has collapsed drops out of the
// current top 100 precisely because it collapsed — and that is the page you most
// need to see. Ranking on recent traffic alone gives the decay agent a blind spot
// for the worst decay.
const byPrev = [...all].sort((a, b) => (b.prev || 0) - (a.prev || 0));
byPrev.forEach((r, i) => (r.rank_prev = i + 1));

// tier 1 = "pages that matter": every product hub and the homepage (revenue,
// regardless of traffic), plus the top 100 by clicks, by impressions, and by
// clicks in the period before — so a crash keeps a page in view.
for (const r of all) {
  const core = r.type === "money_hub" || r.type === "home";
  r.is_core = core || r.rank_clicks <= 100 || r.rank_impr <= 100 || r.rank_prev <= 100 ? 1 : 0;
  r.tier = r.is_core ? 1 : (r.clicks > 0 || r.impr > 0) ? 2 : 3;
}

// --- write ----------------------------------------------------------------
runFile(`CREATE TABLE IF NOT EXISTS page_universe (
  url TEXT PRIMARY KEY, path TEXT, page_type TEXT, is_money INTEGER, tier INTEGER,
  clicks_90 INTEGER, impressions_90 INTEGER, pos REAL, clicks_prev90 INTEGER,
  rank_clicks INTEGER, rank_impr INTEGER, crawled INTEGER, built_at TEXT);
DELETE FROM page_universe;
CREATE INDEX IF NOT EXISTS idx_univ_tier ON page_universe(tier);
CREATE INDEX IF NOT EXISTS idx_univ_type ON page_universe(page_type);
CREATE INDEX IF NOT EXISTS idx_univ_clicks ON page_universe(clicks_90 DESC);`);

const q = (s) => `'${esc(s)}'`;
for (let i = 0; i < all.length; i += 400) {
  const vals = all.slice(i, i + 400).map((r) => `(${q(r.url)},${q(r.path)},${q(r.type)},${r.money},${r.tier},${r.clicks},${r.impr},${r.pos == null ? "NULL" : r.pos.toFixed(2)},${r.prev},${r.rank_clicks},${r.rank_impr},${r.crawled},${q(today)})`).join(",\n");
  runFile(`INSERT OR REPLACE INTO page_universe(url,path,page_type,is_money,tier,clicks_90,impressions_90,pos,clicks_prev90,rank_clicks,rank_impr,crawled,built_at) VALUES\n${vals};`);
}

const sum = query(`SELECT tier, page_type, COUNT(*) pages, SUM(clicks_90) clicks FROM page_universe GROUP BY tier, page_type ORDER BY tier, clicks DESC`);
console.log(`page_universe: ${all.length} URLs (${d90} → ${today})`);
for (const r of sum) console.log(`  tier ${r.tier}  ${String(r.page_type).padEnd(11)} ${String(r.pages).padStart(5)} pages  ${String(r.clicks || 0).padStart(9)} clicks`);
console.log("tier-1 money pages:", query(`SELECT COUNT(*) c FROM page_universe WHERE tier=1 AND is_money=1`)[0].c, "| tier-1 total:", query(`SELECT COUNT(*) c FROM page_universe WHERE tier=1`)[0].c);
