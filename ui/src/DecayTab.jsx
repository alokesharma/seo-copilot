import React, { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { api, fmt, pct, enc, trunc, bucketLabel, urlMatches } from "./api.js";
import { Num, WorkLoader, SkeletonRows, Pill, Spark, SortCaret } from "./bits.jsx";
import { TrendChart } from "./charts.jsx";
import { TrendUp, TrendDown } from "@phosphor-icons/react";
import { pathOf } from "./site.js";

export default function DecayTab({ segment, range, granularity, openDrawer, setDataThrough }) {
  const [overview, setOverview] = useState(null);
  const [metric, setMetric] = useState("clicks");
  const [charttype, setCharttype] = useState("line");
  const [showUpdates, setShowUpdates] = useState(false);
  const [coreTip, setCoreTip] = useState(null);
  const [pages, setPages] = useState(null);
  const [more, setMore] = useState(false);
  const [sort, setSort] = useState("clicks");
  const [sortDir, setSortDir] = useState(1);   // 1 = server order, -1 = reversed
  const [minProj, setMinProj] = useState(false); // only pages with >=500 projected clicks
  const [filter, setFilter] = useState("");
  const [fmode, setFmode] = useState("contains");
  const chartRef = useRef(null);
  const qs = `segment=${enc(segment)}&granularity=${granularity}&from=${range.from}&to=${range.to}`;

  const [mOverview, setMOverview] = useState(null); // always-monthly series for the card delta
  useEffect(() => {
    setOverview(null);
    api(`/api/overview?${qs}`).then((d) => { setOverview(d); if (d.lastDataDate) setDataThrough(d.lastDataDate); });
    setMOverview(null);
    api(`/api/overview?segment=${enc(segment)}&granularity=monthly&from=${range.from}&to=${range.to}`).then(setMOverview);
  }, [qs]);

  useEffect(() => {
    setPages(null);
    api(`/api/urls?${qs}&sort=${sort}&limit=100&offset=0`).then(setPages);
  }, [qs, sort]);

  async function showMore() {
    setMore(true);
    const d = await api(`/api/urls?${qs}&sort=${sort}&limit=100&offset=${pages.rows.length}`);
    setPages((p) => ({ ...d, rows: [...p.rows, ...d.rows] }));
    setMore(false);
  }

  const s = overview?.series || [];
  const sum = (k) => s.reduce((a, r) => a + r[k], 0);
  const clicks = sum("clicks"), impr = sum("impressions"), ctr = impr ? clicks / impr : 0;
  // Card delta = SAME formula as the table's Decay %: first month of the period
  // vs the latest month projected to full-month run-rate.
  const ms = mOverview?.series || [];
  let delta = 0, deltaLabel = "";
  if (ms.length >= 2 && mOverview?.lastDataDate) {
    const first = ms[0], last = ms[ms.length - 1];
    const ld = new Date(mOverview.lastDataDate);
    const isPartial = last.bucket === mOverview.lastDataDate.slice(0, 7);
    const dim = new Date(ld.getFullYear(), ld.getMonth() + 1, 0).getDate();
    const projLatest = isPartial ? Math.round(last.clicks / ld.getDate() * dim) : last.clicks;
    delta = first.clicks ? Math.round(((projLatest - first.clicks) / first.clicks) * 100) : 0;
    const mName = (b) => { const [y, m] = b.split("-"); return new Date(y, +m - 1).toLocaleDateString("en-GB", { month: "short" }) + " '" + y.slice(2); };
    deltaLabel = `vs ${mName(first.bucket)} (first month · latest ${isPartial ? "projected" : "actual"})`;
  }

  const proj = pages?.projection;
  const buckets = pages?.buckets || [];
  const lastIdx = buckets.length - 1;
  let rows = (pages?.rows || []).filter((r) => urlMatches(r.url, filter, fmode));
  if (minProj) rows = rows.filter((r) => (r.projLatest ?? 0) >= 500);
  if (sortDir === -1) rows = [...rows].reverse();

  return (
    <>
      <div className="cards">
        {[
          { k: "Total clicks", v: clicks, hero: true, up: delta >= 0, deltaVal: delta, deltaCtx: deltaLabel, spark: ms.map((r) => r.clicks) },
          { k: "Total impressions", v: impr, spark: ms.map((r) => r.impressions) },
          { k: "Avg CTR", raw: pct(ctr) },
          { k: "Buckets", raw: `${s.length} ${granularity}` },
        ].map((c, i) => {
          const Arrow = c.up ? TrendUp : TrendDown;
          return (
            <motion.div key={c.k} className={`card${c.hero ? " hero" : ""}`}
              initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: i * 0.07, ease: [0.16, 1, 0.3, 1] }}>
              <div className="k">{c.k}</div>
              <div className="v">{c.raw ?? (overview ? <Num value={c.v} /> : <span className="skel" style={{ display: "inline-block", width: 90, height: 24 }} />)}</div>
              {c.deltaCtx && overview && (
                <div className={`d ${c.up ? "up" : "down"}`}>
                  <Arrow size={13} weight="bold" />{Math.abs(c.deltaVal)}%
                  <span className="dctx">{c.deltaCtx}</span>
                </div>
              )}
              {c.spark && overview && c.spark.length > 1 && (
                <div className="spark"><Spark v={c.spark} color={c.hero ? "var(--accent)" : "var(--faint)"} /></div>
              )}
            </motion.div>
          );
        })}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Trend <span className="muted small">{range.from} → {range.to} · {granularity} · source: GSC</span></h2>
          <div className="row">
            <div className="seg-toggle">
              {[["clicks", "Clicks"], ["impressions", "Impr."], ["ctr", "CTR"], ["position", "Pos (IN)"]].map(([m, l]) => (
                <button key={m} className={metric === m ? "active" : ""} onClick={() => setMetric(m)}>{l}</button>
              ))}
            </div>
            <div className="seg-toggle">
              {["line", "bar", "area"].map((t) => (
                <button key={t} className={charttype === t ? "active" : ""} onClick={() => setCharttype(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
              ))}
            </div>
            <label className="chk"><input type="checkbox" checked={showUpdates} onChange={(e) => setShowUpdates(e.target.checked)} /> Core updates</label>
            <button className="ghost" onClick={() => chartRef.current?.resetZoom()}>Reset zoom</button>
          </div>
        </div>
        <div style={{ height: 300, position: "relative" }}>
          {overview
            ? <TrendChart series={s} metric={metric} charttype={charttype} showUpdates={showUpdates} granularity={granularity} toDate={range.toDate} onCoreTip={setCoreTip} chartRef={chartRef} />
            : <WorkLoader steps={["Querying Search Console data…", "Aggregating 16 months of daily metrics…", "Weighting India positions by impressions…", "Rendering…"]} />}
          {coreTip && (
            <div className="tip" style={{ left: coreTip.x + 14, top: coreTip.y + 40, position: "absolute" }}>
              <b>{coreTip.name}</b><br />{coreTip.desc}
            </div>
          )}
        </div>
        <p className="hint">Drag to zoom · dotted = projected (run-rate off the latest GSC day)</p>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Pages <span className="muted small">
            {pages ? `${rows.length} of ${pages.total} · clicks per ${granularity}` : "…"}
            {proj && ` · projection based on GSC data through ${proj.basedOn}`}
          </span></h2>
          <div className="filter-row">
            <select className="mini" value={fmode} onChange={(e) => setFmode(e.target.value)}>
              <option value="contains">Path contains</option>
              <option value="exact">Exact URL</option>
            </select>
            <input placeholder="filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <label className="chk" data-tip="Hide micro-pages: only show pages whose projected clicks for the latest month are 500 or more.">
              <input type="checkbox" checked={minProj} onChange={(e) => setMinProj(e.target.checked)} /> ≥500 proj. clicks
            </label>
          </div>
        </div>

        {!pages ? (
          <>
            <WorkLoader steps={["Ranking 1,000 pages by clicks…", "Building the month-by-month matrix…", "Computing MoM decay per page…", "Projecting the current month…"]} />
            <SkeletonRows n={8} />
          </>
        ) : (
          <>
            <div className="matrix-wrap">
              <table className="matrix">
                <thead>
                  <tr>
                    <th className="sticky">URL</th>
                    {buckets.map((bk, i) => proj && i === lastIdx ? (
                      <React.Fragment key={bk}>
                        <th className="num">{bucketLabel(bk)} MTD <span className="faint">({proj.daysElapsed}d)</span></th>
                        <th className="num proj" data-tip={`Run-rate projection: MTD ÷ ${proj.daysElapsed} × ${proj.daysInMonth} days, off the newest GSC day (${proj.basedOn}).`}>{bucketLabel(bk)} Proj</th>
                      </React.Fragment>
                    ) : <th key={bk} className="num">{bucketLabel(bk)}</th>)}
                    <th className={`num sortable ${sort === "clicks" ? "sorted" : ""}`} onClick={() => { if (sort === "clicks") setSortDir(-sortDir); else { setSort("clicks"); setSortDir(1); } }}><span className="thlbl">Total{sort === "clicks" ? <SortCaret dir={sortDir} /> : null}</span></th>
                    <th className={`num sortable ${sort === "decay" ? "sorted" : ""}`} onClick={() => { if (sort === "decay") setSortDir(-sortDir); else { setSort("decay"); setSortDir(1); } }} data-tip="Latest month (projected) vs the first month of the selected period. Example: Jan 10,000 → Jul projected 6,000 = −40%."><span className="thlbl">Decay %{sort === "decay" ? <SortCaret dir={sortDir} /> : null}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const path = pathOf(r.url);
                    return (
                      <tr key={r.url} className="clickable" onClick={() => openDrawer({ type: "url", url: r.url, from: range.from, to: range.to })}>
                        <td className="sticky url-cell">{path}</td>
                        {r.cells.map((c, i) => {
                          const isLast = i === r.cells.length - 1;
                          const partial = isLast && pages.partialLast;
                          let cls = "";
                          if (i > 0 && !partial) cls = c > r.cells[i - 1] ? "cell-up" : c < r.cells[i - 1] ? "cell-down" : "";
                          return (
                            <React.Fragment key={i}>
                              <td className={`num ${cls} ${partial ? "dim" : ""}`}>{c ? fmt(c) : "·"}</td>
                              {proj && isLast && <td className="num proj">{r.projected != null ? fmt(r.projected) : "·"}</td>}
                            </React.Fragment>
                          );
                        })}
                        <td className="num"><b>{fmt(r.clicks)}</b></td>
                        <td className="num"><Pill v={r.decayPct} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {pages.rows.length < pages.total && (
              <button className="ghost" style={{ marginTop: 12 }} disabled={more} onClick={showMore}>
                {more ? "Loading…" : `Show more (${pages.total - pages.rows.length} left)`}
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}
