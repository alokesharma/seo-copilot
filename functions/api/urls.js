import { json, cachedJson, segmentClause, params, chunk } from "./_lib.js";

// Pages matrix: per-URL CLICKS by period. Monthly/weekly read rollup tables.
// Current month gets BOTH values: MTD (actual, through the newest GSC day) and
// projected = MTD / days_elapsed × days_in_month, computed off max_data_date.
// Decay % = MoM (last complete vs prior complete). Sorted server-side, paginated.
export async function onRequestGet({ env, request }) {
  return cachedJson(env, request, () => compute(env, request));
}
async function compute(env, request) {
  const p = params(request);
  const u = new URL(request.url);
  const sort = u.searchParams.get("sort") || "clicks";
  const limit = Math.min(parseInt(u.searchParams.get("limit") || "100", 10), 200);
  const offset = parseInt(u.searchParams.get("offset") || "0", 10);
  const seg = segmentClause(p.segment);

  const maxRow = await env.DB.prepare(`SELECT value FROM meta WHERE key='max_data_date'`).first();
  const lastDataDate = maxRow?.value || null;

  const useRollup = p.granularity === "monthly" || p.granularity === "weekly";
  const t = p.granularity === "monthly" ? "gsc_monthly" : p.granularity === "weekly" ? "gsc_weekly" : "gsc_daily";
  const col = p.granularity === "monthly" ? "month" : p.granularity === "weekly" ? "week" : "date";
  // "YYYY-Wnn" is zero-padded, so lexical >=/<= comparisons are correct across
  // years too — the week range is applied IN SQL like month/date. (The old
  // client-side filtering scanned the entire 450k-row weekly table on every
  // request — 13s cold — AND ranked pages by all-time clicks instead of the
  // selected period. One filter fixes both.)
  const bFrom = p.granularity === "monthly" ? (p.from || "").slice(0, 7)
    : p.granularity === "weekly" ? (p.from ? isoWeek(p.from) : null) : p.from;
  const bTo = p.granularity === "monthly" ? (p.to || "").slice(0, 7)
    : p.granularity === "weekly" ? (p.to ? isoWeek(p.to) : null) : p.to;
  const rangeSql = `${bFrom ? ` AND ${col} >= ?` : ""}${bTo ? ` AND ${col} <= ?` : ""}`;
  const rangeArgs = [...(bFrom ? [bFrom] : []), ...(bTo ? [bTo] : [])];

  // Top 1000 URLs by clicks in window.
  const totals = await env.DB.prepare(
    `SELECT url, SUM(clicks) AS clicks FROM ${t} WHERE 1=1${seg.sql}${rangeSql}
      GROUP BY url ORDER BY clicks DESC LIMIT 1000`
  ).bind(...seg.args, ...rangeArgs).all();
  const urls = totals.results.map((r) => r.url);
  if (!urls.length) return { ...p, buckets: [], rows: [], total: 0, lastDataDate };

  // Weekly range filter (client-side on bucket labels derived from from/to dates)
  // DECAY % (team spec): latest month PROJECTED vs FIRST month of the period —
  // always month-based. Computed for ALL candidate urls (drives the sort), from
  // the tiny gsc_monthly rollup (2 months per url).
  const fmRaw = (p.from || "").slice(0, 7);
  const fm = (p.from || "").slice(8, 10) === "01" ? fmRaw : nextMonth(fmRaw);
  const lm = lastDataDate ? lastDataDate.slice(0, 7) : null;
  const dEl = lastDataDate ? new Date(lastDataDate).getDate() : 30;
  const dTot = lastDataDate ? new Date(new Date(lastDataDate).getFullYear(), new Date(lastDataDate).getMonth() + 1, 0).getDate() : 30;
  const projFactor = dTot / dEl;
  const mChunks = await Promise.all(chunk(urls).map((grp) => {
    const ph = grp.map(() => "?").join(",");
    return env.DB.prepare(
      `SELECT url, month, clicks FROM gsc_monthly WHERE url IN (${ph}) AND month IN (?, ?)`
    ).bind(...grp, fm, lm).all();
  }));
  const firstM = new Map(), lastM = new Map();
  for (const r of mChunks.flatMap((x) => x.results)) {
    if (r.month === fm) firstM.set(r.url, r.clicks);
    if (r.month === lm) lastM.set(r.url, r.clicks);
  }

  let rows = totals.results.map((tr) => {
    const first = firstM.get(tr.url) || 0;
    const latestProj = Math.round((lastM.get(tr.url) || 0) * projFactor);
    return {
      url: tr.url, clicks: tr.clicks,
      projLatest: latestProj, firstMonthClicks: first,
      decayPct: first === 0 ? (latestProj > 0 ? 100 : 0) : Math.round(((latestProj - first) / first) * 100),
    };
  });
  rows.sort((a, b) => sort === "decay" ? a.decayPct - b.decayPct : b.clicks - a.clicks);
  const total = rows.length;
  rows = rows.slice(offset, offset + limit);

  // Matrix cells ONLY for the page of rows being displayed (≤limit urls) —
  // this is what makes Daily view fast (raw gsc_daily has no rollup).
  const pageUrls = rows.map((r) => r.url);
  const cellChunks = await Promise.all(chunk(pageUrls).map((grp) => {
    const ph = grp.map(() => "?").join(",");
    return env.DB.prepare(
      `SELECT url, ${col} AS b, SUM(clicks) AS c FROM ${t}
        WHERE url IN (${ph})${rangeSql} GROUP BY url, b`
    ).bind(...grp, ...rangeArgs).all();
  }));
  const cells = cellChunks.flatMap((r) => r.results); // range already applied in SQL
  const buckets = [...new Set(cells.map((r) => r.b))].sort();
  const idx = new Map(buckets.map((b, i) => [b, i]));
  const byUrl = new Map(pageUrls.map((x) => [x, new Array(buckets.length).fill(0)]));
  for (const r of cells) if (byUrl.has(r.url) && idx.has(r.b)) byUrl.get(r.url)[idx.get(r.b)] = r.c;

  let projection = null;
  const last = buckets[buckets.length - 1];
  if (p.granularity === "monthly" && lastDataDate && last === lastDataDate.slice(0, 7)) {
    projection = { daysElapsed: dEl, daysInMonth: dTot, basedOn: lastDataDate };
  }
  const partialLast = p.granularity !== "daily" && buckets.length > 1 &&
    lastDataDate && last && bucketContains(last, lastDataDate, p.granularity);

  rows = rows.map((r) => {
    const arr = byUrl.get(r.url) || [];
    const mtd = arr[arr.length - 1] || 0;
    return { ...r, cells: arr,
      projected: projection ? Math.round(mtd / projection.daysElapsed * projection.daysInMonth) : null };
  });

  return { ...p, buckets, partialLast, projection, lastDataDate, total, offset, limit, rows };
}

function nextMonth(m) {
  const [y, mo] = m.split("-").map(Number);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
}
function bucketContains(bucket, dateISO, granularity) {
  if (granularity === "monthly") return bucket === dateISO.slice(0, 7);
  if (granularity === "weekly") return bucket === isoWeek(dateISO);
  return bucket === dateISO;
}
function isoWeek(d) {
  const dt = new Date(d);
  const jan1 = new Date(dt.getFullYear(), 0, 1);
  const week = Math.floor(((dt - jan1) / 864e5 + jan1.getDay()) / 7);
  return `${dt.getFullYear()}-W${String(week).padStart(2, "0")}`;
}
