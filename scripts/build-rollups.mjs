// Pre-aggregated rollups so the API reads ~thousands of rows instead of scanning
// 1.6M daily rows on every segment/period switch. Rebuild after every backfill.
//   node scripts/build-rollups.mjs
import { runFile, query, setMeta } from "./lib/d1.mjs";

console.log("Building gsc_monthly…");
runFile(`
CREATE TABLE IF NOT EXISTS gsc_monthly (
  month TEXT NOT NULL, url TEXT NOT NULL, segment TEXT NOT NULL,
  clicks INTEGER NOT NULL, impressions INTEGER NOT NULL,
  pos_w REAL NOT NULL,  -- SUM(position_in * impressions) for weighted avg
  PRIMARY KEY (month, url)
);
DELETE FROM gsc_monthly;
INSERT INTO gsc_monthly
SELECT substr(date,1,7), url, segment, SUM(clicks), SUM(impressions),
       SUM(position_in*impressions)
  FROM gsc_daily GROUP BY substr(date,1,7), url;
CREATE INDEX IF NOT EXISTS idx_gm_seg ON gsc_monthly(segment, month);
`);

console.log("Building gsc_weekly…");
runFile(`
CREATE TABLE IF NOT EXISTS gsc_weekly (
  week TEXT NOT NULL, url TEXT NOT NULL, segment TEXT NOT NULL,
  clicks INTEGER NOT NULL, impressions INTEGER NOT NULL, pos_w REAL NOT NULL,
  PRIMARY KEY (week, url)
);
DELETE FROM gsc_weekly;
INSERT INTO gsc_weekly
SELECT strftime('%Y-W%W', date), url, segment, SUM(clicks), SUM(impressions),
       SUM(position_in*impressions)
  FROM gsc_daily GROUP BY strftime('%Y-W%W', date), url;
CREATE INDEX IF NOT EXISTS idx_gw_seg ON gsc_weekly(segment, week);
`);

console.log("Building url_windows (90d / prior-90d aggregates)…");
runFile(`
CREATE TABLE IF NOT EXISTS url_windows (
  url TEXT PRIMARY KEY, segment TEXT,
  clicks_90d INTEGER NOT NULL, clicks_prev90 INTEGER NOT NULL,
  impressions_90d INTEGER NOT NULL, pos_w_90d REAL NOT NULL
);
DELETE FROM url_windows;
INSERT INTO url_windows
SELECT url, MAX(segment),
       SUM(CASE WHEN date >= date('now','-90 day') THEN clicks ELSE 0 END),
       SUM(CASE WHEN date >= date('now','-180 day') AND date < date('now','-90 day') THEN clicks ELSE 0 END),
       SUM(CASE WHEN date >= date('now','-90 day') THEN impressions ELSE 0 END),
       SUM(CASE WHEN date >= date('now','-90 day') THEN position_in*impressions ELSE 0 END)
  FROM gsc_daily WHERE date >= date('now','-180 day') GROUP BY url;
CREATE INDEX IF NOT EXISTS idx_qd_query ON query_daily(query);
`);

console.log("Building url_first_seen (NEW-page detection)…");
runFile(`
CREATE TABLE IF NOT EXISTS url_first_seen (url TEXT PRIMARY KEY, first_seen TEXT NOT NULL);
DELETE FROM url_first_seen;
INSERT INTO url_first_seen SELECT url, MIN(date) FROM gsc_daily GROUP BY url;
`);

console.log("Caching segments list…");
const segs = query(
  `SELECT segment, SUM(clicks) clicks, COUNT(DISTINCT url) pages
     FROM gsc_monthly GROUP BY segment HAVING pages >= 5 AND segment <> '/'
    ORDER BY clicks DESC`
);
setMeta("segments_cache", JSON.stringify(segs));
setMeta("max_data_date", query(`SELECT MAX(date) mx FROM gsc_daily`)[0].mx);
setMeta("rollups_built_at", new Date().toISOString());

const m = query(`SELECT COUNT(*) n FROM gsc_monthly`)[0].n;
const w = query(`SELECT COUNT(*) n FROM gsc_weekly`)[0].n;
console.log(`Done. gsc_monthly=${m} rows, gsc_weekly=${w} rows, ${segs.length} segments cached.`);
