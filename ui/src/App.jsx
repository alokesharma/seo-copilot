import React, { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { api, computeRange, autoGranularity, enc } from "./api.js";
import { setSite } from "./site.js";
import { TipLayer, SourceBadges } from "./bits.jsx";
import DecayTab from "./DecayTab.jsx";
import KeywordsTab from "./KeywordsTab.jsx";
import FreshnessTab from "./FreshnessTab.jsx";
import AskTab from "./AskTab.jsx";
import ConfigTab from "./ConfigTab.jsx";
import SetupTab from "./SetupTab.jsx";
import Drawer from "./Drawer.jsx";

const TABS = [
  { id: "decay", label: "Traffic Decay" },
  { id: "keywords", label: "Keywords" },
  { id: "freshness", label: "Freshness" },
  { id: "ask", label: "SEO Copilot" },
  { id: "config", label: "Config" },
  { id: "setup", label: "Setup" },
];

export default function App() {
  const [site, setSiteLabel] = useState("");
  const [segments, setSegments] = useState([]);
  const [segment, setSegment] = useState("ALL");
  const [period, setPeriod] = useState("90");
  const [customFrom, setCustomFrom] = useState(null);
  const [customTo, setCustomTo] = useState(null);
  const [granularity, setGranularity] = useState("weekly");
  const [gOverride, setGOverride] = useState(false);
  const [tab, setTab] = useState(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    return TABS.some((x) => x.id === t) ? t : "decay"; // ?tab= deep-link (and headless testing)
  });
  const [drawer, setDrawer] = useState(null); // {type:'url'|'kw', payload}
  const [dataThrough, setDataThrough] = useState(null);
  const [health, setHealth] = useState(null);
  useEffect(() => {
    const load = () => api("/api/health").then(setHealth).catch(() => {});
    load(); const t = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(t);
  }, []);

  const range = useMemo(() => computeRange(period, granularity, customFrom, customTo), [period, granularity, customFrom, customTo]);
  const days = (Date.parse(range.to) - Date.parse(range.from)) / 864e5;

  // Auto-granularity (Amplitude-style) unless the user overrode it.
  useEffect(() => {
    if (gOverride) return;
    const r = computeRange(period, "daily", customFrom, customTo);
    const d = (Date.parse(r.to) - Date.parse(r.from)) / 864e5;
    setGranularity(autoGranularity(d));
  }, [period, customFrom, customTo, gOverride]);

  useEffect(() => { api("/api/segments").then((d) => setSegments(d.segments || [])); }, []);
  useEffect(() => { api("/api/copilot").then((d) => { setSite(d.site || ""); setSiteLabel(String(d.site || "").replace(/^https?:\/\//, "")); }).catch(() => {}); }, []);

  const ctx = { segment, range, granularity, openDrawer: setDrawer, setDataThrough };
  const freshTab = tab === "freshness";

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <div className="brand-lockup">
            <span className="brand-symbol">
              <img src="/logos/mark.svg" alt="" width="26" height="26" />
            </span>
            <div>
              <h1>SEO Copilot</h1>
              <div className="sub">
                <span>{site || "no site configured"}</span>
                <span className="rail-sep" />
                <span className="statusrail"><SourceBadges /></span>
                {health && health.checks.some((c) => c.status === "warn" || c.status === "bad") && (<>
                  <span className="rail-sep" />
                  <span className="statusrail">
                    {health.checks.filter((c) => c.status === "warn" || c.status === "bad").map((c) => (
                      <span key={c.id} className={`hdot ${c.status}`} data-tip={`${c.label}: ${c.detail}`}>{c.label}</span>
                    ))}
                  </span>
                </>)}
              </div>
            </div>
          </div>
        </div>
        <div className="controls">
          <span>
            <span className="ctl-label">Segment</span>
            <select value={segment} onChange={(e) => setSegment(e.target.value)}>
              <option value="ALL">ALL</option>
              {segments.map((s) => <option key={s.segment} value={s.segment}>{s.segment}</option>)}
            </select>
          </span>
          <span data-tip={freshTab ? "Freshness uses fixed windows (last 90d vs prior 90d, 16-month tracking) — the period selector doesn't apply here." : undefined}>
            <span className="ctl-label">Period</span>
            <select value={period} disabled={freshTab} onChange={(e) => { setPeriod(e.target.value); setGOverride(false); }}>
              <option value="28">Last 28 days</option>
              <option value="90">Last 3 months</option>
              <option value="180">Last 6 months</option>
              <option value="365">Last 12 months</option>
              <option value="490">Last 16 months</option>
              <option value="custom">Custom…</option>
            </select>
          </span>
          {period === "custom" && (
            <span className="filter-row">
              <input type="date" onChange={(e) => setCustomFrom(e.target.value)} /> –
              <input type="date" onChange={(e) => setCustomTo(e.target.value)} />
            </span>
          )}
          {/* granularity only applies to the decay chart — hide it elsewhere rather
              than show a dead control */}
          {tab === "decay" && <div className="seg-toggle" data-tip="Auto-set from the period; click to override">
            {["daily", "weekly", "monthly"].map((g) => (
              <button key={g} className={granularity === g ? "active" : ""} onClick={() => { setGranularity(g); setGOverride(true); }}>
                {g[0].toUpperCase() + g.slice(1)}
              </button>
            ))}
          </div>}
        </div>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
            {t.label}
            {tab === t.id && <motion.div layoutId="tab-ink" className="tab-ink" />}
          </button>
        ))}
      </nav>

      <main>
        <AnimatePresence mode="wait">
          <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }}>
            {tab === "decay" && <DecayTab {...ctx} />}
            {tab === "keywords" && <KeywordsTab {...ctx} />}
            {tab === "freshness" && <FreshnessTab {...ctx} />}
            {tab === "config" && <ConfigTab />}
            {tab === "setup" && <SetupTab />}
            {tab === "ask" && <AskTab {...ctx} />}
          </motion.div>
        </AnimatePresence>
      </main>

      <Drawer drawer={drawer} onClose={() => setDrawer(null)} />
      <TipLayer />
    </>
  );
}
