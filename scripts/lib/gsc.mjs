// GSC Search Analytics via the EXISTING OAuth setup (same as the user's GSC MCP).
// Client secrets + cached refresh token are reused — no service-account key.
import { readFileSync, existsSync } from "node:fs";

// The Downloads copy was deleted when the GSC MCP moved; both files live in
// ~/.gsc-mcp now. This stale path is why query_daily stopped on 13 Aug.
const SECRETS = process.env.GSC_OAUTH_SECRETS_FILE || `${process.env.HOME}/.gsc-mcp/oauth-secrets.json`;
const TOKEN = process.env.GSC_OAUTH_TOKEN_FILE || `${process.env.HOME}/.gsc-mcp/oauth-token.json`;
import { siteProperty } from "./site.mjs";
export const SITE_URL = siteProperty();

let cachedToken = null, expiresAt = 0;

async function accessToken() {
  if (cachedToken && Date.now() < expiresAt - 60000) return cachedToken;
  if (!existsSync(SECRETS)) throw new Error(`OAuth secrets not found at ${SECRETS}`);
  if (!existsSync(TOKEN)) throw new Error(`OAuth token not found at ${TOKEN} — run the GSC MCP once to authorise.`);
  const sec = JSON.parse(readFileSync(SECRETS, "utf8")).installed;
  const tok = JSON.parse(readFileSync(TOKEN, "utf8"));
  const body = new URLSearchParams({
    client_id: sec.client_id, client_secret: sec.client_secret,
    refresh_token: tok.refresh_token, grant_type: "refresh_token",
  });
  let d = null;
  for (let a = 0; ; a++) { // retry: network may be down at scheduled run time
    try {
      const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body, signal: AbortSignal.timeout(30000) });
      d = await r.json(); break;
    } catch (e) {
      if (a >= 5) throw e;
      await new Promise((res) => setTimeout(res, Math.min(60000, 5000 * 2 ** a)));
    }
  }
  if (!d.access_token) throw new Error("Token refresh failed: " + JSON.stringify(d));
  cachedToken = d.access_token;
  expiresAt = Date.now() + (d.expires_in || 3500) * 1000;
  return cachedToken;
}

// Retry transient network/5xx/429 failures with exponential bff.
async function withRetry(fn, tries = 5) {
  let delay = 1000;
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (e.fatal || i >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 15000);
    }
  }
}

// Generic Search Analytics query with pagination and optional India filter.
export async function gscQuery({ startDate, endDate, dimensions, country, rowLimit = 25000 }) {
  const at = await accessToken();
  const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SITE_URL)}/searchAnalytics/query`;
  const rows = [];
  let startRow = 0;
  for (;;) {
    const payload = { startDate, endDate, dimensions, rowLimit, startRow, dataState: "final" };
    if (country) payload.dimensionFilterGroups = [{ filters: [{ dimension: "country", operator: "equals", expression: country }] }];
    const data = await withRetry(async () => {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: "Bearer " + at, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        // without this a stalled request hangs forever and the retry never fires
        signal: AbortSignal.timeout(60000),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`GSC ${res.status} (retryable)`);
      if (!res.ok) throw Object.assign(new Error(`GSC ${res.status}: ${await res.text()}`), { fatal: true });
      return res.json();
    });
    const batch = data.rows || [];
    rows.push(...batch);
    if (batch.length < rowLimit) break;
    startRow += rowLimit;
  }
  return rows;
}
