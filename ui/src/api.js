// API helpers + session cache (data only changes on backfill).
const cache = new Map();
export async function api(url, opts) {
  if (!opts) {
    if (!cache.has(url))
      cache.set(url, fetch(url).then((r) => r.json()).catch((e) => { cache.delete(url); throw e; }));
    return cache.get(url);
  }
  const r = await fetch(url, { headers: { "content-type": "application/json" }, ...opts });
  return r.json();
}

export const fmt = (n) => (n ?? 0).toLocaleString("en-IN");
export const compact = (n) => Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n || 0);
export const pct = (n) => (n * 100).toFixed(1) + "%";
export const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
export const enc = encodeURIComponent;
export const LATEST = new Date(Date.now() - 3 * 864e5);
const iso = (d) => d.toISOString().slice(0, 10);

// Period → {from,to}, snapped to full buckets so the first column is never a silent partial.
export function computeRange(period, granularity, customFrom, customTo) {
  let from, to, toDate;
  if (period === "custom" && customFrom && customTo) { from = customFrom; to = customTo; toDate = new Date(customTo); }
  else { toDate = LATEST; from = iso(new Date(toDate.getTime() - (+period) * 864e5)); to = iso(toDate); }
  if (granularity === "monthly" && from.slice(8, 10) !== "01") {
    const [y, m] = from.split("-").map(Number);
    const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
    from = `${ny}-${String(nm).padStart(2, "0")}-01`;
  } else if (granularity === "weekly") {
    const f = new Date(from + "T12:00:00Z");
    const shift = (8 - f.getUTCDay()) % 7;
    if (shift) from = new Date(f.getTime() + shift * 864e5).toISOString().slice(0, 10);
  }
  return { from, to, toDate };
}
export const autoGranularity = (days) => (days >= 180 ? "monthly" : days >= 45 ? "weekly" : "daily");

export function bucketLabel(b) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(b)) return new Date(b).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  if (/^\d{4}-W\d+$/.test(b)) return "W" + b.slice(6) + " '" + b.slice(2, 4);
  if (/^\d{4}-\d{2}$/.test(b)) { const [y, m] = b.split("-"); return new Date(y, +m - 1, 1).toLocaleDateString("en-GB", { month: "short" }) + " '" + y.slice(2); }
  return b;
}
export function bucketToDate(b) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(b)) return new Date(b);
  if (/^\d{4}-\d{2}$/.test(b)) return new Date(b + "-15");
  const m = /^(\d{4})-W(\d+)$/.exec(b); if (m) return new Date(+m[1], 0, 1 + (+m[2]) * 7);
  return new Date(b);
}

// URL filter supporting "contains" and "exact" modes.
export function urlMatches(url, q, mode) {
  if (!q) return true;
  const path = url.replace(SITE, "").toLowerCase();
  const norm = (s) => s.trim().toLowerCase().replace(/^https?:\/\/(www\.)?\.com/, "").replace(/\/+$/, "") + "/";
  if (mode === "exact") return norm(path) === norm(q);
  return url.toLowerCase().includes(q.toLowerCase()) || path.includes(q.toLowerCase());
}

// Confirmed Google core updates (extend as new ones land).
export const CORE_UPDATES = [
  { date: "2025-03-13", name: "March 2025 Core", desc: "Broad core update; rewarded original, people-first content." },
  { date: "2025-06-30", name: "June 2025 Core", desc: "Broad core update; relevance & quality recalibration." },
  { date: "2025-12-10", name: "December 2025 Core", desc: "Broad core update rolling into the new year." },
  { date: "2026-03-15", name: "March 2026 Core", desc: "Site-reputation and helpfulness signals." },
];

export const COL_TIPS = {
  clicks_90d: "Clicks in the last 90 days",
  clicks_prev90: "Clicks in the 90 days before that",
  clicks_lost: "Clicks lost: last 90 days vs the 90 days before",
  last_updated: "Last verified body edit (Screaming Frog daily + Ahrefs history; template rollouts excluded)",
  updated_on: "Date of the verified body edit",
  clicks_before: "Clicks in the 3 weeks BEFORE the edit",
  clicks_after: "Clicks in the 3 weeks AFTER the edit",
  delta: "After minus before (positive = the refresh worked)",
  updates_tracked: "Verified edits in the tracked window",
  position_india: "Impressions-weighted avg Google position in India, last 90 days",
  impressions_90d: "Impressions in the last 90 days",
  stale_pages: "Pages with no verified edit in 6+ months",
  clicks_90d_at_stake: "90-day clicks earned by those stale pages",
};
