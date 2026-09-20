import React, { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { X, Warning } from "@phosphor-icons/react";
import { api, fmt, pct, enc, trunc } from "./api.js";
import { WorkLoader } from "./bits.jsx";
import { MiniBars } from "./charts.jsx";
import { pathOf } from "./site.js";

const EXPECTED_CTR = { 1: .28, 2: .15, 3: .11, 4: .08, 5: .06, 6: .05, 7: .04, 8: .035, 9: .03, 10: .028 };
const isQuestion = (q) => /^(how|what|why|is|are|can|could|does|do|should|which|when|where|who|will)\b/i.test(q);

export default function Drawer({ drawer, onClose }) {
  return (
    <AnimatePresence>
      {drawer && (
        <>
          <motion.div className="drawer-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.div className="drawer" initial={{ x: 620 }} animate={{ x: 0 }} exit={{ x: 620 }} transition={{ type: "spring", stiffness: 320, damping: 34 }}>
            <button className="ghost close" onClick={onClose} aria-label="Close"><X size={14} weight="bold" /></button>
            {drawer.type === "url" ? <UrlDrawer url={drawer.url} from={drawer.from} to={drawer.to} /> : <KwDrawer row={drawer.row} />}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function UrlDrawer({ url, from, to }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [kwFilter, setKwFilter] = useState("");
  useEffect(() => {
    setD(null); setErr(null);
    api(`/api/url-kw-matrix?url=${enc(url)}&from=${from}&to=${to}`)
      .then((r) => (r.error ? setErr(r.error) : setD(r)))
      .catch((e) => setErr(e.message));
  }, [url, from, to]);
  const path = pathOf(url);
  const ml = (m) => { const [y, mm] = m.split("-"); return new Date(y, +mm - 1).toLocaleDateString("en-GB", { month: "short" }) + " '" + y.slice(2); };

  if (err) return <><h3 className="url-cell">{path}</h3><div className="ask-answer"><Warning size={14} weight="fill" style={{ color: "var(--warn)", verticalAlign: "-2px", marginRight: 4 }} />{err}</div></>;
  if (!d) return <><h3 className="url-cell">{path}</h3><WorkLoader steps={["Asking Search Console live for this page's keywords…", "Building month-by-month clicks & positions…", "Ranking the top 30…"]} /></>;

  const rows = (d.rows || []).filter((r) => !kwFilter || r.query.toLowerCase().includes(kwFilter.toLowerCase()));
  if (!d.rows?.length) return <><h3 className="url-cell">{path}</h3><p className="empty">No keyword data from GSC for this page in the selected period.</p></>;

  return (
    <>
      <h3 className="url-cell">{path}</h3>
      <p className="muted small">Top {d.rows.length} keywords · clicks & India position per month · live from GSC · period {from} → {to}</p>
      <input placeholder="search any keyword…" value={kwFilter} onChange={(e) => setKwFilter(e.target.value)} style={{ width: "100%", margin: "8px 0 12px" }} />
      <div className="matrix-wrap">
        <table className="matrix">
          <thead><tr>
            <th className="sticky">Keyword</th>
            {d.months.map((m) => <th key={m} className="num" data-tip="clicks · avg India position">{ml(m)}{d.projection?.m === m ? <span className="faint"> MTD</span> : ""}</th>)}
            {d.projection && <th className="num proj" data-tip={`Run-rate projection: MTD ÷ ${d.projection.daysElapsed} × ${d.projection.daysInMonth} days.`}>{ml(d.projection.m)} Proj</th>}
            <th className="num">Total</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.query}>
                <td className="sticky">{r.query}</td>
                {d.months.map((m) => {
                  const c = r.months[m];
                  return <td key={m} className="num">{c ? <>{fmt(c.clicks)} <span className="faint">· #{c.position.toFixed(1)}</span></> : "·"}</td>;
                })}
                {d.projection && <td className="num proj">{r.months[d.projection.m] ? fmt(Math.round(r.months[d.projection.m].clicks / d.projection.daysElapsed * d.projection.daysInMonth)) : "·"}</td>}
                <td className="num"><b>{fmt(r.total)}</b></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">Each cell: clicks · average India position for that month.</p>
    </>
  );
}

function KwDrawer({ row }) {
  const [d, setD] = useState(null);
  useEffect(() => { api(`/api/keyword-trend?query=${enc(row.query)}`).then(setD); }, [row.query]);
  const months = d?.months || [];
  const ml = (m) => { const [y, mm] = m.split("-"); return new Date(y, +mm - 1).toLocaleDateString("en-GB", { month: "short", year: "2-digit" }); };
  return (
    <>
      <h3>{row.query}</h3>
      <div className="kw-stats">
        <div><span>Clicks</span><b>{fmt(row.clicks)}</b></div>
        <div><span>Impressions</span><b>{fmt(row.impressions)}</b></div>
        <div><span>CTR</span><b>{pct(row.ctr)}</b></div>
        <div><span>Pos (IN)</span><b>{row.position.toFixed(1)}</b></div>
      </div>
      {!d ? <WorkLoader steps={["Loading monthly trend…"]} /> : (
        <>
          <h4>Clicks · {months.length ? `${ml(months[0].month)} – ${ml(months[months.length - 1].month)}` : "no data"}</h4>
          <MiniBars months={months} />
        </>
      )}
    </>
  );
}
