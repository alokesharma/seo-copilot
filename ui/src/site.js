// The configured site, shared by every view. Set once when the app loads so
// paths can be shown without their domain, whatever site this install analyses.
let SITE = "";
export const setSite = (v) => { SITE = String(v || "").replace(/\/+$/, ""); };
export const getSite = () => SITE;
/** Strip the site's own domain from a URL, leaving the path. */
export const pathOf = (u) => {
  const s = String(u || "");
  if (SITE && s.startsWith(SITE)) return s.slice(SITE.length) || "/";
  return s.replace(/^https?:\/\/[^/]+/, "") || s;
};
