import { json } from "./_lib.js";
import { getSerp, serpFeatures } from "./_serp.js";

// Diagnose one flagged page: pull the live India SERP for its keyword, then let
// Gemini classify the cause and propose a concrete fix grounded in that SERP.
export async function onRequestPost({ env, request }) {
  const body = await request.json().catch(() => ({}));
  const { url, query, type, position, ctr, impressions } = body;
  if (!url || !query) return json({ error: "Missing url/query" }, 400);

  const serp = await getSerp(env, query);
  const features = serpFeatures(serp.data);

  if (!env.GEMINI_API_KEY) return json({ url, query, features, note: "Set GEMINI_API_KEY for the written diagnosis." });

  const model = env.GEMINI_MODEL || "gemini-3.5-flash";
  const prompt =
`You are an SEO analyst for the site (India insurance). One page under-performs.

Page: ${url}
Target keyword (India): "${query}"
GSC: India position ${position}, CTR ${(ctr * 100).toFixed(1)}%, impressions ${impressions}. Flag: ${type}.

Live India SERP features:
${features ? JSON.stringify(features, null, 2) : "SERP unavailable (SerpApi key missing) — reason from GSC signals only."}

Give, as short markdown:
**Likely cause** (1-2 sentences, cite the SERP signal — AI Overview, answer box owner, ads, competitor titles).
**Fix** (2-4 concrete bullet actions; if a title/meta rewrite, give an example benchmarked against the top organic titles).`;

  const answer = await gemini(env.GEMINI_API_KEY, model, prompt);
  return json({ url, query, features, serp_cached: serp.cached, diagnosis: answer });
}

async function gemini(key, model, prompt) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }
  );
  const d = await r.json();
  return d?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "(no response)";
}
