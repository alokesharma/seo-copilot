-- Per-URL per-day GSC metrics. clicks/impressions/ctr are GLOBAL (all countries);
-- position is stored twice: global + India-only (position_in) from a second pull.
CREATE TABLE IF NOT EXISTS gsc_daily (
  date        TEXT    NOT NULL,           -- YYYY-MM-DD
  url         TEXT    NOT NULL,
  segment     TEXT    NOT NULL,           -- first path part, e.g. /car-insurance/
  clicks      INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  ctr         REAL    NOT NULL DEFAULT 0, -- 0..1 (global)
  position    REAL    NOT NULL DEFAULT 0, -- global avg position
  position_in REAL    NOT NULL DEFAULT 0, -- India-only avg position (the one we display)
  PRIMARY KEY (date, url)
);
CREATE INDEX IF NOT EXISTS idx_gsc_segment_date ON gsc_daily(segment, date);
CREATE INDEX IF NOT EXISTS idx_gsc_url          ON gsc_daily(url);

-- Keyword TREND over time (dimensions = [date, query]; India position). Fewer rows
-- than date x query x page, so safe to keep.
CREATE TABLE IF NOT EXISTS query_daily (
  date        TEXT    NOT NULL,
  query       TEXT    NOT NULL,
  segment     TEXT    NOT NULL DEFAULT '',
  clicks      INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  ctr         REAL    NOT NULL DEFAULT 0,
  position_in REAL    NOT NULL DEFAULT 0,
  PRIMARY KEY (date, query)
);
CREATE INDEX IF NOT EXISTS idx_query_date ON query_daily(date);

-- Top keywords PER URL (snapshot, refreshed weekly; dimensions = [page, query]).
CREATE TABLE IF NOT EXISTS url_keywords (
  url         TEXT    NOT NULL,
  query       TEXT    NOT NULL,
  segment     TEXT    NOT NULL DEFAULT '',
  clicks      INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  ctr         REAL    NOT NULL DEFAULT 0,
  position_in REAL    NOT NULL DEFAULT 0,
  PRIMARY KEY (url, query)
);
CREATE INDEX IF NOT EXISTS idx_urlkw_url ON url_keywords(url);

-- Content freshness from each page's Next.js __NEXT_DATA__ updatedAt.
CREATE TABLE IF NOT EXISTS page_freshness (
  url          TEXT PRIMARY KEY,
  segment      TEXT,
  updated_at   TEXT,
  published_at TEXT,
  checked_at   TEXT
);

-- Cache for SerpApi lookups (avoid re-billing the same keyword within a few days).
CREATE TABLE IF NOT EXISTS serp_cache (
  query      TEXT PRIMARY KEY,
  json       TEXT,
  fetched_at TEXT
);

-- Real content-change tracking from the daily Screaming Frog crawls.
-- last_changed = last crawl date the page BODY actually changed (word-count delta,
-- + body-hash going forward). Replaces the unreliable __NEXT_DATA__ updatedAt.
CREATE TABLE IF NOT EXISTS page_content_changes (
  url               TEXT PRIMARY KEY,
  tracked_since     TEXT,              -- first crawl we saw this page
  last_changed      TEXT,              -- last crawl date the body changed (NULL = no change seen yet)
  changes_in_window INTEGER DEFAULT 0, -- how many changes across tracked crawls
  last_word_count   INTEGER,
  computed_at       TEXT
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

-- ── Tables the agents query that were previously created by side effect ───────
-- A fresh install must have every table an agent touches, so a missing one shows
-- an honest "no data yet" rather than a raw database error.

-- The site crawl. Filled by the nightly Screaming Frog job or a CSV upload.
CREATE TABLE IF NOT EXISTS crawl_pages (
  url TEXT PRIMARY KEY, status_code INTEGER, indexability TEXT, indexability_status TEXT,
  title TEXT, title_len INTEGER, meta_desc TEXT, meta_desc_len INTEGER, h1 TEXT, h2_1 TEXT, h2_2 TEXT,
  meta_robots TEXT, canonical TEXT, word_count INTEGER, crawl_depth INTEGER, inlinks INTEGER,
  outlinks INTEGER, redirect_url TEXT, redirect_type TEXT, response_time REAL, flesch REAL,
  readability TEXT, sentences INTEGER, avg_words_sentence REAL, text_ratio REAL, size_bytes INTEGER,
  link_score REAL, spelling_errors INTEGER, grammar_errors INTEGER,
  near_dup_url TEXT, near_dup_count INTEGER, similar_url TEXT, similarity REAL, similar_count INTEGER,
  crawled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_crawl_status ON crawl_pages(status_code);
CREATE INDEX IF NOT EXISTS idx_crawl_inlinks ON crawl_pages(inlinks);

-- "Pages that matter": product hubs plus top pages by traffic. Built by
-- scripts/universe-build.mjs; every agent scopes to tier 1.
CREATE TABLE IF NOT EXISTS page_universe (
  url TEXT PRIMARY KEY, path TEXT, page_type TEXT, is_money INTEGER, tier INTEGER,
  clicks_90 INTEGER, impressions_90 INTEGER, pos REAL, clicks_prev90 INTEGER,
  rank_clicks INTEGER, rank_impr INTEGER, crawled INTEGER, built_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_universe_tier ON page_universe(tier);

-- Settings written by the Config and Setup tabs: site URL, API keys, email options.
CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);

-- Pages first published, from a CMS feed if one is wired up.
CREATE TABLE IF NOT EXISTS cms_published (
  url TEXT PRIMARY KEY, created TEXT, last_published TEXT, collection TEXT, checked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cms_created ON cms_published(created);

-- Cache for third-party API responses, so repeated runs do not burn quota.
CREATE TABLE IF NOT EXISTS api_cache (key TEXT PRIMARY KEY, json TEXT, fetched_at TEXT);
