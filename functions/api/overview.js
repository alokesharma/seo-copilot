import { json, segmentClause, params } from "./_lib.js";
import { maybeRefresh } from "./_refresh.js";

// Time-series for the trend chart. Monthly/weekly read the pre-aggregated rollup
// tables (thousands of rows); only daily hits gsc_daily (short periods only).
export async function onRequestGet(ctx) {
  const { env, request } = ctx;
  maybeRefresh(ctx); // lazy warehouse top-up, runs in background
  const p = params(request);
  const seg = segmentClause(p.segment);

  let sql, args;
  if (p.granularity === "monthly" || p.granularity === "weekly") {
    const t = p.granularity === "monthly" ? "gsc_monthly" : "gsc_weekly";
    const col = p.granularity === "monthly" ? "month" : "week";
    const fromB = p.granularity === "monthly" ? (p.from || "").slice(0, 7) : isoWeek(p.from);
    const toB = p.granularity === "monthly" ? (p.to || "").slice(0, 7) : isoWeek(p.to);
    sql = `SELECT ${col} AS bucket, SUM(clicks) AS clicks, SUM(impressions) AS impressions,
                  CASE WHEN SUM(impressions)>0 THEN 1.0*SUM(clicks)/SUM(impressions) ELSE 0 END AS ctr,
                  CASE WHEN SUM(impressions)>0 THEN SUM(pos_w)/SUM(impressions) ELSE 0 END AS position
             FROM ${t} WHERE 1=1${seg.sql}
             ${fromB ? `AND ${col} >= ?` : ""} ${toB ? `AND ${col} <= ?` : ""}
            GROUP BY bucket ORDER BY bucket`;
    args = [...seg.args, ...(fromB ? [fromB] : []), ...(toB ? [toB] : [])];
  } else {
    sql = `SELECT date AS bucket, SUM(clicks) AS clicks, SUM(impressions) AS impressions,
                  CASE WHEN SUM(impressions)>0 THEN 1.0*SUM(clicks)/SUM(impressions) ELSE 0 END AS ctr,
                  CASE WHEN SUM(impressions)>0 THEN SUM(position_in*impressions)/SUM(impressions) ELSE 0 END AS position
             FROM gsc_daily WHERE 1=1${seg.sql}
             ${p.from ? "AND date >= ?" : ""} ${p.to ? "AND date <= ?" : ""}
            GROUP BY bucket ORDER BY bucket`;
    args = [...seg.args, ...(p.from ? [p.from] : []), ...(p.to ? [p.to] : [])];
  }

  const [{ results }, maxRow] = await Promise.all([
    env.DB.prepare(sql).bind(...args).all(),
    env.DB.prepare(`SELECT value FROM meta WHERE key='max_data_date'`).first(),
  ]);
  return json({ ...p, series: results, lastDataDate: maxRow?.value || null });
}

function isoWeek(d) {
  if (!d) return null;
  const dt = new Date(d);
  // matches strftime('%Y-W%W')
  const jan1 = new Date(dt.getFullYear(), 0, 1);
  const week = Math.floor(((dt - jan1) / 864e5 + jan1.getDay()) / 7);
  return `${dt.getFullYear()}-W${String(week).padStart(2, "0")}`;
}
