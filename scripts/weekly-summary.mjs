// Weekly SEO summary for the content team.
//
// Runs LOCALLY (launchd) because Google Apps Script lives in Google's cloud and
// cannot reach this Mac's LAN address. This writes a plain-text brief + a TSV
// block to ~/.seo-copilot-weekly/, which the team's existing Apps Script mail
// pipeline picks up the same way it picks up the daily rankings report.
//
// Every number here is computed in SQL. Nothing is written by a model.
import { query } from "./lib/d1.mjs";
import { siteUrl } from "./lib/site.mjs";
import { putFile } from "./lib/drive.mjs";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";

// Settings live in D1 so the Config tab can edit them without touching this file.
const CFG = Object.fromEntries(query(`SELECT key, value FROM app_config WHERE key LIKE 'weekly_email.%'`)
  .map((r) => [r.key.replace("weekly_email.", ""), r.value]));
const on = (k) => String(CFG.sections || "").split(",").includes(k);
// Segment: "ALL", or a folder like /car-guide/. Applied to every query below, so the
// brief genuinely narrows rather than showing site-wide numbers under a folder name.
const SEG = (CFG.segment || "ALL").trim();
const inSeg = SEG && SEG !== "ALL"
  ? ` AND url IN (SELECT url FROM page_universe WHERE path LIKE '${SEG.replace(/'/g, "''")}%')` : "";
const segLabel = SEG && SEG !== "ALL" ? SEG : "all traffic";

const SITE = siteUrl();
const OUT = process.env.HOME + "/.seo-copilot-weekly";
const one = (sql) => query(sql)[0] || {};
const n = (v) => Number(v || 0).toLocaleString("en-IN");
const pct = (a, b) => (!b ? "n/a" : `${a - b >= 0 ? "+" : ""}${(((a - b) / b) * 100).toFixed(1)}%`);

const TO = one(`SELECT MAX(date) d FROM gsc_daily`).d;
const day = (offset) => one(`SELECT date('${TO}','${offset}') d`).d;
const [d7, d14, d28, d56] = [day("-7 days"), day("-14 days"), day("-28 days"), day("-56 days")];

const tot = (from, to) => one(`SELECT COALESCE(SUM(clicks),0) c, COALESCE(SUM(impressions),0) i
  FROM gsc_daily WHERE date>'${from}' AND date<='${to}'${inSeg}`);
const [w1, w0, m1, m0] = [tot(d7, TO), tot(d14, d7), tot(d28, TO), tot(d56, d28)];

// movers: same 7-day length both sides, so the comparison is like-for-like
const movers = (dir) => query(`WITH a AS (SELECT url, SUM(clicks) c FROM gsc_daily WHERE date>'${d7}' AND date<='${TO}'${inSeg} GROUP BY url),
    b AS (SELECT url, SUM(clicks) c FROM gsc_daily WHERE date>'${d14}' AND date<='${d7}'${inSeg} GROUP BY url),
    u AS (SELECT url FROM a UNION SELECT url FROM b)
  SELECT COALESCE(pu.path, replace(u.url,'${SITE}','')) page,
    COALESCE(b.c,0) prev, COALESCE(a.c,0) now, COALESCE(a.c,0)-COALESCE(b.c,0) delta
  FROM u LEFT JOIN a ON a.url=u.url LEFT JOIN b ON b.url=u.url
  LEFT JOIN page_universe pu ON pu.url=u.url
  ORDER BY delta ${dir} LIMIT 10`);

// Pages actually PUBLISHED in the week, from the CMS. This is createdAt — the
// entry's real birthday. updatedAt bumps on any save and publishedAt bumps on every
// re-publish, so both would report old pages as new.
let newPages = [], cmsAsOf = null;
try {
  cmsAsOf = (query(`SELECT MAX(checked_at) c FROM cms_published`)[0] || {}).c || null;
  newPages = query(`SELECT replace(p.url,'${SITE}','') page, p.created, p.collection,
      COALESCE(u.impressions_90,0) impressions, COALESCE(u.clicks_90,0) clicks
    FROM cms_published p LEFT JOIN page_universe u ON u.url=p.url
    WHERE p.created > '${d7}' AND p.created <= '${TO}'${SEG && SEG !== "ALL" ? ` AND replace(p.url,'${SITE}','') LIKE '${SEG.replace(/'/g, "''")}%'` : ""}
    ORDER BY p.created DESC`);
} catch { cmsAsOf = null; }

const L = [];
L.push(`SEO Copilot — weekly brief`);
L.push(`Week of ${d7} to ${TO} (Search Console, ${segLabel})`);
L.push(``);
L.push(`THIS WEEK (${d7} to ${TO}, vs the 7 days before)`);
L.push(`  Clicks       ${n(w1.c)}   vs ${n(w0.c)}   ${pct(w1.c, w0.c)}`);
L.push(`  Impressions  ${n(w1.i)}   vs ${n(w0.i)}   ${pct(w1.i, w0.i)}`);
L.push(``);
L.push(`THIS MONTH (last 28 days, vs the 28 before — equal lengths)`);
L.push(`  Clicks       ${n(m1.c)}   vs ${n(m0.c)}   ${pct(m1.c, m0.c)}`);
L.push(`  Impressions  ${n(m1.i)}   vs ${n(m0.i)}   ${pct(m1.i, m0.i)}`);
L.push(``);
L.push(`BIGGEST GAINERS (clicks, this week vs last)`);
for (const r of movers("DESC")) L.push(`  +${n(r.delta)}   ${r.page}   (${n(r.prev)} → ${n(r.now)})`);
L.push(``);
L.push(`BIGGEST LOSSES (clicks, this week vs last)`);
for (const r of movers("ASC")) L.push(`  ${n(r.delta)}   ${r.page}   (${n(r.prev)} → ${n(r.now)})`);
L.push(``);
L.push(`NEW PAGES PUBLISHED THIS WEEK (from the CMS)`);
if (!cmsAsOf) L.push(`  CMS not reachable at the last run — not reported rather than guessed.`);
else if (!newPages.length) L.push(`  None published between ${d7} and ${TO}.`);
for (const r of newPages) L.push(`  ${r.created}   ${r.page}   (${n(r.impressions)} impressions so far)`);
L.push(``);
L.push(`Backlinks gained/lost are not included: that data comes from Ahrefs, which`);
L.push(`this brief does not call. Run "Backlinks lost in 90 days" in the dashboard.`);

const text = L.join("\n");

// ── HTML email ────────────────────────────────────────────────────────────────
const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const arrow = (a, b) => (a - b >= 0 ? "▲" : "▼");
const colour = (a, b) => (a - b >= 0 ? "#0f7b4f" : "#b4232c");
const moverRows = (list, sign) => list.map((r) => `<tr>
  <td style="padding:7px 10px;border-bottom:1px solid #eee;font:12px ui-monospace,Menlo,monospace">${esc(r.page)}</td>
  <td style="padding:7px 10px;border-bottom:1px solid #eee;text-align:right;color:${sign > 0 ? "#0f7b4f" : "#b4232c"};font-weight:600">${sign > 0 ? "+" : ""}${n(r.delta)}</td>
  <td style="padding:7px 10px;border-bottom:1px solid #eee;text-align:right;color:#777">${n(r.prev)} → ${n(r.now)}</td></tr>`).join("");
const kpi28 = (label, a, b) => `<td style="padding:14px 16px;border:1px solid #e8e8ea;border-radius:8px;width:50%">
  <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#888">${label}</div>
  <div style="font-size:26px;font-weight:700;color:#111;margin:4px 0 2px">${n(a)}</div>
  <div style="font-size:12px;color:${colour(a, b)}">${arrow(a, b)} ${pct(a, b)} vs previous 28 days</div></td>`;
const kpi = (label, a, b) => `<td style="padding:14px 16px;border:1px solid #e8e8ea;border-radius:8px;width:50%">
  <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#888">${label}</div>
  <div style="font-size:26px;font-weight:700;color:#111;margin:4px 0 2px">${n(a)}</div>
  <div style="font-size:12px;color:${colour(a, b)}">${arrow(a, b)} ${pct(a, b)} vs last week</div></td>`;

const html = `<div style="font:15px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;max-width:680px;margin:0 auto;padding:8px">
  <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6b4fe0;font-weight:700">SEO Copilot</div>
  <h1 style="font-size:22px;margin:4px 0 2px">Weekly brief</h1>
  <div style="color:#777;font-size:13px;margin-bottom:18px">${d7} to ${TO} · Search Console · ${esc(segLabel)}</div>
  <div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#888;font-weight:700;margin:0 8px 6px">This week</div>
  <div style="color:#999;font-size:11px;margin:0 8px 8px">${d7} to ${TO}, against the 7 days before</div>
  <table style="width:100%;border-collapse:separate;border-spacing:8px 0;margin-bottom:22px"><tr>
    ${kpi("Clicks", w1.c, w0.c)}${kpi("Impressions", w1.i, w0.i)}</tr></table>

  <div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#888;font-weight:700;margin:0 8px 6px">This month</div>
  <div style="color:#999;font-size:11px;margin:0 8px 8px">Last 28 days, against the 28 before — equal lengths, so the comparison is like for like</div>
  <table style="width:100%;border-collapse:separate;border-spacing:8px 0;margin-bottom:26px"><tr>
    ${kpi28("Clicks", m1.c, m0.c)}${kpi28("Impressions", m1.i, m0.i)}</tr></table>
  ${on("gainers") ? `<h2 style="font-size:14px;text-transform:uppercase;letter-spacing:.05em;color:#888;margin:0 0 6px">Biggest gainers</h2>
  <table style="width:100%;border-collapse:collapse;margin-bottom:24px">${moverRows(movers("DESC"), 1)}</table>` : ""}
  ${on("losers") ? `<h2 style="font-size:14px;text-transform:uppercase;letter-spacing:.05em;color:#888;margin:0 0 6px">Biggest losses</h2>
  <table style="width:100%;border-collapse:collapse;margin-bottom:24px">${moverRows(movers("ASC"), -1)}</table>` : ""}
  ${on("new_pages") ? `<h2 style="font-size:14px;text-transform:uppercase;letter-spacing:.05em;color:#888;margin:0 0 6px">New pages published this week</h2>
  <table style="width:100%;border-collapse:collapse;margin-bottom:24px">${!cmsAsOf
    ? `<tr><td style="padding:7px 10px;color:#777">The CMS was not reachable at the last run, so this is not reported rather than guessed.</td></tr>`
    : newPages.length
    ? newPages.map((r) => `<tr><td style="padding:7px 10px;border-bottom:1px solid #eee;font:12px ui-monospace,Menlo,monospace">${esc(r.page)}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #eee;text-align:right;color:#777;white-space:nowrap">${esc(r.created)}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #eee;text-align:right;color:#777;white-space:nowrap">${n(r.impressions)} impr</td></tr>`).join("")
    : `<tr><td style="padding:7px 10px;color:#777">None published between ${d7} and ${TO}.</td></tr>`}</table>` : ""}
  <p style="color:#999;font-size:12px;border-top:1px solid #eee;padding-top:14px">
    Every figure here is computed from Search Console. Backlink changes are not included:
    that data comes from Ahrefs, which this brief does not call. Run “Lost links” in the dashboard.
    <br>Open the dashboard: <a href="http://192.168.1.4:8788" style="color:#6b4fe0">192.168.1.4:8788</a>
  </p></div>`;
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/weekly-${TO}.txt`, text);
writeFileSync(`${OUT}/latest.txt`, text);
const tsv = [["metric", "this_week", "last_week", "change_pct"].join("\t"),
  ["clicks", w1.c, w0.c, pct(w1.c, w0.c)].join("\t"),
  ["impressions", w1.i, w0.i, pct(w1.i, w0.i)].join("\t")].join("\n");
writeFileSync(`${OUT}/latest.tsv`, tsv);
writeFileSync(`${OUT}/latest.html`, html);
console.log(text);
console.log(`\nwritten to ${OUT}/latest.txt`);

// ── keep the schedule honest ───────────────────────────────────────────────────
// The tab lets the team pick a day and hour. That setting would be decorative if the
// launchd timer never changed, so reconcile the plist here on every run.
try {
  const DAYS = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
  const wantDay = DAYS[CFG.day] ?? 1, wantHour = Math.max(0, Math.min(23, parseInt(CFG.hour ?? "9", 10) || 9));
  const plist = `${process.env.HOME}/Library/LaunchAgents/com.seocopilot.weekly-summary.plist`;
  const cur = readFileSync(plist, "utf8");
  const has = (k, v) => new RegExp(`<key>${k}</key><integer>${v}</integer>`).test(cur.replace(/\s+/g, ""));
  if (!has("Weekday", wantDay) || !has("Hour", wantHour)) {
    const next = cur
      .replace(/(<key>Weekday<\/key>\s*<integer>)\d+(<\/integer>)/, `$1${wantDay}$2`)
      .replace(/(<key>Hour<\/key>\s*<integer>)\d+(<\/integer>)/, `$1${wantHour}$2`);
    writeFileSync(plist, next);
    execSync(`launchctl bootout gui/$(id -u)/com.seocopilot.weekly-summary 2>/dev/null; launchctl bootstrap gui/$(id -u) ${plist}`, { shell: "/bin/bash" });
    console.log(`schedule updated to ${CFG.day} ${wantHour}:00`);
  }
} catch (e) { console.log("could not reconcile the schedule: " + e.message); }

// ── send ─────────────────────────────────────────────────────────────────────
const to = String(CFG.recipients || "").split(",").map((x) => x.trim()).filter(Boolean);
const subject = `${CFG.subject} · ${d7} to ${TO}`;

// The Workspace blocks anonymous web apps, so the Mac cannot POST to Apps Script.
// It writes the brief into Drive instead, and an Apps Script timer emails it.
async function viaDrive() {
  const payload = JSON.stringify({ subject, to, html, text, generated_at: new Date().toISOString(), week: `${d7} to ${TO}` });
  const id = await putFile("seo-copilot-weekly-brief.json", payload, "application/json");
  return `brief written to Drive (file id ${id}) — the Apps Script timer will email it to ${to.join(", ")}`;
}

async function viaAppsScript() {
  const url = (CFG.apps_script_url || "").trim();
  const secret = (CFG.apps_script_secret || "").trim();
  if (!url || !secret) return "Apps Script is selected but its URL or secret is not set in the Config tab.";
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret, to, subject, html, text, fromName: "SEO Copilot" }),
    redirect: "follow", signal: AbortSignal.timeout(45000) });
  const j = await r.json().catch(() => ({}));
  return j.ok ? `sent to ${to.join(", ")} via Apps Script (quota left ${j.quotaRemaining})`
              : `APPS SCRIPT FAILED ${r.status}: ${j.error || "no reply"}`;
}

async function viaResend() {
  let key = "";
  try { key = readFileSync(process.env.HOME + "/.config/seo-copilot/resend_api_key.txt", "utf8").trim(); } catch {}
  if (!key) return "Resend is selected but no API key was found.";
  const r = await fetch("https://api.resend.com/emails", { method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ from: CFG.from, to, subject, html, text }) });
  const j = await r.json().catch(() => ({}));
  return r.ok ? `sent to ${to.join(", ")} via Resend (id ${j.id || "?"})`
              : `RESEND FAILED ${r.status}: ${j.message || JSON.stringify(j)}`;
}

if (CFG.enabled !== "true") console.log("weekly_email.enabled is not true — not sending.");
else if (!to.length) console.log("no recipients configured — not sending.");
else {
  const how = CFG.transport || "drive";
  const fn = how === "resend" ? viaResend : how === "apps_script" ? viaAppsScript : viaDrive;
  try { console.log(await fn()); } catch (e) { console.log(`SEND FAILED via ${how}: ${e.message}`); }
}
