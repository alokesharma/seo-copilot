import React, { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Warning, Info, PencilSimple } from "@phosphor-icons/react";
import { api, fmt, enc, trunc, urlMatches } from "./api.js";
import { WorkLoader, SkeletonRows, Pill, ResultTable, SortCaret } from "./bits.jsx";
import { pathOf } from "./site.js";

export default function FreshnessTab({ segment }) {
  const [presets, setPresets] = useState([]);
  const [active, setActive] = useState(null);
  const [answer, setAnswer] = useState(null); // {label, rows} | {error} | 'loading'
  const [work, setWork] = useState(null);     // worklist rows
  const [filter, setFilter] = useState("");
  const [fmode, setFmode] = useState("contains");
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState(-1);
  const [statusFilter, setStatusFilter] = useState("All");

  useEffect(() => { api("/api/fresh-presets").then((d) => setPresets(d.presets || [])); }, []);
  const [blind, setBlind] = useState(null);
  useEffect(() => { setWork(null); api(`/api/freshness?segment=${enc(segment)}`).then((d) => { setWork(d.rows || []); setBlind(d.blindspots || null); }); }, [segment]);
  useEffect(() => { if (active) runPreset(active); }, [segment]); // presets follow segment

  async function attest(url) {
    const date = window.prompt(`When was this page last updated? (YYYY-MM-DD)\n${pathOf(url)}`, new Date().toISOString().slice(0, 10));
    if (!date) return;
    const res = await fetch("/api/attest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, date }) }).then((r) => r.json());
    if (res.error) { alert("⚠ " + res.error); return; }
    setWork(null); api.__noop; // refetch
    fetch(`/api/freshness?segment=${enc(segment)}`).then((r) => r.json()).then((d) => { setWork(d.rows || []); setBlind(d.blindspots || null); });
  }
  async function runPreset(id) {
    setActive(id); setAnswer("loading");
    try {
      const res = await fetch(`/api/fresh-presets?id=${id}&segment=${enc(segment)}`).then((r) => r.json());
      setAnswer(res.error ? { error: res.error } : res);
    } catch (e) { setAnswer({ error: e.message }); }
  }

  const fmtD = (x, mo) => x ? new Date(x).toLocaleDateString("en-GB", mo ? { month: "short", year: "numeric" } : { day: "2-digit", month: "short", year: "numeric" }) : "";
  // Status ladder: New / Fresh / Aging / Stale / Unverified — words, not dates.
  // Human label for where a date came from (shown once per row, builds trust).
  const SRC = { team: "you confirmed", "cms+crawl": "CMS + crawl ✓", cms: "CMS", crawl: "crawl", "crawl~": "crawl (approx)" };
  // statusOf → { key (pill), cls (colour), tip (ONE line: date + source) }.
  function statusOf(r) {
    if (r.is_new) return { key: "New", cls: "new", tip: `New page — first seen ${fmtD(r.first_seen)}.` };
    if (r.last_changed) {
      const d = r.min_stale_days ?? 0;
      const src = SRC[r.source] || "tracked";
      const when = r.source === "cms+crawl" || r.source === "crawl~" ? `~${fmtD(r.last_changed, 1)}` : fmtD(r.last_changed);
      const tip = `Updated ${when} · ${src}`;
      if (d < 90) return { key: "Fresh", cls: "up", tip };
      if (d < 180) return { key: "Aging", cls: "warn", tip };
      return { key: "Stale", cls: "down", tip };
    }
    // No date from any source. If the page is old and we've watched it a while with
    // no change, it's stale-by-omission (honest, actionable). Else genuinely unknown.
    const age = r.age_days, obs = r.observed_days ?? 0;
    if (obs >= 14 && age != null && age >= 180)
      return { key: "Stale", cls: "down", tip: `No update found in ${Math.round(age / 30)} mo · not in CMS feed` };
    if (obs >= 14 && age != null && age >= 90)
      return { key: "Aging", cls: "warn", tip: `No recent update found · not in CMS feed` };
    return { key: "Unknown", cls: "neutral", tip: `No date yet — click ✎ to set` };
  }
  const withStatus = (work || []).map((r) => ({ ...r, _status: statusOf(r).key }));
  const counts = withStatus.reduce((m, r) => { m[r._status] = (m[r._status] || 0) + 1; return m; }, {});
  const STATUSES = ["All", "Stale", "Aging", "Fresh", "New", "Unknown"];
  let rows = withStatus.filter((r) => urlMatches(r.url, filter, fmode) && (statusFilter === "All" || r._status === statusFilter));
  if (sortKey) rows = [...rows].sort((a, b) => {
    if (sortKey === "url" || sortKey === "last_changed") return String(a[sortKey] || "").localeCompare(String(b[sortKey] || "")) * sortDir;
    return ((a[sortKey] ?? -1) - (b[sortKey] ?? -1)) * sortDir;
  });
  const th = (key, label, tip) => (
    <th className={`num ${sortKey === key ? "sorted" : ""}`} data-sort={key} data-tip={tip}
        onClick={() => { setSortDir(sortKey === key ? -sortDir : -1); setSortKey(key); }}>
      <span className="thlbl">{label}{sortKey === key ? <SortCaret dir={sortDir < 0 ? 1 : -1} /> : null}</span>
    </th>
  );
  const updated = (r) => { const s = statusOf(r); return <span className={`pill ${s.cls}`} data-tip={s.tip}>{s.key}</span>; };

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h2>Ask about freshness <span className="muted small">instant answers from verified content-change data · source: Screaming Frog + Ahrefs</span></h2>
        </div>
        <div className="presets">
          {presets.map((p) => (
            <button key={p.id} className={active === p.id ? "on" : ""} data-tip={p.hint} onClick={() => runPreset(p.id)}>{p.label}</button>
          ))}
        </div>
        {answer === "loading" && <WorkLoader steps={["Running the verified-change query…", "Joining 90-day GSC windows…", "Ranking results…"]} />}
        {answer && answer !== "loading" && answer.error && <div className="ask-answer"><Warning size={14} weight="fill" style={{ color: "var(--warn)", verticalAlign: "-2px", marginRight: 4 }} />{answer.error}</div>}
        {answer && answer !== "loading" && !answer.error && (
          <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
            <div className="ask-answer"><b>{answer.label}</b> — {answer.rows?.length || 0} results · segment: {segment}</div>
            <ResultTable rows={answer.rows} />
          </motion.div>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Pages to refresh <span className="muted small">losing the most traffic + not updated recently → start at the top</span>
            <span className="how-link" data-tip="How freshness is determined: primary source is the Strapi CMS 'last updated' date (first-party, refreshed daily; bulk migrations excluded). The daily site crawl confirms body changes — when both agree the row is marked 'CMS + crawl ✓'. Pages not in the CMS feed fall back to crawl + page age. Fresh = updated <3 months, Aging = 3–6, Stale = 6+ months or no update found. Wrong? Click the edit icon on any row to set the real date (overrides everything)."><Info size={13} weight="bold" style={{ verticalAlign: "-2px", marginRight: 4 }} />How this works</span></h2>
          <div className="filter-row">
            <select className="mini" value={fmode} onChange={(e) => setFmode(e.target.value)}>
              <option value="contains">Path contains</option>
              <option value="exact">Exact URL</option>
            </select>
            <input placeholder="filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
        </div>
        <div className="presets" style={{ marginBottom: 10 }}>
          {STATUSES.map((s) => (
            <button key={s} className={statusFilter === s ? "on" : ""} onClick={() => setStatusFilter(s)}>
              {s} {s === "All" ? `(${withStatus.length})` : `(${counts[s] || 0})`}
            </button>
          ))}
        </div>
        {blind && blind.count > 0 && (
          <div className="ask-answer" style={{ marginBottom: 12 }}>
            <Warning size={14} weight="fill" style={{ color: "var(--warn)", verticalAlign: "-2px", marginRight: 4 }} /><b>{blind.count} traffic pages</b> ({blind.clicks_at_stake?.toLocaleString("en-IN")} clicks/90d) aren't reachable through internal links, so the daily crawl misses them — they're now crawled directly every day (list mode). This is also an internal-linking fix-list for the team.{blind.not_in_sitemap != null && <> Separately, <b>{blind.not_in_sitemap} traffic pages are missing from sitemap.xml</b> — regenerate it from GSC/DB truth, not from a crawl.</>}
          </div>
        )}
        {!work ? (
          <>
            <WorkLoader steps={["Loading verified content-change dates…", "Joining traffic deltas…", "Ranking by real clicks lost…"]} />
            <SkeletonRows n={8} />
          </>
        ) : (
          <table>
            <thead><tr>
              <th data-sort="url" onClick={() => { setSortDir(sortKey === "url" ? -sortDir : 1); setSortKey("url"); }}>URL</th>
              {th("min_stale_days", "Last updated", "When the page was last updated. Hover a pill for the date + source.")}
              {th("clicks_prev90", "Clicks: prev 90d", "Clicks earned in the PREVIOUS 90-day window (roughly 6 to 3 months ago).")}
              {th("clicks_90d", "Clicks: last 90d", "Clicks earned in the LAST 90 days.")}
              {th("clicks_lost", "Drop ⓘ", "Previous 90d minus last 90d — the clicks actually lost. The list is ranked by this.")}
              {th("decayPct", "Change %", "Drop as a percentage of the previous 90 days. E.g. 350 → 7 clicks = −98%.")}
            </tr></thead>
            <tbody>
              {rows.slice(0, 400).map((r) => (
                <tr key={r.url}>
                  <td className="url-cell"><a href={r.url} target="_blank" rel="noreferrer">{pathOf(r.url)}</a></td>
                  <td className="num">{updated(r)}
                    {!r.last_changed && <button className="ghost" style={{ marginLeft: 6, padding: "3px 7px" }} data-tip="Team knows when this was updated? Record it (owner attestation — shown as team-confirmed)." onClick={() => attest(r.url)}><PencilSimple size={12} weight="bold" /></button>}
                  </td>
                  <td className="num">{fmt(r.clicks_prev90)}</td>
                  <td className="num">{fmt(r.clicks_90d)}</td>
                  <td className="num"><b>{fmt(r.clicks_lost)}</b></td>
                  <td className="num"><Pill v={r.decayPct} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
