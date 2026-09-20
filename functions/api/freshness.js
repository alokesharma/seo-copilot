import { json, cachedJson, params } from "./_lib.js";

// Freshness worklist — MERGED signal per page, ranked by real clicks lost.
// Sources, in trust order:
//   team    = owner attestation (✎)                — absolute truth
//   cms+crawl = Strapi CMS date AND crawler body-change agree (±7d) — highest auto confidence
//   cms     = Strapi CMS updatedAt (non-bulk)       — first-party, next-day, broad coverage
//   crawl   = Screaming Frog body-change / Ahrefs history
//   (none)  = fall back to page-age (old + no signal = Stale)
export async function onRequestGet({ env, request }) {
  return cachedJson(env, request, () => compute(env, request));
}
async function compute(env, request) {
  const p = params(request);
  const like = p.segment && p.segment !== "ALL" ? ` AND c.url LIKE ?` : "";
  const likeArg = p.segment && p.segment !== "ALL" ? [`${SITE}${p.segment}%`] : [];

  // BASE = the UNION of every known URL — from CMS, the crawler, and GSC traffic.
  // A page shows even with zero traffic. Dated by CMS or crawler (both LEFT JOINs).
  // Universe = real content pages only: CMS ∪ crawl (both canonical, first-party).
  // GSC is NOT a URL source (its page dimension is full of #anchors, ?params and
  // non-content paths) — it only supplies traffic numbers via the LEFT JOIN below.
  const likeU = p.segment && p.segment !== "ALL" ? ` AND url LIKE ?` : "";
  const { results } = await env.DB.prepare(
    `WITH urls AS (
       SELECT url FROM cms_freshness
       UNION SELECT url FROM page_content_changes
     )
     SELECT u.url AS url, c.last_changed AS sf_changed, c.tracked_since AS tracked_since,
            c.changes_in_window AS changes, c.date_precision AS precision,
            fs.first_seen AS first_seen, cm.cms_updated AS cms_updated,
            COALESCE(w.clicks_90d,0) AS c90, COALESCE(w.clicks_prev90,0) AS cprev
       FROM (SELECT url FROM urls WHERE url NOT LIKE '%#%' AND url NOT LIKE '%?%'${likeU}) u
       LEFT JOIN page_content_changes c ON c.url = u.url
       LEFT JOIN url_first_seen fs ON fs.url = u.url
       LEFT JOIN cms_freshness cm ON cm.url = u.url
       LEFT JOIN url_windows w ON w.url = u.url`
  ).bind(...likeArg).all();

  const blindMeta = await env.DB.prepare(`SELECT value FROM meta WHERE key='crawl_blindspots'`).first();
  const now = Date.now();
  const gap = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5;

  const rows = results.map((r) => {
    const decayPct = r.cprev > 0 ? Math.round(((r.c90 - r.cprev) / r.cprev) * 100) : 0;

    // ---- merge the sources into one verdict ----
    let last_changed = null, source = null;
    const cms = r.cms_updated || null;
    const sf = r.sf_changed || null;
    if (r.precision === "attested" && sf) { last_changed = sf; source = "team"; }
    else if (cms && sf) {
      last_changed = cms > sf ? cms : sf;
      source = gap(cms, sf) <= 7 ? "cms+crawl" : (cms > sf ? "cms" : "crawl");
    } else if (cms) { last_changed = cms; source = "cms"; }
    else if (sf) { last_changed = sf; source = r.precision === "approx" ? "crawl~" : "crawl"; }

    const daysSince = last_changed ? Math.round((now - Date.parse(last_changed)) / 864e5) : null;
    const trackedDays = r.tracked_since ? Math.round((now - Date.parse(r.tracked_since)) / 864e5) : null;
    const ageDays = r.first_seen ? Math.round((now - Date.parse(r.first_seen)) / 864e5) : null;
    const isNew = ageDays != null && ageDays <= 90;

    return {
      url: r.url, last_changed, source,
      is_new: isNew ? 1 : 0,
      first_seen: r.first_seen,
      age_days: ageDays,
      observed_days: trackedDays,
      min_stale_days: daysSince,        // days since last_changed (if any)
      clicks_prev90: r.cprev, clicks_90d: r.c90, decayPct,
      clicks_lost: Math.max(0, r.cprev - r.c90),
    };
  }).sort((a, b) => b.clicks_lost - a.clicks_lost);

  return { segment: p.segment, rows, blindspots: blindMeta?.value ? JSON.parse(blindMeta.value) : null };
}
