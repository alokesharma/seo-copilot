// Setup and Google OAuth for a self-hosted install.
//
// Each user registers their OWN Google Cloud OAuth client (Desktop app) and pastes
// the client id + secret here. That keeps this a tool you clone and run: their
// Search Console data never passes through anyone else's infrastructure, there is
// no 100-user cap, and no unverified-app warning.
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
// Desktop-app clients use a loopback redirect, so it must match whatever host and
// port this install is actually served on — not a hardcoded 8788.
const redirectFor = (request) => {
  const u = new URL(request.url);
  return `${u.protocol}//${u.host}/api/setup/callback`;
};

async function cfg(env, key) {
  const r = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(key).first().catch(() => null);
  return r?.value || "";
}
async function put(env, key, value) {
  await env.DB.prepare(`INSERT INTO app_config(key,value,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .bind(key, String(value ?? ""), new Date().toISOString()).run();
}

/** Trade a refresh token for an access token. */
async function accessToken(env) {
  const [id, secret, refresh] = await Promise.all([
    cfg(env, "google.client_id"), cfg(env, "google.client_secret"), cfg(env, "google.refresh_token")]);
  if (!id || !secret || !refresh) return null;
  const r = await fetch(GOOGLE_TOKEN, { method: "POST",
    body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: "refresh_token" }),
    signal: AbortSignal.timeout(20000) });
  const d = await r.json().catch(() => ({}));
  return d.access_token || null;
}

/** Which Search Console properties can this connection read? */
async function properties(env) {
  const at = await accessToken(env);
  if (!at) return null;
  const r = await fetch("https://www.googleapis.com/webmasters/v3/sites",
    { headers: { authorization: "Bearer " + at }, signal: AbortSignal.timeout(20000) });
  const d = await r.json().catch(() => ({}));
  return (d.siteEntry || []).map((s) => ({ url: s.siteUrl, permission: s.permissionLevel }));
}

export async function onRequestGet({ env, request }) {
  const u = new URL(request.url);

  // ── OAuth callback: Google sends the user back here with a code ──
  if (u.pathname.endsWith("/callback")) {
    const code = u.searchParams.get("code"), err = u.searchParams.get("error");
    const page = (title, body, ok) => new Response(
      `<!doctype html><meta charset=utf-8><title>${title}</title>
       <style>body{font:15px/1.6 -apple-system,system-ui,sans-serif;max-width:34rem;margin:14vh auto;padding:0 1.5rem;color:#111}
       h1{font-size:19px;margin:0 0 .5rem}p{color:#5c5c58}.dot{width:38px;height:38px;border-radius:50%;
       display:grid;place-items:center;font-size:20px;color:#fff;background:${ok ? "#346538" : "#9f2f2d"};margin-bottom:1rem}</style>
       <div class=dot>${ok ? "✓" : "!"}</div><h1>${title}</h1><p>${body}</p>`,
      { headers: { "content-type": "text/html; charset=utf-8" } });

    if (err) return page("Google returned an error", `Google said: <code>${err}</code>. Close this tab and try Connect again.`, false);
    if (!code) return page("No authorisation code", "Google did not send a code back. Close this tab and try Connect again.", false);

    const [id, secret] = await Promise.all([cfg(env, "google.client_id"), cfg(env, "google.client_secret")]);
    const r = await fetch(GOOGLE_TOKEN, { method: "POST",
      body: new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: redirectFor(request), grant_type: "authorization_code" }),
      signal: AbortSignal.timeout(20000) });
    const d = await r.json().catch(() => ({}));
    if (!d.refresh_token) {
      return page("Could not complete the connection",
        `Google replied: <code>${(d.error_description || d.error || "no refresh token")}</code>.
         If you have connected before, revoke this app at myaccount.google.com/permissions and try again.`, false);
    }
    await put(env, "google.refresh_token", d.refresh_token);
    return page("Search Console connected",
      "You can close this tab and go back to the tool. Your properties will be listed in Setup.", true);
  }

  // ── status: what is configured, what is missing, what works ──
  const [site, id, secret, refresh, gemini] = await Promise.all([
    cfg(env, "site.url"), cfg(env, "google.client_id"), cfg(env, "google.client_secret"),
    cfg(env, "google.refresh_token"), cfg(env, "keys.gemini")]);
  const props = refresh ? await properties(env) : null;
  const optional = {};
  for (const k of ["ahrefs", "serpapi", "firecrawl"]) optional[k] = !!(await cfg(env, "keys." + k));

  return json({
    redirect_uri: redirectFor(request),
    steps: {
      site: { done: !!site, value: site },
      google_client: { done: !!(id && secret) },
      google_connected: { done: !!refresh && Array.isArray(props), properties: props || [] },
      gemini: { done: !!gemini },
    },
    optional,
    // without a model key the tool still runs every agent and shows the evidence —
    // it just cannot write the headline, the action, or answer free-text questions
    degraded: !gemini,
  });
}

export async function onRequestPost({ env, request }) {
  const u = new URL(request.url);
  const body = await request.json().catch(() => ({}));

  // ── save the user's own OAuth client, then hand back the consent URL ──
  if (u.pathname.endsWith("/google")) {
    const id = String(body.client_id || "").trim(), secret = String(body.client_secret || "").trim();
    if (!/\.apps\.googleusercontent\.com$/.test(id))
      return json({ ok: false, error: "That does not look like a client ID. It ends in .apps.googleusercontent.com" }, 400);
    if (secret.length < 10) return json({ ok: false, error: "That client secret looks too short." }, 400);
    await put(env, "google.client_id", id);
    await put(env, "google.client_secret", secret);
    const auth = `${GOOGLE_AUTH}?${new URLSearchParams({
      client_id: id, redirect_uri: redirectFor(request), response_type: "code", scope: SCOPE,
      access_type: "offline", prompt: "consent" })}`;
    return json({ ok: true, auth_url: auth });
  }

  // ── disconnect ──
  if (u.pathname.endsWith("/disconnect")) {
    for (const k of ["google.refresh_token"]) await put(env, k, "");
    return json({ ok: true });
  }

  return json({ ok: false, error: "unknown setup action" }, 404);
}
