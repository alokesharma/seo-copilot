// Team-editable settings, stored in D1 so both the dashboard and the local
// weekly-brief script read the same source of truth.
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

// Only these keys may be written. An unknown key is rejected rather than stored,
// so a typo cannot silently create a setting nothing reads.
const FIELDS = {
  // ── the site under analysis ──
  "site.url": { label: "Site URL", type: "text", group: "Site",
    hint: "The property you want to analyse, exactly as it appears in Search Console. For example https://www.example.com" },

  // ── optional API keys: an agent that needs a missing key is disabled, not broken ──
  "keys.ahrefs": { label: "Ahrefs API token", type: "secret", group: "Optional integrations",
    hint: "Enables backlink gap, lost links, anchor text, toxic links and keyword gap. Leave blank to hide those agents." },
  "keys.serpapi": { label: "SerpAPI key", type: "secret", group: "Optional integrations",
    hint: "Enables live SERP checks. Leave blank to hide those agents." },
  "keys.firecrawl": { label: "Firecrawl key", type: "secret", group: "Optional integrations",
    hint: "Enables reading your pages for schema and content checks." },
  "keys.gemini": { label: "Gemini API key", type: "secret", group: "Optional integrations",
    hint: "Required: writes the headline and the action for each answer." },

  "weekly_email.enabled": { label: "Send the weekly brief", type: "bool" },
  "weekly_email.transport": { label: "Send using", type: "choice", options: ["drive", "apps_script", "resend"],
    hint: "Drive is the working route: the Mac writes the brief to your Drive and an Apps Script timer emails it. Direct web apps are blocked by this Workspace; Resend needs a verified domain." },
  "weekly_email.apps_script_url": { label: "Apps Script URL", type: "text_optional", onlyWhen: "weekly_email.transport=apps_script",
    hint: "Only needed for the direct web-app route, which this Workspace blocks. The Drive route needs nothing here." },
  "weekly_email.apps_script_secret": { label: "Apps Script secret", type: "secret", onlyWhen: "weekly_email.transport=apps_script",
    hint: "Must match the SHARED_SECRET script property." },
  "weekly_email.recipients": { label: "Recipients", type: "emails", hint: "Comma-separated. The Resend account must have a verified domain to reach addresses other than the account owner." },
  "weekly_email.from": { label: "From address", type: "text", onlyWhen: "weekly_email.transport=resend",
    hint: "Used only by Resend. On the Drive route the sender is your own Google account." },
  "weekly_email.subject": { label: "Subject line", type: "text" },
  "weekly_email.day": { label: "Send on", type: "choice", hint: "Rewrites the Mac's schedule on the next run.", options: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] },
  "weekly_email.hour": { label: "Send at (hour, 24h)", type: "int", min: 0, max: 23 },
  "weekly_email.segment": { label: "Segment", type: "text", hint: "ALL, or a folder such as /car-guide/. Filters every figure in the brief." },
  "weekly_email.sections": { label: "Include sections", type: "multi", options: ["traffic", "gainers", "losers", "new_pages"] },
};

const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

function validate(key, value) {
  const f = FIELDS[key];
  if (!f) return `"${key}" is not a setting this tool reads`;
  const v = String(value ?? "").trim();
  if (f.type === "bool" && !["true", "false"].includes(v)) return "must be true or false";
  if (f.type === "int") { const n = Number(v); if (!Number.isInteger(n) || n < f.min || n > f.max) return `must be a whole number between ${f.min} and ${f.max}`; }
  if (f.type === "choice" && !f.options.includes(v)) return `must be one of: ${f.options.join(", ")}`;
  if (f.type === "multi") { const bad = v.split(",").map((x) => x.trim()).filter((x) => x && !f.options.includes(x)); if (bad.length) return `unknown section: ${bad.join(", ")}`; }
  if (f.type === "emails") {
    const list = v.split(",").map((x) => x.trim()).filter(Boolean);
    if (!list.length) return "at least one recipient is required";
    const bad = list.filter((x) => !EMAIL.test(x));
    if (bad.length) return `not a valid email address: ${bad.join(", ")}`;
  }
  if (f.type === "text" && !v) return "cannot be empty";
  if (f.type === "text_optional" && v && !/^https:\/\/script\.google\.com\/.+\/exec$/.test(v))
    return "must be a script.google.com deployment URL ending in /exec";
  return null;
}

export async function onRequestGet({ env }) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`).run();
  const { results } = await env.DB.prepare(`SELECT key, value, updated_at FROM app_config`).all();
  const stored = Object.fromEntries((results || []).map((r) => [r.key, r.value]));
  const lastRun = await env.DB.prepare(`SELECT MAX(checked_at) c FROM cms_published`).first().catch(() => ({}));
  return json({
    fields: Object.entries(FIELDS).map(([key, f]) => ({ key, ...f,
      // a secret is never echoed back; the UI shows whether one is set, not what it is
      value: f.type === "secret" ? (stored[key] ? "••••••••" : "") : (stored[key] ?? "") })),
    updated_at: (results || []).reduce((m, r) => (r.updated_at > m ? r.updated_at : m), ""),
    context: {
      schedule: `The brief runs on this Mac via launchd. Changing the day or hour here records your choice; the schedule itself is set in com.seocopilot.weekly-summary.`,
      cms_last_checked: lastRun?.c || null,
    },
  });
}

export async function onRequestPost({ env, request }) {
  const body = await request.json().catch(() => ({}));
  const updates = body.updates || {};
  const errors = {};
  for (const [k, v] of Object.entries(updates)) { const e = validate(k, v); if (e) errors[k] = e; }
  if (Object.keys(errors).length) return json({ ok: false, errors }, 400);

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`).run();
  const now = new Date().toISOString();
  for (const [k, v] of Object.entries(updates)) {
    if (FIELDS[k]?.type === "secret" && /^•+$/.test(String(v))) continue;   // unchanged placeholder
    await env.DB.prepare(`INSERT INTO app_config(key,value,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
      .bind(k, String(v).trim(), now).run();
  }
  return json({ ok: true, saved: Object.keys(updates).length, updated_at: now });
}
