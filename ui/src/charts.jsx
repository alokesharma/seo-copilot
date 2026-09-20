import React, { useMemo, useRef } from "react";
import { Chart as ChartJS, registerables } from "chart.js";
import { Line, Bar } from "react-chartjs-2";
import ChartDataLabels from "chartjs-plugin-datalabels";
import annotationPlugin from "chartjs-plugin-annotation";
import zoomPlugin from "chartjs-plugin-zoom";
import { bucketLabel, bucketToDate, fmt, compact, CORE_UPDATES } from "./api.js";

ChartJS.register(...registerables, annotationPlugin, zoomPlugin);
ChartJS.defaults.font.family = "Inter, sans-serif";
ChartJS.defaults.color = "#626873";

const PURPLE = "#6b3ff2"; //  brand violet

export function TrendChart({ series, metric, charttype, showUpdates, granularity, toDate, onCoreTip, chartRef }) {
  const isPos = metric === "position", isCtr = metric === "ctr";
  const labels = series.map((r) => bucketLabel(r.bucket));
  const raw = series.map((r) => (isCtr ? r.ctr * 100 : r[metric]));

  // Run-rate projection of the in-progress bucket (clicks/impressions, weekly/monthly).
  const proj = useMemo(() => {
    if (!["clicks", "impressions"].includes(metric) || granularity === "daily" || series.length < 2) return null;
    const last = series[series.length - 1];
    if (granularity === "monthly") {
      if (last.bucket !== toDate.toISOString().slice(0, 7)) return null;
      const el = toDate.getDate(), tot = new Date(toDate.getFullYear(), toDate.getMonth() + 1, 0).getDate();
      return el >= tot ? null : Math.round((last[metric] / el) * tot);
    }
    const el = ((toDate.getDay() + 6) % 7) + 1;
    return el >= 7 ? null : Math.round((last[metric] / el) * 7);
  }, [series, metric, granularity]);

  const main = raw.slice();
  const datasets = [];
  if (proj != null) {
    main[main.length - 1] = null;
    const pd = new Array(raw.length).fill(null);
    pd[raw.length - 2] = raw[raw.length - 2];
    pd[raw.length - 1] = proj;
    datasets.push({ label: "projected", data: pd, borderColor: PURPLE, borderDash: [5, 4], pointRadius: 0, borderWidth: 2, fill: false, tension: 0.3, datalabels: { display: false } });
  }
  datasets.unshift({
    label: metric, data: main, borderColor: PURPLE,
    backgroundColor: charttype === "bar" ? PURPLE : "rgba(107,63,242,.08)",
    fill: charttype === "area", tension: 0.3, pointRadius: 0, borderWidth: 2.2, borderRadius: 5,
  });

  const ann = {};
  if (showUpdates) CORE_UPDATES.forEach((cu, i) => {
    const t = new Date(cu.date).getTime();
    let best = -1, bd = Infinity;
    series.forEach((r, idx) => { const dd = Math.abs(bucketToDate(r.bucket).getTime() - t); if (dd < bd) { bd = dd; best = idx; } });
    if (best >= 0 && bd < 40 * 864e5) ann["u" + i] = {
      type: "line", xMin: labels[best], xMax: labels[best],
      borderColor: "rgba(198,40,40,.5)", borderWidth: 1.5, borderDash: [4, 3],
      label: { display: true, content: "GU", position: "start", backgroundColor: "rgba(198,40,40,.9)", color: "#fff", font: { size: 9 }, padding: 3 },
      enter: (ctx, ev) => onCoreTip({ x: ev.x, y: ev.y, ...cu }),
      leave: () => onCoreTip(null),
    };
  });

  const showLbl = series.length <= 16;
  const options = {
    responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
    animation: { duration: 500 },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: "#1a1d23", padding: 10, cornerRadius: 8,
        callbacks: { label: (c) => `${c.dataset.label}: ${isPos ? c.parsed.y?.toFixed(1) : isCtr ? c.parsed.y?.toFixed(2) + "%" : fmt(c.parsed.y)}` },
      },
      annotation: { annotations: ann },
      datalabels: { display: showLbl ? "auto" : false, align: "top", anchor: "end", offset: 3, color: "#626873", font: { size: 10, weight: 600 }, formatter: (v) => (v == null ? "" : isPos ? v.toFixed(1) : isCtr ? v.toFixed(1) + "%" : compact(v)) },
      zoom: { pan: { enabled: true, mode: "x" }, zoom: { drag: { enabled: true, backgroundColor: "rgba(107,63,242,.08)" }, wheel: { enabled: false }, mode: "x" } },
    },
    scales: {
      y: { reverse: isPos, beginAtZero: !isPos, grid: { color: "#eef0f3" }, ticks: { callback: (v) => (isPos ? v : isCtr ? v + "%" : compact(v)) } },
      x: { grid: { display: false }, ticks: { maxTicksLimit: 14, autoSkip: true } },
    },
  };
  const data = { labels, datasets };
  const C = charttype === "bar" ? Bar : Line;
  return <C ref={chartRef} data={data} options={options} plugins={[ChartDataLabels]} height={300} />;
}

export function MiniBars({ months }) {
  const ml = (m) => { const [y, mm] = m.split("-"); return new Date(y, +mm - 1).toLocaleDateString("en-GB", { month: "short", year: "2-digit" }); };
  const data = {
    labels: months.map((r) => ml(r.month)),
    datasets: [{ data: months.map((r) => r.clicks), backgroundColor: PURPLE, borderRadius: 6 }],
  };
  const options = {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      datalabels: { anchor: "end", align: "top", color: "#626873", font: { size: 10, weight: 600 }, formatter: (v) => compact(v) },
      tooltip: { callbacks: { afterLabel: (c) => `pos ${months[c.dataIndex].position.toFixed(1)}` } },
    },
    scales: { y: { beginAtZero: true, grid: { color: "#eef0f3" } }, x: { grid: { display: false } } },
  };
  return <div style={{ height: 200 }}><Bar data={data} options={options} plugins={[ChartDataLabels]} /></div>;
}
