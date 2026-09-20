import React, { useEffect, useState } from "react";
import { api, fmt, pct, enc, trunc } from "./api.js";
import { WorkLoader, SkeletonRows, Pill, Spark } from "./bits.jsx";

export default function KeywordsTab({ segment, range, openDrawer }) {
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState("");
  const qs = `segment=${enc(segment)}&from=${range.from}&to=${range.to}`;

  useEffect(() => { setData(null); api(`/api/keywords?${qs}`).then(setData); }, [qs]);

  const rows = (data?.rows || []).filter((r) => !filter || r.query.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Top keywords <span className="muted small">
          India position · click a row for its trend{segment !== "ALL" ? ` · segment keywords from page-level data (last 90d)` : ""}
        </span></h2>
        <input placeholder="filter keyword…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {!data ? (
        <>
          <WorkLoader steps={["Scanning 62,390 tracked keywords…", "Weighting India positions…", "Computing 3-month decay per keyword…"]} />
          <SkeletonRows n={8} />
        </>
      ) : !rows.length ? <p className="empty">No keyword data for this selection.</p> : (
        <table>
          <thead><tr>
            <th>Keyword</th><th className="num">Clicks</th><th className="num">Impr.</th>
            <th className="num">CTR</th><th className="num">Pos IN</th><th className="num">Decay 3mo</th><th>Trend</th>
          </tr></thead>
          <tbody>
            {rows.slice(0, 300).map((r) => (
              <tr key={r.query} className="clickable" onClick={() => openDrawer({ type: "kw", row: r })}>
                <td>{trunc(r.query, 46)}</td>
                <td className="num">{fmt(r.clicks)}</td>
                <td className="num">{fmt(r.impressions)}</td>
                <td className="num">{pct(r.ctr)}</td>
                <td className="num">{r.position.toFixed(1)}</td>
                <td className="num"><Pill v={r.decayPct} /></td>
                <td><Spark v={r.spark} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
