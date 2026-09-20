// Localhost SERP proxy. The Pages worker (workerd) can't TLS to serpapi.com on the
// corp network, but Node can (with the corp cert bypass, same as freshness-ahrefs).
// Worker fetches http://127.0.0.1:8799/serp?q=… (plain localhost, always reachable).
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const vars = Object.fromEntries(
  readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const KEY = process.env.SERPAPI_KEY || vars.SERPAPI_KEY;
const FC = process.env.FIRECRAWL_KEY || vars.FIRECRAWL_KEY;
const AH = process.env.AHREFS_TOKEN || vars.AHREFS_TOKEN;
const BING = process.env.BING_KEY || vars.BING_KEY || "";
const PORT = 8799;
const passthrough = async (res, r) => { const txt = await r.text(); res.writeHead(r.status, { "content-type": "application/json" }); res.end(txt); };

createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://x");
    // FireCrawl relay (workerd can't TLS to api.firecrawl.dev on the corp network either)
    if (u.pathname === "/scrape" && req.method === "POST") {
      let body = ""; for await (const c of req) body += c;
      const { url, formats } = JSON.parse(body || "{}");
      return passthrough(res, await fetch("https://api.firecrawl.dev/v2/scrape", { method: "POST", headers: { authorization: `Bearer ${FC}`, "content-type": "application/json" }, body: JSON.stringify({ url, formats: formats || ["markdown"], onlyMainContent: !(formats || []).includes("rawHtml") }), signal: AbortSignal.timeout(45000) }));
    }
    // Ahrefs v3 relay: /ahrefs?path=site-explorer/refdomains&target=...&limit=... (query passthrough)
    if (u.pathname === "/ahrefs") {
      const path = u.searchParams.get("path"); u.searchParams.delete("path");
      const a = new URL(`https://api.ahrefs.com/v3/${path}`); u.searchParams.forEach((v, k) => a.searchParams.set(k, v));
      return passthrough(res, await fetch(a, { headers: { authorization: `Bearer ${AH}`, accept: "application/json" }, signal: AbortSignal.timeout(40000) }));
    }
    // Bing Webmaster relay: /bing?method=GetCrawlIssues&siteUrl=...
    if (u.pathname === "/bing") {
      const m = u.searchParams.get("method"); u.searchParams.delete("method");
      const b = new URL(`https://ssl.bing.com/webmaster/api.svc/json/${m}`); b.searchParams.set("apikey", BING); u.searchParams.forEach((v, k) => b.searchParams.set(k, v));
      return passthrough(res, await fetch(b, { signal: AbortSignal.timeout(40000) }));
    }
    if (!u.pathname.startsWith("/serp")) { res.writeHead(404); return res.end("not found"); }
    const s = new URL("https://serpapi.com/search.json");
    s.searchParams.set("engine", u.searchParams.get("engine") || "google"); // google | google_news
    s.searchParams.set("q", u.searchParams.get("q") || "");
    s.searchParams.set("google_domain", "google.co.in");
    s.searchParams.set("gl", "in"); s.searchParams.set("hl", "en");
    s.searchParams.set("location", "India");
    s.searchParams.set("api_key", KEY);
    const r = await fetch(s.toString(), { signal: AbortSignal.timeout(25000) });
    const body = await r.text();
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(body);
  } catch (e) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(e.message) }));
  }
}).listen(PORT, "127.0.0.1", () => console.log(`serp-proxy on 127.0.0.1:${PORT}`));
