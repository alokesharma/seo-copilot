import React, { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { animate } from "animejs";
import { TrendUp, TrendDown, Info, CaretUp, CaretDown } from "@phosphor-icons/react";
import { fmt, pct, COL_TIPS } from "./api.js";
import { pathOf } from "./site.js";

/* Live count-up (anime.js) — animates from the previous value to the new one. */
export function Num({ value, format = fmt }) {
  const ref = useRef(null);
  const prev = useRef(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const obj = { n: prev.current };
    const to = value || 0;
    const anim = animate(obj, {
      n: to, duration: 950, ease: "outExpo",
      onUpdate: () => { node.textContent = format(Math.round(obj.n)); },
    });
    prev.current = to;
    return () => anim.pause();
  }, [value]);
  return <span ref={ref}>{format(value || 0)}</span>;
}

/* Global cursor tooltip via data-tip. */
export function TipLayer() {
  const [tip, setTip] = useState(null);
  useEffect(() => {
    const over = (e) => {
      const el = e.target.closest("[data-tip]");
      if (el) setTip({ text: el.dataset.tip, x: e.clientX, y: e.clientY });
    };
    const out = (e) => { if (e.target.closest("[data-tip]")) setTip(null); };
    const move = (e) => setTip((t) => (t ? { ...t, x: e.clientX, y: e.clientY } : t));
    document.addEventListener("mouseover", over);
    document.addEventListener("mouseout", out);
    document.addEventListener("mousemove", move);
    return () => { document.removeEventListener("mouseover", over); document.removeEventListener("mouseout", out); document.removeEventListener("mousemove", move); };
  }, []);
  if (!tip) return null;
  return <div className="tip" style={{ left: Math.min(tip.x + 14, window.innerWidth - 300), top: tip.y + 16 }}>{tip.text}</div>;
}

/* Labor-illusion loader: narrates the REAL work being done. */
export function WorkLoader({ steps }) {
  const [i, setI] = useState(0);
  useEffect(() => { const t = setInterval(() => setI((x) => Math.min(x + 1, steps.length - 1)), 900); return () => clearInterval(t); }, []);
  return (
    <div className="worklog">
      <div className="spin" />
      <AnimatePresence mode="wait">
        <motion.span key={i} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.2 }}>
          {steps[i]}
        </motion.span>
      </AnimatePresence>
    </div>
  );
}

export function SkeletonRows({ n = 6, h = 34 }) {
  return (
    <div style={{ display: "grid", gap: 8, padding: "6px 0" }}>
      {Array.from({ length: n }).map((_, i) => <div key={i} className="skel" style={{ height: h, opacity: 1 - i * 0.12 }} />)}
    </div>
  );
}

/* Delta pill with a real directional icon (never a bare ▲/▼ glyph). */
export function Pill({ v, suffix = "%", plus = true }) {
  const cls = v < 0 ? "down" : "up";
  const Icon = v < 0 ? TrendDown : TrendUp;
  return (
    <span className={`pill ${cls}`}>
      <Icon size={11} weight="bold" />
      {v > 0 && plus ? "+" : ""}{v}{suffix}
    </span>
  );
}

/* Generic result table with column tooltips. */
export function ResultTable({ rows }) {
  if (!rows?.length) return <p className="empty">No rows.</p>;
  const cols = Object.keys(rows[0]);
  const cell = (c, v) => (/ctr/i.test(c) && typeof v === "number" && v < 1 ? pct(v) : typeof v === "number" ? fmt(v) : String(v ?? ""));
  return (
    <div style={{ overflowX: "auto" }}>
      <table>
        <thead><tr>{cols.map((c) => (
          <th key={c} className={typeof rows[0][c] === "number" ? "num" : ""} data-tip={COL_TIPS[c] || undefined}>
            <span className="thlbl">{c}{COL_TIPS[c] ? <Info size={12} weight="bold" style={{ color: "var(--faint)" }} /> : null}</span>
          </th>
        ))}</tr></thead>
        <tbody>
          {rows.slice(0, 100).map((r, i) => (
            <tr key={i}>
              {cols.map((c) => <td key={c} className={typeof r[c] === "number" ? "num" : ""}>{c === "url" ? <a href={r[c]} target="_blank" rel="noreferrer">{pathOf(String(r[c]))}</a> : cell(c, r[c])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* SVG sparkline with an anime.js draw-on (stroke reveals left→right). */
export function Spark({ v, w = 90, h = 24, color }) {
  const ref = useRef(null);
  if (!v || v.length < 2) return null;
  const mx = Math.max(...v, 1), mn = Math.min(...v), rng = mx - mn || 1;
  const pts = v.map((x, i) => `${(i / (v.length - 1)) * w},${h - ((x - mn) / rng) * (h - 3) - 2}`).join(" ");
  const up = v[v.length - 1] >= v[0];
  const stroke = color || (up ? "#147a48" : "#bd3a30");
  useEffect(() => {
    const el = ref.current;
    if (!el || !el.getTotalLength) return;
    const len = el.getTotalLength();
    el.style.strokeDasharray = String(len);
    const obj = { o: len };
    const anim = animate(obj, {
      o: 0, duration: 900, delay: 120, ease: "outQuad",
      onUpdate: () => { el.style.strokeDashoffset = String(obj.o); },
    });
    return () => anim.pause();
  }, [pts]);
  return (
    <svg width={w} height={h} aria-hidden>
      <polyline ref={ref} fill="none" stroke={stroke} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" points={pts} />
    </svg>
  );
}

/* Sort caret for table headers (real icon, not a text arrow). */
export function SortCaret({ dir }) {
  return dir === 1
    ? <CaretDown size={11} weight="bold" style={{ marginLeft: 2, verticalAlign: "-1px" }} />
    : <CaretUp size={11} weight="bold" style={{ marginLeft: 2, verticalAlign: "-1px" }} />;
}

/* Data-source badges — REAL brand logos (Simple Icons / official), muted. */
export function SourceBadges() {
  return (
    <>
      <span className="src-badge" data-tip="Traffic, impressions, CTR & India positions — Google Search Console (pulled daily)">
        <img src="/logos/google-search-console.svg" alt="" width="13" height="13" />
        GSC
      </span>
      <span className="src-badge" data-tip="Content-change tracking — daily Screaming Frog crawl (body-only, template rollouts excluded) + Strapi CMS + Ahrefs history">
        <img src="/logos/screaming-frog.svg" alt="" width="13" height="13" />
        Screaming Frog
      </span>
    </>
  );
}
