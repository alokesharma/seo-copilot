/* The agent roster. Every agent: outcome-name + purpose + evidence that is SCOPED to the
   Page Universe (tier 1 = product hubs + top-100 by traffic; tier 2 = the rest with traffic),
   a COMPUTED diagnosis column (never LLM-narrated), a layout, and an optional deliverable. */

// metrics over the user's date range, joined to the universe (tier<=t)
export const M = (s, _t = 1) => `(SELECT g.url url, u.path path, u.page_type page_type, u.clicks_90 c90,
  SUM(g.clicks) clicks, SUM(g.impressions) impressions, ROUND(SUM(g.position_in*g.impressions)/NULLIF(SUM(g.impressions),0),1) pos
  FROM gsc_daily g JOIN page_universe u ON u.url=g.url AND u.tier=1
  WHERE g.date>'${s.from}' AND g.date<='${s.to}'${s.segG} GROUP BY g.url)`;
// universe rows only (no date range needed)
export const U = (s, t = 1) => `(SELECT url,path,page_type,clicks_90,impressions_90,pos,clicks_prev90 FROM page_universe WHERE tier<=${t}${s.segU})`;
const CTR_EXP = `(CASE WHEN pos<1.5 THEN .28 WHEN pos<2.5 THEN .15 WHEN pos<3.5 THEN .11 WHEN pos<4.5 THEN .08 WHEN pos<5.5 THEN .06 WHEN pos<6.5 THEN .05 WHEN pos<7.5 THEN .04 WHEN pos<8.5 THEN .035 WHEN pos<9.5 THEN .03 ELSE .028 END)`;

// schema each page TYPE must have (this is what makes the schema agents mean something)
// Canonical Indian state/city extraction. Abbreviations ("ts" = Telangana) are
// matched as WHOLE WORDS only, so "ts challan" is correctly read as a Telangana
// query and is NOT reported as a mismatch against the Telangana page.
const GEO_MAP = [
  ["telangana", ["telangana"], ["ts"]], ["uttar-pradesh", ["uttar pradesh", "uttar-pradesh"], ["up"]],
  ["madhya-pradesh", ["madhya pradesh", "madhya-pradesh"], ["mp"]], ["andhra-pradesh", ["andhra pradesh", "andhra-pradesh"], ["ap"]],
  ["tamil-nadu", ["tamil nadu", "tamil-nadu"], ["tn"]], ["karnataka", ["karnataka"], ["ka"]],
  ["maharashtra", ["maharashtra"], ["mh"]], ["gujarat", ["gujarat"], ["gj"]],
  ["rajasthan", ["rajasthan"], ["rj"]], ["haryana", ["haryana"], ["hr"]],
  ["punjab", ["punjab"], ["pb"]], ["bihar", ["bihar"], ["br"]],
  ["west-bengal", ["west bengal", "west-bengal"], ["wb"]], ["odisha", ["odisha", "orissa"], ["od"]],
  ["kerala", ["kerala"], ["kl"]], ["assam", ["assam"], []],
  ["jharkhand", ["jharkhand"], ["jh"]], ["chhattisgarh", ["chhattisgarh"], ["cg"]],
  ["uttarakhand", ["uttarakhand"], ["uk"]], ["himachal-pradesh", ["himachal"], ["hp"]],
  ["goa", ["goa"], ["ga"]], ["delhi", ["delhi"], ["dl"]],
  ["mumbai", ["mumbai"], []], ["bangalore", ["bangalore", "bengaluru"], []],
  ["hyderabad", ["hyderabad"], []], ["chennai", ["chennai"], []], ["kolkata", ["kolkata"], []],
  ["pune", ["pune"], []], ["ahmedabad", ["ahmedabad"], []], ["jaipur", ["jaipur"], []],
  ["lucknow", ["lucknow"], []], ["noida", ["noida"], []], ["gurgaon", ["gurgaon", "gurugram"], []],
];
// path: full names only (URLs spell states out). query: names + whole-word abbreviations.
export const GEO_OF_PATH = (c) => `CASE ` + GEO_MAP.map(([k, names]) =>
  `WHEN ` + names.map((n) => `instr(lower(${c}),'${n.replace(/ /g, "-")}')>0`).join(" OR ") + ` THEN '${k}'`).join(" ") + ` ELSE '' END`;
const VEHICLE_CTX = (c) => `(lower(${c}) LIKE '%challan%' OR lower(${c}) LIKE '%rto%' OR lower(${c}) LIKE '%licence%'
  OR lower(${c}) LIKE '%license%' OR lower(${c}) LIKE '%vehicle%' OR lower(${c}) LIKE '%police%'
  OR lower(${c}) LIKE '%puc%' OR lower(${c}) LIKE '%number plate%')`;
export const GEO_OF_TEXT = (c) => `CASE ` + GEO_MAP.map(([k, names, abbr]) =>
  `WHEN ` + names.map((n) => `instr(lower(${c}),'${n}')>0`).concat(
    // a two-letter state code counts as a WHOLE WORD, and only inside a vehicle or
    // traffic query — so "ts challan" is Telangana while "super top up health
    // insurance" keeps "up" as an ordinary word
    abbr.map((a) => `((' '||lower(${c})||' ') LIKE '% ${a} %' AND ${VEHICLE_CTX(c)})`)).join(" OR ") + ` THEN '${k}'`).join(" ") + ` ELSE '' END`;

// Login, account and auth endpoints are plumbing, not content. They must never be
// offered as a content problem or a page to "fix" — blocking them is deliberate.
export const NOT_CONTENT = `(u.path NOT LIKE '/login%' AND u.path NOT LIKE '/myaccount%' AND u.path NOT LIKE '/authn%'
  AND u.path NOT LIKE '/account%' AND u.path NOT LIKE '%/cart%' AND u.path NOT LIKE '/p/%')`;

export const SCHEMA_RULES = {
  money_hub: ["FAQPage", "BreadcrumbList", "Product|FinancialProduct|Service|Offer"],
  money_sub: ["FAQPage", "BreadcrumbList"],
  tool: ["FAQPage|HowTo", "BreadcrumbList"],
  city_page: ["FAQPage", "BreadcrumbList"],
  article: ["Article|BlogPosting|NewsArticle", "BreadcrumbList", "Person|author"],
  home: ["Organization", "WebSite"],
  support: ["BreadcrumbList"],
};

export const AGENTS = {
  /* ── Performance ── */
  striking_distance: { n: 2, section: "Performance", name: "Striking distance", purpose: "Queries sitting at positions 11 to 20, ranked by how close to page 1",
    scope: "All queries with 200+ impressions", layout: "findings", impact: "impressions",
    sql: (s) => `SELECT q.query, SUM(q.impressions) impressions, SUM(q.clicks) clicks, ROUND(SUM(q.position_in*q.impressions)/NULLIF(SUM(q.impressions),0),1) pos,
      (SELECT u.path FROM url_keywords uk JOIN page_universe u ON u.url=uk.url WHERE uk.query=q.query${s.segPage} ORDER BY uk.clicks DESC LIMIT 1) page
      FROM query_daily q WHERE q.date>'${s.from}' AND q.date<='${s.to}'${s.segQ}
      GROUP BY q.query HAVING pos BETWEEN 11 AND 20 AND SUM(q.impressions)>=200
      ORDER BY (21-pos)*SUM(q.impressions) DESC LIMIT 25` },
  cannibalization: { n: 3, section: "Performance", name: "Cannibalization", purpose: "Two of our pages covering the same place, splitting one audience",
    scope: "Queries where 2+ of our pages rank top 20", layout: "pairs", impact: "loser_impressions",
    guard: "Two pages that serve DIFFERENT states or cities are not cannibalising — they serve different searchers. Never recommend merging or consolidating them. Only pages covering the SAME place and the SAME intent should ever be merged; otherwise the fix is to differentiate titles and internal links.",
    sql: (s) => `WITH k AS (SELECT CASE WHEN instr(url,'#')>0 THEN substr(url,1,instr(url,'#')-1) ELSE url END url, query, impressions, clicks, position_in FROM url_keywords WHERE position_in<=20),
      d AS (SELECT query, url, SUM(impressions) impressions, SUM(clicks) clicks, MIN(position_in) position_in FROM k GROUP BY query, url),
      q AS (SELECT query, SUM(impressions) tot FROM d GROUP BY query HAVING COUNT(*)>=2),
      r AS (SELECT dd.query, dd.url, dd.impressions, dd.clicks, dd.position_in, q.tot, ROW_NUMBER() OVER (PARTITION BY dd.query ORDER BY dd.clicks DESC) rn FROM d dd JOIN q USING(query))
      SELECT r1.query, replace(r1.url,${s.SITE},'') winner, r1.clicks winner_clicks, ROUND(r1.position_in,1) winner_pos,
        replace(r2.url,${s.SITE},'') loser, r2.clicks loser_clicks, r2.impressions loser_impressions, ROUND(r2.position_in,1) loser_pos, ROUND(100.0*r2.impressions/r2.tot,0) loser_share_pct,
        CASE WHEN r2.position_in<r1.position_in THEN 'the page with fewer clicks ranks higher' WHEN r2.impressions*1.0/r2.tot>0.4 THEN 'weaker page holds over 40% of the impressions' END diagnosis
      FROM r r1 JOIN r r2 ON r1.query=r2.query AND r1.rn=1 AND r2.rn=2
      WHERE r2.impressions*1.0/r2.tot>0.2
        -- Two pages that serve DIFFERENT places are not cannibalising: a UP page and
        -- a Hyderabad page both ranking for "e challan" are serving different
        -- searchers. Only same-place pairs genuinely split one audience.
        AND ${GEO_OF_PATH("r1.url")} = ${GEO_OF_PATH("r2.url")}
      ORDER BY r2.tot DESC LIMIT 20` },
  internal_linking: { window: (s) => s.W.universe, computed: true, n: 4, section: "Performance", name: "Internal linking", purpose: "Under-linked pages, with the source page and anchor text to add",
    scope: "Top-100 traffic pages", layout: "findings", impact: "impressions", deliverable: true,
    sql: (s) => `SELECT m.path page, m.page_type, m.impressions, m.clicks, m.pos, cp.inlinks current_inlinks,
      (SELECT uk.query FROM url_keywords uk WHERE uk.url=m.url ORDER BY uk.impressions DESC LIMIT 1) top_query,
      CASE WHEN cp.inlinks IS NULL THEN 'not in the last crawl — unchecked'
        WHEN cp.crawl_depth=0 THEN 'crawled from a URL list, so inlinks were not discovered — unchecked'
        WHEN cp.inlinks=0 THEN 'no HTML page links to it' WHEN cp.inlinks<5 THEN 'fewer than 5 HTML inlinks' ELSE '5 or more HTML inlinks' END diagnosis
      FROM ${M(s, 1)} m LEFT JOIN crawl_pages cp ON cp.url=m.url
      WHERE m.pos BETWEEN 4 AND 20 AND cp.inlinks IS NOT NULL
        AND cp.inlinks < 20 AND cp.crawl_depth > 0   -- under 20 HTML inlinks is genuinely under-linked (the mean, 850, is skewed by hubs).
        -- crawl_depth>0 means the crawler REACHED it by following links, so its inlink count is a real measurement, not a list-crawl artifact
      ORDER BY m.impressions DESC LIMIT 20`,
    extra: (s) => ({ link_from_these: `SELECT path page, clicks_90 clicks, page_type FROM page_universe WHERE tier=1 AND clicks_90>0 ORDER BY clicks_90 DESC LIMIT 25` }) },
  weekly_kpi: { n: 6, section: "Performance", window: (s) => s.W.week, name: "Weekly KPI", purpose: "This week against last: clicks, impressions, biggest movers",
    scope: "Whole site", layout: "kpi",
    sql: (s) => `WITH a AS (SELECT url, SUM(clicks) c FROM gsc_daily WHERE date>'${s.d7}' AND date<='${s.to}'${s.segCol} GROUP BY url), b AS (SELECT url, SUM(clicks) c FROM gsc_daily WHERE date>'${s.d14}' AND date<='${s.d7}'${s.segCol} GROUP BY url), u AS (SELECT url FROM a UNION SELECT url FROM b),
      d AS (SELECT COALESCE(pu.path, replace(u.url,${s.SITE},'')) page, COALESCE(a.c,0) this_week, COALESCE(b.c,0) last_week, COALESCE(a.c,0)-COALESCE(b.c,0) change FROM u LEFT JOIN a ON a.url=u.url LEFT JOIN b ON b.url=u.url LEFT JOIN page_universe pu ON pu.url=u.url)
      SELECT * FROM (SELECT *, 'gainer' diagnosis FROM d ORDER BY change DESC LIMIT 3) UNION ALL SELECT * FROM (SELECT *, 'loser' diagnosis FROM d ORDER BY change ASC LIMIT 3)`,
    extra: (s) => ({ totals: `WITH a AS (SELECT SUM(clicks) c, SUM(impressions) i FROM gsc_daily WHERE date>'${s.d7}' AND date<='${s.to}'${s.segCol}), b AS (SELECT SUM(clicks) c, SUM(impressions) i FROM gsc_daily WHERE date>'${s.d14}' AND date<='${s.d7}'${s.segCol})
      SELECT 'Clicks' metric, b.c last_week, a.c this_week, a.c-b.c change, ROUND(100.0*(a.c-b.c)/NULLIF(b.c,0),1) change_pct FROM a,b
      UNION ALL SELECT 'Impressions', b.i, a.i, a.i-b.i, ROUND(100.0*(a.i-b.i)/NULLIF(b.i,0),1) FROM a,b
      UNION ALL SELECT 'CTR %', ROUND(100.0*b.c/NULLIF(b.i,0),2), ROUND(100.0*a.c/NULLIF(a.i,0),2), ROUND(100.0*a.c/NULLIF(a.i,0)-100.0*b.c/NULLIF(b.i,0),2), NULL FROM a,b` }) },

  /* ── Keywords ── */
  keyword_cluster: { off: true, n: 8, section: "Keywords", name: "Query themes and the page that ranks", purpose: "Group our demand into clusters and name the page that should win each",
    scope: "Top 40 queries by impressions", layout: "findings", sql: (s) => s.TOPQ(40) },
  topic_gap: { n: 9, section: "Keywords", name: "Topic gap", purpose: "Queries with real demand where we rank off page 1",
    scope: "Queries with 1,000+ impressions", layout: "findings", impact: "impressions",
    sql: (s) => `SELECT q.query, SUM(q.impressions) impressions, SUM(q.clicks) clicks, ROUND(SUM(q.position_in*q.impressions)/NULLIF(SUM(q.impressions),0),1) pos,
      (SELECT u.path FROM url_keywords uk JOIN page_universe u ON u.url=uk.url WHERE uk.query=q.query${s.segPage} ORDER BY uk.clicks DESC LIMIT 1) current_page,
      CASE WHEN (SELECT COUNT(*) FROM url_keywords uk WHERE uk.query=q.query)=0
          THEN 'no page of ours ranks for this query at all'
        WHEN ROUND(SUM(q.position_in*q.impressions)/NULLIF(SUM(q.impressions),0),1) > 20
          THEN 'a page of ours ranks, but far past page 1'
        ELSE 'a page of ours ranks just off page 1' END diagnosis
      FROM query_daily q WHERE q.date>'${s.from}' AND q.date<='${s.to}'${s.segQ} GROUP BY q.query HAVING SUM(q.impressions)>=1000 AND pos>10 ORDER BY SUM(q.impressions) DESC LIMIT 25` },

  /* ── Links (Ahrefs) ── */
  backlink_gap: { window: (s) => s.W.live, n: 10, section: "Links", name: "Backlink gap", purpose: "Referring domains a competitor has and we don't",
    scope: "Competitor vs your site", layout: "findings", src: "ahrefs", impact: "domain_rating", tool: "backlink_gap" },
  new_link_opportunity: { off: true, window: (s) => s.W.live, n: 11, section: "Links", name: "Link prospects on our topic", purpose: "Sites already ranking for our topic that could link to us",
    scope: "Live SERP for our top query", layout: "findings", src: "ahrefs", tool: "link_prospects" },
  lost_link_monitor: { window: (s) => s.W.live, n: 12, section: "Links", name: "Lost links", purpose: "Backlinks lost in 90 days, the recoverable ones first",
    scope: "Your site, last 90 days", layout: "findings", src: "ahrefs", impact: "referring_dr", tool: "lost_links" },
  anchor_text_audit: { window: (s) => s.W.live, n: 13, section: "Links", name: "Anchor text", purpose: "How inbound anchors are spread, and which carry over-optimisation risk",
    scope: "All anchors to your site", layout: "findings", src: "ahrefs", tool: "anchors" },
  toxic_link_detector: { window: (s) => s.W.live, n: 14, section: "Links", name: "Toxic links", purpose: "Spammy or very low-authority domains linking to us",
    scope: "All referring domains", layout: "findings", src: "ahrefs", tool: "toxic_links" },

  /* ── Structured data ── */
  schema_markup: { window: (s) => s.W.live, n: 15, section: "Structured data", deliverSpec: "deliverable.content = ONE complete, valid JSON-LD <script> block for the SINGLE worst page only. Keep it under 1200 characters: at most 3 FAQ questions, short answers. It MUST be complete and parseable — never cut off mid-string.", name: "Schema markup", purpose: "Missing or broken structured data on our highest-traffic pages",
    scope: "Top traffic pages + product hubs", layout: "code", src: "scrape", deliverable: true, tool: "schema_audit" },
  schema_validation: { off: true, window: (s) => s.W.live, n: 16, section: "Structured data", name: "Schema errors blocking rich results", purpose: "Only the faults that stop a rich result — not cosmetic warnings",
    scope: "Top traffic pages + product hubs", layout: "findings", src: "scrape", tool: "schema_audit" },
  faq_schema: { off: true, n: 17, section: "Structured data", name: "FAQ schema from real PAA questions", purpose: "Takes the actual People-Also-Ask questions and builds FAQPage JSON-LD",
    scope: "Our biggest query", layout: "code", src: "serp", deliverable: true, tool: "faq_schema" },
  product_schema: { off: true, window: (s) => s.W.live, n: 18, section: "Structured data", name: "Product schema gaps on insurance hubs", purpose: "Whether our revenue pages carry Product/Offer markup, and the corrected JSON-LD",
    scope: "Product hubs only", layout: "code", src: "scrape", deliverable: true, tool: "product_schema" },

  /* ── Crawl & indexing ── */
  bing_indexation: { off: true, window: (s) => s.W.live, n: 21, section: "Crawl & indexing", name: "Pages Bing can't crawl", purpose: "Bing crawl faults on pages that earn Google traffic (Bing feeds Copilot)",
    scope: "Traffic pages vs Bing crawl issues", layout: "findings", src: "bing", tool: "bing" },
  indexability: { window: (s) => s.W.universe, n: 22, section: "Crawl & indexing", guard: "Each row is a GROUP of pages. The impressions shown belong to the whole group, never to the single worst page named. The action must address the group, and any figure quoted must be attributed to the group.", name: "Indexability", purpose: "Pages Google cannot index, grouped by cause",
    scope: "All crawled pages with traffic", layout: "findings", impact: "impressions_at_risk",
    sql: (s) => `SELECT cp.indexability_status cause, COUNT(*) pages, SUM(COALESCE(u.impressions_90,0)) impressions_at_risk,
      (SELECT u2.path FROM crawl_pages c2 JOIN page_universe u2 ON u2.url=c2.url
        WHERE c2.indexability_status=cp.indexability_status
          AND u2.path NOT LIKE '/login%' AND u2.path NOT LIKE '/myaccount%' AND u2.path NOT LIKE '/authn%' AND u2.path NOT LIKE '/account%'
        ORDER BY u2.impressions_90 DESC LIMIT 1) worst_page,
      cp.indexability_status||' (reported by the site crawl)' diagnosis
      FROM crawl_pages cp LEFT JOIN page_universe u ON u.url=cp.url
      WHERE cp.indexability='Non-Indexable' AND cp.status_code<>429
        AND cp.url NOT LIKE '%/login%' AND cp.url NOT LIKE '%/myaccount%' AND cp.url NOT LIKE '%/authn%' AND cp.url NOT LIKE '%/account%'
      GROUP BY cause ORDER BY impressions_at_risk DESC, pages DESC LIMIT 25` },
  crawl_error: { window: (s) => s.W.universe, n: 23, section: "Crawl & indexing", name: "Crawl errors", purpose: "Pages returning 4xx or 5xx, with the traffic at risk",
    scope: "All crawled pages", layout: "findings", impact: "clicks_at_risk",
    sql: (s) => `SELECT cp.status_code status, COUNT(*) pages, SUM(COALESCE(u.clicks_90,0)) clicks_at_risk,
      (SELECT COALESCE(u2.path, replace(c2.url,${s.SITE},'')) FROM crawl_pages c2 LEFT JOIN page_universe u2 ON u2.url=c2.url WHERE c2.status_code=cp.status_code ORDER BY COALESCE(u2.clicks_90,0) DESC LIMIT 1) worst_page,
      CASE WHEN cp.status_code=404 THEN '404 not found' WHEN cp.status_code=429 THEN 'crawler was rate-limited (not a page fault)' WHEN cp.status_code>=500 THEN 'server error (5xx)' ELSE 'client error (4xx)' END diagnosis
      FROM crawl_pages cp LEFT JOIN page_universe u ON u.url=cp.url WHERE cp.status_code>=400 AND cp.status_code<>429 GROUP BY cp.status_code ORDER BY clicks_at_risk DESC, pages DESC LIMIT 20` },
  redirect_chain: { off: true, window: (s) => s.W.universe, n: 24, section: "Crawl & indexing", name: "Redirect chains wasting equity", purpose: "Redirects that point at another redirect, and the traffic passing through",
    scope: "All crawled redirects", layout: "findings", impact: "clicks",
    sql: (s) => `SELECT replace(cp.url,${s.SITE},'') page, cp.status_code status, replace(cp.redirect_url,${s.SITE},'') redirects_to, replace(nxt.redirect_url,${s.SITE},'') then_to,
      COALESCE(u.clicks_90,0) clicks, CASE WHEN nxt.url IS NOT NULL THEN 'redirects to another redirect (2+ hops)' ELSE 'single redirect hop' END diagnosis
      FROM crawl_pages cp LEFT JOIN crawl_pages nxt ON nxt.url=cp.redirect_url AND nxt.status_code BETWEEN 300 AND 399 LEFT JOIN page_universe u ON u.url=cp.url
      WHERE cp.status_code BETWEEN 300 AND 399 AND cp.redirect_url<>'' ORDER BY (nxt.url IS NOT NULL) DESC, clicks DESC LIMIT 20` },
  robots_txt: { off: true, window: (s) => s.W.live, n: 29, section: "Crawl & indexing", name: "robots.txt blocking valuable pages", purpose: "Traffic pages disallowed by robots.txt, plus a corrected file",
    scope: "robots.txt vs traffic pages", layout: "code", deliverable: true, tool: "robots" },
  sitemap_health: { off: true, window: (s) => s.W.universe, n: 30, section: "Crawl & indexing", name: "Traffic pages the sitemap gets wrong", purpose: "Pages earning impressions that are errored, redirected or non-indexable",
    scope: "Traffic pages vs crawl", layout: "findings", impact: "impressions",
    sql: (s) => `SELECT u.path page, u.page_type, u.impressions_90 impressions, cp.status_code status, cp.indexability, cp.indexability_status cause,
      CASE WHEN CASE WHEN u.path LIKE '/myaccount%' OR u.path LIKE '/login%' OR u.path LIKE '/support%' OR u.path LIKE '/claim%' OR u.path LIKE '/policy%' OR u.path LIKE '/customer%' THEN 1 ELSE 0 END=1 THEN 'blocked on purpose (account/support area) — expected, not a fault'
        WHEN cp.status_code>=400 THEN 'earns impressions but returns an error' WHEN cp.status_code BETWEEN 300 AND 399 THEN 'earns impressions but redirects'
        WHEN cp.status_code=0 THEN 'not fetched in the last crawl — status unknown' ELSE 'earns impressions but is non-indexable' END diagnosis
      FROM page_universe u JOIN crawl_pages cp ON cp.url=u.url WHERE u.impressions_90>0 AND cp.status_code<>429 AND (cp.status_code<>200 OR cp.indexability<>'Indexable') ORDER BY CASE WHEN u.path LIKE '/myaccount%' OR u.path LIKE '/login%' OR u.path LIKE '/support%' OR u.path LIKE '/claim%' OR u.path LIKE '/policy%' OR u.path LIKE '/customer%' THEN 1 ELSE 0 END ASC, u.impressions_90 DESC LIMIT 25` },
  orphan_page: { window: (s) => s.W.universe, n: 28, section: "Crawl & indexing", name: "Orphan pages", purpose: "Traffic pages that no HTML link points to",
    scope: "Crawled pages with traffic", layout: "findings", impact: "impressions",
    emptyReason: () => "No page can be proven orphaned from this crawl. Every traffic page with zero recorded inlinks was crawled from a URL list, and a list crawl never discovers inlinks — so zero means unmeasured, not unlinked. Crawl the site by following links to answer this.",
    sql: (s) => `SELECT u.path page, u.page_type, u.clicks_90 clicks, u.impressions_90 impressions,
        cp.inlinks html_inlinks, cp.crawl_depth depth,
        CASE WHEN cp.crawl_depth IS NULL OR cp.crawl_depth=0 THEN 'we seeded this URL, so the crawl could not judge its links — unchecked'
          WHEN cp.crawl_depth>0 THEN 'the crawler reached it at depth '||cp.crawl_depth||' but found no plain HTML link — the links to it are JavaScript-rendered'
          ELSE 'no HTML page links to it' END diagnosis
      FROM page_universe u JOIN crawl_pages cp ON cp.url=u.url
      WHERE u.tier=1 AND cp.inlinks=0 AND cp.status_code=200 AND cp.crawl_depth>0
        AND COALESCE(u.impressions_90,0)>0${s.segU2} AND ${NOT_CONTENT}
      ORDER BY u.impressions_90 DESC LIMIT 25` },
  content_audit: { n: 1, section: "Performance", name: "Content decay", purpose: "Top pages losing clicks, each with a keep, update, merge or kill verdict",
    scope: "Top-100 traffic pages + all product hubs", layout: "findings", window: (s) => s.W.vsPrev, src: "ahrefs", tool: "content_audit", impact: "clicks_lost" },
  thin_content: { window: (s) => s.W.universe, n: 33, section: "Content quality", name: "Thin content", purpose: "Pages under 300 words, split by whether demand exists",
    scope: "All indexable crawled pages", layout: "findings", impact: "impressions",
    sql: (s) => `SELECT COALESCE(u.path, replace(cp.url,${s.SITE},'')) page, COALESCE(u.page_type,'?') page_type, cp.word_count words, COALESCE(u.clicks_90,0) clicks, COALESCE(u.impressions_90,0) impressions,
      CASE WHEN cp.word_count<50 THEN 'crawler read under 50 words — likely rendered by JavaScript, verify manually'
        WHEN COALESCE(u.impressions_90,0)>=500 THEN 'under 300 words, 500+ impressions' WHEN COALESCE(u.impressions_90,0)>0 THEN 'under 300 words, under 500 impressions'
        WHEN u.url IS NULL THEN 'crawled but no Search Console data' ELSE 'no impressions in the last 90 days' END diagnosis
      FROM crawl_pages cp LEFT JOIN page_universe u ON u.url=cp.url WHERE cp.status_code=200 AND cp.indexability='Indexable' AND cp.word_count<300${s.segCP} ORDER BY (cp.word_count>=50) DESC, impressions DESC LIMIT 25` },
  duplicate_content: { window: (s) => s.W.universe, n: 34, section: "Content quality", name: "Duplicate content", purpose: "Pages sharing an identical title or H1",
    scope: "All indexable crawled pages", layout: "findings", impact: "clicks",
    sql: (s) => `WITH d AS (
      SELECT 'title' kind, cp.title shared_text, COUNT(*) pages, SUM(COALESCE(u.clicks_90,0)) clicks, MAX(COALESCE(u.path,'')) top_page FROM crawl_pages cp LEFT JOIN page_universe u ON u.url=cp.url WHERE cp.status_code=200 AND cp.indexability='Indexable' AND cp.title<>'' GROUP BY cp.title HAVING COUNT(*)>=2
      UNION ALL SELECT 'H1', cp.h1, COUNT(*), SUM(COALESCE(u.clicks_90,0)), MAX(COALESCE(u.path,'')) FROM crawl_pages cp LEFT JOIN page_universe u ON u.url=cp.url WHERE cp.status_code=200 AND cp.indexability='Indexable' AND cp.h1<>'' GROUP BY cp.h1 HAVING COUNT(*)>=2)
      SELECT kind, substr(shared_text,1,70) shared_text, pages, clicks, top_page, CASE WHEN pages>=10 THEN '10+ pages share this exact text' ELSE '2–9 pages share this exact text' END diagnosis FROM d ORDER BY clicks DESC, pages DESC LIMIT 25` },
  word_count: { off: true, window: (s) => s.W.live, n: 35, section: "Content quality", name: "Sections competitors cover, we don't", purpose: "Scrapes the page outranking us and diffs section coverage",
    scope: "Live SERP + competitor page", layout: "findings", src: "scrape", deliverable: true, tool: "content_gap" },
  // OFF: passages arrive cut mid-word and markdown headings/bullets are counted as
  // sentences, so both the score and the quoted passage are unreliable. Same root
  // cause as hard_to_read — sentence segmentation on these pages is broken.
  readability: { off: true, window: (s) => s.W.live, n: 36, section: "Content quality", name: "Readability check on a key page", purpose: "How hard our page reads, and a rewrite of the worst passage",
    scope: "One page (top traffic by default)", layout: "code", src: "scrape", deliverable: true, tool: "readability" },
  intent_mismatch: { n: 37, section: "Content quality", name: "Intent mismatch", purpose: "Queries landing on a page of the wrong type or the wrong place",
    scope: "Top queries by impressions", layout: "findings", src: "serp", enrich: { on: "query", n: 4 },
    guard: "The action must be about WHICH page should own this query. Never suggest optimising a state or city page for a national query — that page should keep its own geography. The fix is to make the generic page rank, or to decide the generic page must be built.",
    // the mismatch must be MEASURED — a generic query (no state/city word) ranking
    // on a state-specific page path — never narrated from the agent's name
    sql: (s) => `SELECT query, impressions, clicks, pos, page, CASE
        WHEN page IS NULL THEN 'no page of ours ranks for this query — unchecked'
        WHEN qgeo='' AND pgeo='' THEN 'query and page are both non-geographic'
        WHEN qgeo='' AND pgeo<>'' THEN 'generic query ranking on a '||pgeo||' page'
        WHEN qgeo<>'' AND pgeo='' THEN 'a '||qgeo||' query ranking on a non-geographic page'
        WHEN qgeo=pgeo THEN 'query and page are the same place ('||qgeo||')'
        ELSE 'a '||qgeo||' query ranking on a '||pgeo||' page' END diagnosis
      FROM (SELECT t.*, ${GEO_OF_TEXT("t.query")} qgeo, ${GEO_OF_PATH("t.page")} pgeo FROM (${s.TOPQ(25)}) t)
      WHERE qgeo<>pgeo OR page IS NULL` },

  /* ── Titles & SERP ── */
  title_optimizer: { n: 38, section: "Titles & SERP", name: "Title optimizer", purpose: "Page-1 pages under-earning clicks, with rewritten titles",
    scope: "Page-1 pages, 1,000+ impressions", layout: "before_after", deliverable: true, impact: "missed_clicks",
    sql: (s) => `WITH p AS (SELECT m.url, m.path, m.page_type, m.clicks, m.impressions impr, m.pos FROM ${M(s, 1)} m WHERE m.impressions>=1000 AND m.pos<=10), e AS (SELECT *, ${CTR_EXP} exp FROM p)
      SELECT e.path page, e.pos, ROUND(100.0*e.clicks/e.impr,2) ctr_pct, ROUND(100.0*e.exp,2) expected_ctr_pct, CAST(e.exp*e.impr-e.clicks AS INT) missed_clicks,
      cp.title current_title, cp.title_len title_chars, (SELECT uk.query FROM url_keywords uk WHERE uk.url=e.url ORDER BY uk.impressions DESC LIMIT 1) top_query,
      CASE WHEN cp.title_len>60 THEN 'title over 60 characters' WHEN cp.title IS NULL OR cp.title='' THEN 'no title' WHEN cp.title_len<30 THEN 'title under 30 characters' ELSE 'title length is within range — length does not explain the CTR gap' END diagnosis
      FROM e LEFT JOIN crawl_pages cp ON cp.url=e.url WHERE e.exp*e.impr-e.clicks>0 AND lower(COALESCE((SELECT uk.query FROM url_keywords uk WHERE uk.url=e.url ORDER BY uk.impressions DESC LIMIT 1),'')) ${s.notBrand} ORDER BY missed_clicks DESC LIMIT 5` },
  meta_description: { off: true, n: 39, section: "Titles & SERP", name: "Write missing or weak meta descriptions", purpose: "Top pages with no/over-long descriptions — rewritten under 155 chars",
    scope: "Top traffic pages + product hubs", layout: "before_after", deliverable: true, impact: "impressions",
    sql: (s) => `SELECT m.path page, m.page_type, m.impressions, m.clicks, cp.meta_desc current_meta, cp.meta_desc_len meta_chars,
      (SELECT uk.query FROM url_keywords uk WHERE uk.url=m.url ORDER BY uk.impressions DESC LIMIT 1) top_query,
      CASE WHEN cp.meta_desc IS NULL OR cp.meta_desc='' THEN 'no meta description on the page' WHEN cp.meta_desc_len>160 THEN 'description over 160 characters' WHEN cp.meta_desc_len<70 THEN 'description under 70 characters' ELSE 'description present, length within range' END diagnosis
      FROM ${M(s, 1)} m LEFT JOIN crawl_pages cp ON cp.url=m.url ORDER BY m.impressions DESC LIMIT 20` },
  ctr_improvement: { off: true, n: 40, section: "Titles & SERP", name: "Page-1 pages under-earning clicks", purpose: "Ranked by clicks/month we should be getting and aren't",
    scope: "Page-1 pages, 1,000+ impressions", layout: "findings", impact: "missed_clicks",
    sql: (s) => `WITH p AS (SELECT m.url, m.path, m.page_type, m.clicks, m.impressions impr, m.pos FROM ${M(s, 1)} m WHERE m.impressions>=1000 AND m.pos<=10), e AS (SELECT *, ${CTR_EXP} exp FROM p)
      SELECT path page, page_type, clicks, impr impressions, pos, ROUND(100.0*clicks/impr,2) ctr_pct, ROUND(100.0*exp,2) expected_ctr_pct, CAST(exp*impr-clicks AS INT) missed_clicks,
      CASE WHEN pos<=3 THEN 'ranks in the top 3 but CTR is below the page-1 curve' ELSE 'CTR below the page-1 curve for this position' END diagnosis FROM e WHERE exp*impr-clicks>0 AND lower(COALESCE((SELECT uk.query FROM url_keywords uk WHERE uk.url=e.url ORDER BY uk.impressions DESC LIMIT 1),'')) ${s.notBrand} ORDER BY missed_clicks DESC LIMIT 25` },
  serp_feature: { off: true, n: 41, section: "Titles & SERP", name: "SERP features taking our clicks", purpose: "What sits above us on our biggest queries — snippet, PAA, ads, video",
    scope: "Top 5 queries by impressions", layout: "findings", src: "serp", sql: (s) => s.TOPQ(5), enrich: { on: "query", n: 5 } },
  snippet_optimizer: { off: true, n: 42, section: "Titles & SERP", name: "Win the featured snippet",
    deliverSpec: "deliverable.content must be ONLY the answer paragraph to publish on the page: 40-55 words of plain prose, direct answer in the first sentence, no markup, no JSON, no heading. Put the target query in deliverable.title.", purpose: "The query we're closest on, plus the answer block to publish",
    scope: "Queries at positions 1–4", layout: "code", src: "serp", deliverable: true, impact: "impressions",
    sql: (s) => `SELECT q.query, SUM(q.impressions) impressions, SUM(q.clicks) clicks, ROUND(SUM(q.position_in*q.impressions)/NULLIF(SUM(q.impressions),0),1) pos,
      (SELECT u.path FROM url_keywords uk JOIN page_universe u ON u.url=uk.url WHERE uk.query=q.query ORDER BY uk.clicks DESC LIMIT 1) page, 'close to the snippet' diagnosis
      FROM query_daily q WHERE q.date>'${s.from}' AND q.date<='${s.to}' GROUP BY q.query HAVING pos BETWEEN 1 AND 4 AND SUM(q.impressions)>=2000 ORDER BY SUM(q.impressions) DESC LIMIT 5`, enrich: { on: "query", n: 3 } },

  /* ── Freshness ── */
  news_opportunity: { off: true, window: (s) => s.W.live, n: 43, section: "Freshness", name: "This week's news we can cover", purpose: "Indian insurance news from the last few days, filtered to what we can credibly write",
    scope: "Google News, India", layout: "findings", src: "news", tool: "news" },
  update_opportunity: { window: (s) => s.W.universe, n: 44, section: "Freshness", name: "Update opportunity", purpose: "Pages still earning traffic but unedited for 180 days or more",
    scope: "Top-100 traffic pages", layout: "findings", impact: "clicks", deliverable: true,
    sql: (s) => `SELECT u.path page, u.page_type, p.last_changed last_edit, CAST(julianday('${s.to}')-julianday(p.last_changed) AS INT) days_since_edit, u.clicks_90 clicks, u.impressions_90 impressions,
      CASE WHEN julianday('${s.to}')-julianday(p.last_changed)>365 THEN 'last verified edit over a year ago' ELSE 'last verified edit 180–365 days ago' END diagnosis
      FROM page_universe u JOIN page_content_changes p ON p.url=u.url WHERE u.tier=1${s.segU2} AND p.last_changed IS NOT NULL AND julianday('${s.to}')-julianday(p.last_changed)>180 ORDER BY u.clicks_90 DESC LIMIT 25` },

  /* ── Tracking ── */
  competitor_monitor: { off: true, window: (s) => s.W.live, n: 47, section: "Tracking", name: "Competitor pages hitting our keywords", purpose: "What a rival published recently that overlaps the queries we care about",
    scope: "Competitor sitemap × our top queries", layout: "findings", src: "sitemap", tool: "competitor" },
  keyword_rank_tracker: { n: 48, section: "Keywords", name: "Keywords that moved", purpose: "Queries whose ranking position genuinely changed, best and worst first",
    scope: "Queries with 200+ impressions", layout: "findings", impact: "impressions", window: (s) => s.W.rank28,
    sql: (s) => `WITH a AS (SELECT query, SUM(impressions) i, SUM(position_in*impressions)/NULLIF(SUM(impressions),0) p FROM query_daily WHERE date>'${s.d28}' AND date<='${s.to}' GROUP BY query),
      b AS (SELECT query, SUM(position_in*impressions)/NULLIF(SUM(impressions),0) p FROM query_daily WHERE date>'${s.d56}' AND date<='${s.d28}' GROUP BY query)
      SELECT a.query, ROUND(b.p,1) pos_before, ROUND(a.p,1) pos_now, ROUND(a.p-b.p,1) change, a.i impressions,
      CASE WHEN a.p-b.p<=-2 THEN 'improved' ELSE 'dropped' END diagnosis FROM a JOIN b USING(query) WHERE ABS(a.p-b.p)>=2 AND a.i>=200 ORDER BY ABS(a.p-b.p)*a.i DESC LIMIT 25`,
    emptyReason: (s) => `No keyword with 500+ impressions moved 3 or more positions between ${s.W.rank28}. Rankings were stable — that is the result, not a gap in the data.` },
  seo_audit_report: { n: 50, section: "Tracking", name: "SEO audit report", purpose: "Site health brief: traffic trend, technical debt, and the next three moves",
    scope: "Whole site", layout: "kpi", deliverable: true,
    // Only COMPLETE calendar months. The current month is always partial, and
    // comparing a part-month to a full month invents a collapse that never happened.
    sql: (s) => `WITH m AS (SELECT substr(date,1,7) month, SUM(clicks) clicks, SUM(impressions) impressions, COUNT(DISTINCT date) days
        FROM gsc_daily WHERE date>'${s.d180}' AND date<='${s.to}'${s.segCol} GROUP BY month)
      SELECT month, clicks, impressions, 'full calendar month' diagnosis FROM m
      WHERE date(month||'-01','+1 month','-1 day') <= '${s.to}' AND date(month||'-01') > '${s.d180}'
      ORDER BY month`,
    extra: (s) => ({
      technical_debt: `SELECT (SELECT COUNT(*) FROM crawl_pages WHERE status_code>=400) broken_pages, (SELECT COUNT(*) FROM crawl_pages cp JOIN page_universe u ON u.url=cp.url WHERE cp.inlinks=0 AND cp.status_code=200 AND u.impressions_90>0) orphans_with_traffic, (SELECT COUNT(*) FROM crawl_pages WHERE h1='' AND status_code=200) missing_h1, (SELECT COUNT(*) FROM crawl_pages WHERE indexability='Non-Indexable') non_indexable`,
      biggest_losses: `WITH cur AS (SELECT g.url, SUM(g.clicks) c, SUM(g.impressions) i, SUM(g.position_in*g.impressions)/NULLIF(SUM(g.impressions),0) p FROM gsc_daily g JOIN page_universe u ON u.url=g.url AND u.tier=1${s.segU2} WHERE g.date>'${s.from}' AND g.date<='${s.to}' GROUP BY g.url),
      prev AS (SELECT g.url, SUM(g.clicks) c, SUM(g.impressions) i, SUM(g.position_in*g.impressions)/NULLIF(SUM(g.impressions),0) p FROM gsc_daily g JOIN page_universe u ON u.url=g.url AND u.tier=1${s.segU2} WHERE g.date>'${s.prevFrom}' AND g.date<='${s.prevTo}' GROUP BY g.url)
      SELECT u.path page, u.page_type, prev.c clicks_before, COALESCE(cur.c,0) clicks_now, prev.c-COALESCE(cur.c,0) clicks_lost,
        ROUND(prev.p,1) pos_before, ROUND(cur.p,1) pos_now, ROUND(100.0*prev.c/NULLIF(prev.i,0),2) ctr_before_pct, ROUND(100.0*COALESCE(cur.c,0)/NULLIF(cur.i,0),2) ctr_now_pct,
        CASE WHEN cur.p IS NULL THEN 'no impressions in the current period' WHEN cur.p-prev.p>=0.5 THEN 'lost ranking' WHEN COALESCE(cur.c,0)*1.0/NULLIF(cur.i,0) < prev.c*0.8/NULLIF(prev.i,0) THEN 'CTR fell, rank held' WHEN cur.i<prev.i*0.8 THEN 'search demand fell' ELSE 'mixed' END diagnosis
      FROM prev JOIN page_universe u ON u.url=prev.url LEFT JOIN cur ON cur.url=prev.url WHERE prev.c>=100 ORDER BY clicks_lost DESC LIMIT 25` }) },

  /* ── Built from Screaming Frog columns we were previously discarding ── */
  slow_pages: { window: (s) => s.W.universe, n: 60, section: "Speed", name: "Page speed",
    purpose: "The slowest pages that still earn traffic",
    scope: "Crawled pages with traffic", layout: "findings", impact: "clicks_90",
    sql: (s) => `SELECT u.path page, u.page_type, u.clicks_90, u.impressions_90 impressions,
        ROUND(cp.response_time,2) response_seconds,
        CASE WHEN cp.response_time IS NULL THEN 'not measured in the last crawl'
          WHEN cp.response_time >= 2 THEN 'over 2s — users abandon before it paints'
          WHEN cp.response_time >= 1 THEN 'between 1s and 2s — slower than it should be'
          ELSE 'under 1s — healthy' END diagnosis
      FROM page_universe u JOIN crawl_pages cp ON cp.url=u.url
      WHERE u.tier=1 AND cp.response_time IS NOT NULL AND cp.response_time>=1 AND COALESCE(u.clicks_90,0)>0${s.segU}
      ORDER BY cp.response_time DESC LIMIT 25` },

  heading_structure: { window: (s) => s.W.universe, n: 61, section: "Content quality", name: "Heading structure",
    purpose: "Traffic pages with no H2 subheadings",
    scope: "Crawled pages with traffic", layout: "findings", impact: "impressions",
    sql: (s) => `SELECT u.path page, u.page_type, u.clicks_90 clicks, u.impressions_90 impressions,
        cp.word_count words, COALESCE(NULLIF(cp.h1,''),'(none)') h1,
        CASE WHEN cp.h2_1 IS NULL THEN 'not read in the last crawl'
          WHEN cp.h2_1='' AND COALESCE(cp.word_count,0)>=300 THEN 'no H2 on a page long enough to need them'
          ELSE 'has H2 headings' END diagnosis
      FROM page_universe u JOIN crawl_pages cp ON cp.url=u.url
      WHERE u.tier=1 AND cp.h2_1='' AND COALESCE(cp.word_count,0)>=300 AND COALESCE(u.impressions_90,0)>0${s.segU}
      ORDER BY u.impressions_90 DESC LIMIT 25` },

  // OFF: Screaming Frog counts every list item, table cell and nav link as a
  // sentence on these pages — 2,569 words across 521 "sentences" is 4.9 words each,
  // which is impossible for prose. Flesch is a function of words-per-sentence, so
  // every score on this site is computed on fragments and means nothing. Re-enable
  // only if sentence segmentation is fixed at the crawl.
  hard_to_read: { off: true, window: (s) => s.W.universe, n: 62, section: "Content quality", name: "Hard-to-read pages that earn traffic",
    purpose: "Flesch reading ease across every crawled page, worst first, weighted by the traffic at stake",
    scope: "All crawled pages with traffic", layout: "findings", impact: "impressions",
    sql: (s) => `SELECT u.path page, u.page_type, u.clicks_90 clicks, u.impressions_90 impressions,
        ROUND(cp.flesch,1) reading_ease, ROUND(cp.avg_words_sentence,1) avg_words_per_sentence, cp.word_count words,
        CASE WHEN cp.flesch IS NULL THEN 'not scored in the last crawl'
          WHEN cp.flesch < 30 THEN 'very hard to read — university level'
          WHEN cp.flesch < 50 THEN 'hard to read — college level'
          WHEN cp.flesch < 60 THEN 'fairly hard to read' ELSE 'readable' END diagnosis
      FROM page_universe u JOIN crawl_pages cp ON cp.url=u.url
      WHERE u.tier=1 AND cp.flesch IS NOT NULL AND cp.flesch<50 AND COALESCE(u.impressions_90,0)>0${s.segU}
        AND u.page_type NOT IN ('support','home') AND ${NOT_CONTENT}
        AND COALESCE(cp.word_count,0)>=300
        AND cp.avg_words_sentence >= 12   -- below this the "sentences" are nav links, not prose
      ORDER BY u.impressions_90 DESC LIMIT 25` },

  near_duplicates: { off: true, window: (s) => s.W.universe, n: 63, section: "Content quality", name: "Near-duplicate pages to merge",
    purpose: "Pages whose content is 90%+ identical to another page, with the one to keep",
    scope: "All crawled pages", layout: "findings", impact: "impressions",
    sql: (s) => `SELECT u.path page, u.impressions_90 impressions, u.clicks_90 clicks,
        (SELECT u2.path FROM page_universe u2 WHERE u2.url=cp.near_dup_url) duplicate_of,
        ROUND(100*cp.similarity,0) percent_identical, cp.near_dup_count others_like_it,
        CASE WHEN cp.similarity IS NULL THEN 'near-duplicate analysis not run in the last crawl'
          WHEN cp.similarity>=0.95 THEN 'all but identical — merge into the stronger page'
          ELSE 'very similar — review whether both should exist' END diagnosis
      FROM page_universe u JOIN crawl_pages cp ON cp.url=u.url
      WHERE cp.similarity IS NOT NULL AND cp.similarity>=0.9 AND cp.near_dup_url<>''
      ORDER BY u.impressions_90 DESC LIMIT 25` },
  keyword_gap: { window: (s) => s.W.live, n: 9, section: "Keywords", name: "Keyword gap",
    purpose: "Keywords a rival ranks for that we earn nothing on",
    scope: "Competitor top-10 keywords, 500+ searches", layout: "findings", src: "ahrefs", tool: "keyword_gap", impact: "monthly_volume" },
};
