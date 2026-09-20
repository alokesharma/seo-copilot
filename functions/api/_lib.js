// Shared helpers for the API. Files starting with _ are not routed.

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// SQL expression that buckets the `date` column by the chosen granularity.
export function bucketExpr(granularity) {
  switch (granularity) {
    case "monthly": return "substr(date,1,7)";        // 2026-05
    case "weekly":  return "strftime('%Y-W%W', date)"; // 2026-W19
    default:        return "date";                     // 2026-05-20 (daily)
  }
}

// Optional segment filter. 'ALL' (or empty) => no filter.
export function segmentClause(segment, col = "segment") {
  if (!segment || segment === "ALL") return { sql: "", args: [] };
  return { sql: ` AND ${col} = ?`, args: [segment] };
}

// Optional date range (from/to, YYYY-MM-DD).
export function periodClause(from, to) {
  const sql = [], args = [];
  if (from) { sql.push(" AND date >= ?"); args.push(from); }
  if (to)   { sql.push(" AND date <= ?"); args.push(to); }
  return { sql: sql.join(""), args };
}

// Split a list into chunks (D1 caps bound variables ~100 per query).
export function chunk(arr, size = 90) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function params(request) {
  const u = new URL(request.url);
  const g = (k, d) => u.searchParams.get(k) ?? d;
  return {
    segment: g("segment", "ALL"),
    granularity: g("granularity", "weekly"),
    from: g("from", null),
    to: g("to", null),
    url: g("url", null),
    query: g("query", null),
  };
}

// Server-side response cache. Key = request URL + data version (GSC date + CMS
// pull time), so results serve in ms for EVERY user and auto-invalidate the
// moment new data lands. TTL caps staleness of the version lookup itself.
const _cache = new Map();
let _ver = { v: "", at: 0 };
export async function cachedJson(env, request, compute) {
  const now = Date.now();
  if (now - _ver.at > 60_000) {
    const { results } = await env.DB.prepare(
      `SELECT key, value FROM meta WHERE key IN ('max_data_date','cms_last_pull')`
    ).all();
    _ver = { v: results.map((r) => r.value).join("|"), at: now };
  }
  const key = new URL(request.url).search + "::" + _ver.v + "::" + new URL(request.url).pathname;
  const hit = _cache.get(key);
  if (hit) return json(hit);
  const data = await compute();
  if (_cache.size > 300) _cache.clear(); // simple bound
  _cache.set(key, data);
  return json(data);
}
