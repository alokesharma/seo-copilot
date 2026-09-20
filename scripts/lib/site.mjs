// The site under analysis, read from the same app_config the Setup tab writes.
// Scripts must never hardcode a domain: this repo is cloned by people analysing
// their own properties.
import { query } from "./d1.mjs";

let cached = null;
export function siteUrl() {
  if (cached !== null) return cached;
  if (process.env.SITE_URL) return (cached = process.env.SITE_URL.replace(/\/+$/, ""));
  const r = query(`SELECT value FROM app_config WHERE key='site.url'`);
  cached = String(r?.[0]?.value || "").replace(/\/+$/, "");
  if (!cached) {
    throw new Error("No site configured. Open the tool, go to Setup, and set the site URL — or export SITE_URL=https://example.com");
  }
  return cached;
}
/** Search Console wants the property with a trailing slash. */
export const siteProperty = () => siteUrl() + "/";
/** Bare domain, for APIs that want example.com rather than a full URL. */
export const siteDomain = () => siteUrl().replace(/^https?:\/\//, "").replace(/^www\./, "");
