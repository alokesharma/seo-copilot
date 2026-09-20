// SerpApi (google engine, India) with a D1 cache so we don't re-bill a keyword.
export async function getSerp(env, query, maxAgeDays = 7) {
  const cached = await env.DB.prepare(`SELECT json, fetched_at FROM serp_cache WHERE query = ?`)
    .bind(query).first();
  if (cached) {
    const age = (Date.now() - Date.parse(cached.fetched_at)) / 864e5;
    if (age < maxAgeDays) return { data: JSON.parse(cached.json), cached: true };
  }
  if (!env.SERPAPI_KEY) return { data: null, cached: false, error: "SERPAPI_KEY not set" };

  const u = new URL("https://serpapi.com/search.json");
  u.searchParams.set("engine", "google");
  u.searchParams.set("q", query);
  u.searchParams.set("google_domain", "google.co.in");
  u.searchParams.set("gl", "in");
  u.searchParams.set("hl", "en");
  u.searchParams.set("location", "India");
  u.searchParams.set("api_key", env.SERPAPI_KEY);

  // workerd can't TLS to serpapi.com on the corp network → try direct first, then the
  // localhost Node proxy (scripts/serp-proxy.mjs), then fall back to a STALE cache entry.
  const proxy = `http://127.0.0.1:8799/serp?q=${encodeURIComponent(query)}`;
  let data = null, lastErr = "";
  for (const ep of [u.toString(), proxy]) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(ep, { headers: { "user-agent": "seo-copilot" }, signal: AbortSignal.timeout(22000) });
        data = await r.json();
        break;
      } catch (e) { lastErr = e.message; await new Promise((res) => setTimeout(res, 300)); }
    }
    if (data) break;
  }
  if (!data) {
    if (cached) return { data: JSON.parse(cached.json), cached: true, stale: true };
    return { data: null, cached: false, error: "SerpApi unreachable from worker: " + lastErr };
  }
  if (data.error) return { data: null, cached: false, error: "SerpApi: " + data.error };
  try {
    await env.DB.prepare(`INSERT OR REPLACE INTO serp_cache(query,json,fetched_at) VALUES(?,?,?)`)
      .bind(query, JSON.stringify(data), new Date().toISOString()).run();
  } catch { /* cache write is best-effort */ }
  return { data, cached: false };
}

// Distil the SERP into the few signals that explain CTR / ranking issues.
export function serpFeatures(data) {
  if (!data) return null;
  const organic = (data.organic_results || []).slice(0, 5).map((o) => ({
    position: o.position, title: o.title, link: o.link, snippet: o.snippet,
  }));
  return {
    has_ai_overview: !!data.ai_overview,
    has_answer_box: !!data.answer_box,
    answer_box_source: data.answer_box?.link || null,
    // SerpAPI does not return an `ads` block for our requests (verified across
    // several high-commercial-intent queries), so we CANNOT count ads. null means
    // "not measured" — it must never be rendered as 0.
    ads_top: Array.isArray(data.ads) ? data.ads.length : null,
    people_also_ask: (data.related_questions || []).map((q) => q.question).slice(0, 6),
    top_organic: organic,
    related_searches: (data.related_searches || []).map((s) => s.query).slice(0, 6),
  };
}
