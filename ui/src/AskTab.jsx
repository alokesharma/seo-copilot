import React, { useState, useRef, useEffect } from "react";
import { Warning, CaretDown, CheckCircle, XCircle, Copy, Plus, ArrowRight, Check, DownloadSimple, ArrowClockwise, MagnifyingGlass, ArrowUpRight, ArrowUp } from "@phosphor-icons/react";
import { api } from "./api.js";
import { SidebarLight } from "@/components/ui/sidebar-light";
import { EmptyStatesSet } from "@/components/ui/empty-state-kit";
import { CommandDialog, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandShortcut } from "@/components/ui/command";

/* ── formatting: everything the user reads goes through here ── */
const int = (v) => (v === "" || v == null || isNaN(+v) ? String(v ?? "") : Math.round(+v).toLocaleString("en-IN"));
const pct = (v) => (v == null || v === "" || isNaN(+v) ? String(v ?? "") : (+v).toFixed(1).replace(/\.0$/, "") + "%");
const pos = (v) => (v == null || v === "" || isNaN(+v) ? String(v ?? "") : (+v).toFixed(1));
const delta = (v) => (v == null || isNaN(+v) ? String(v ?? "") : (+v > 0 ? "+" : "") + Math.round(+v).toLocaleString("en-IN"));
const dateS = (v) => { if (!v) return ""; const d = new Date(v); return isNaN(d) ? String(v) : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }); };
const cell = (v, type) => type === "int" ? int(v) : type === "pct" ? pct(v) : type === "pos" ? pos(v) : type === "delta" ? delta(v) : type === "date" ? dateS(v) : String(v ?? "");
const GOOD = /(keep|grow|complete|healthy|improved|easy win|winnable|very close|branded|present|has product|gainer|organic-led|linked)/i;
const BAD = /(lost|drop|broken|missing|error|no |none|not found|blocked|spam|toxic|orphan|dead|too long|too short|wrong|split|out of|bleed|loser|takes the click)/i;
const WARN = /(stale|thin|weak|watch|under|slipping|merge|mixed|minor|needs|expand|refresh|close|page 2|chain|single hop)/i;
const tone = (v) => { const s = String(v || ""); return GOOD.test(s) ? "good" : BAD.test(s) ? "bad" : WARN.test(s) ? "warn" : "neutral"; };
const human = (t) => String(t ?? "").replace(/\b\d{4,}\b/g, (n) => (+n >= 1900 && +n <= 2099 ? n : (+n).toLocaleString("en-IN")));
const tsv = (cols, rows) => [cols.map((c) => c.label).join("\t"), ...rows.map((r) => cols.map((c) => String(r[c.key] ?? "")).join("\t"))].join("\n");
const copy = (t) => navigator.clipboard?.writeText(t);

export default function AskTab({ segment, range }) {
  const [reg, setReg] = useState({ agents: [], freshness: {} });
  const KEY = "seocopilot.history.v1";
  const [msgs, setMsgs] = useState(() => {
    // answers survive a tab switch or a reload; they are the record of what was run
    try { return JSON.parse(sessionStorage.getItem(KEY) || "[]"); } catch { return []; }
  });
  useEffect(() => {
    // keep the last 12 — enough to look back over a morning without bloating storage
    try { sessionStorage.setItem(KEY, JSON.stringify(msgs.slice(-12))); } catch {}
  }, [msgs]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(null);       // the agent currently running
  const [plus, setPlus] = useState(false);
  const [done, setDone] = useState({});
  const scroller = useRef(null);
  const ta = useRef(null);
  // a one-line field that grows with the question, so the control never sits
  // two rows tall around a single line of placeholder
  const grow = (el) => { if (!el) return; el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 150) + "px"; };
  useEffect(() => { grow(ta.current); }, [q]);
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPlus((o) => !o); }
      if (e.key === "Escape") setPlus(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => { api("/api/copilot").then(setReg).catch(() => {}); }, []);
  useEffect(() => { scroller.current?.scrollTo({ top: 1e9, behavior: "smooth" }); }, [msgs, busy]);

  const agents = reg.agents || [];
  const sections = [...new Set(agents.map((a) => a.section))];

  // `a` may be an agent, or null when the user just typed a question — the server
  // then picks the agent whose purpose matches and tells us which it chose.
  async function run(a) {
    if (busy) return;
    if (a && (!a.key || a.key === "__ask" || a.key === "?")) a = null;   // never post an unknown agent key
    const asked = q.trim();
    if (!a && !asked) { setPlus(true); return; }
    setBusy(a || { key: "__routing", name: "Finding the right agent", purpose: asked, scope: "Your question" });
    setPlus(false);
    try {
      // the last few answers travel with a typed question, so "show me such top 5"
      // resolves against what was just asked instead of being routed cold
      const history = a ? undefined : msgs.filter((m) => !m.error).slice(-6).map((m) => ({
        question: m.asked || m.routed?.question || m.def?.name || m.name,
        answer: [m.headline, m.rows?.length ? `${m.rows.length} rows: ${(m.columns || []).map((c) => c.label).join(", ")}` : ""].filter(Boolean).join(" · ").slice(0, 300),
        sql: m.generated_sql || undefined,
      }));
      const d = await api("/api/copilot", { method: "POST", body: JSON.stringify({
        agent: a ? a.key : undefined, question: asked || undefined, history, from: range.from, to: range.to, segment }) });
      const def = a || agents.find((x) => x.key === d.agent) || { key: d.agent, name: d.name, purpose: d.purpose };
      setMsgs((m) => [...m, { role: "a", ...d, asked: a ? undefined : asked, def }]);
      if (!a) setQ("");
    } catch (e) { setMsgs((m) => [...m, { role: "a", error: e.message, asked: a ? undefined : asked,
      def: a || { key: "__ask", name: "Your question", purpose: asked } }]); }
    setBusy(null);
  }

  // three agents worth opening on any given morning
  const PINNED = ["content_audit", "keyword_gap", "lost_link_monitor"];
  const [find, setFind] = useState("");
  const hit = (a) => !find.trim() || (a.name + " " + a.purpose + " " + a.section).toLowerCase().includes(find.trim().toLowerCase());
  const matches = agents.filter(hit);

  const Row = ({ a, kind }) => (
    <button key={a.key} className={`${kind === "menu" ? "cp-menu-item" : "cp-agent"} ${busy?.key === a.key ? "on" : ""} ${a.ready === false ? "locked" : ""}`}
      disabled={!!busy || a.ready === false}
      title={a.ready === false ? `Needs a ${a.needs} key — add it in Config` : a.purpose}
      onClick={() => run(a)}>
      <span className="cp-ag-name">{a.name}</span>
      {a.ready === false && <span className="cp-ag-needs">{a.needs}</span>}
      {done[a.key] && <Check size={12} weight="bold" className="cp-ag-done" />}
    </button>
  );

  const navItems = (() => {
    const src = matches;
    const secs = [...new Set(src.map((a) => a.section))];
    const recent = !find.trim() && msgs.length
      ? [{ title: "Recent", href: "#", items: [...msgs].reverse()
            .filter((m, i, arr) => arr.findIndex((x) => (x.def?.key || x.agent) === (m.def?.key || m.agent)) === i)
            .slice(0, 4)
            .map((m) => ({ title: m.def?.name || m.name || "Answer", href: `@${m.def?.key || m.agent}` })) }]
      : [];
    const pinned = !find.trim()
      ? [{ title: "Start here", href: "#", items: PINNED.map((k) => agents.find((a) => a.key === k)).filter(Boolean).filter((a) => a.ready !== false).map((a) => ({ title: a.name, href: `#${a.key}` })) }]
      : [];
    return [...recent, ...pinned, ...secs.map((sec) => ({
      title: sec,
      href: "#",
      items: src.filter((a) => a.section === sec && !(!find.trim() && PINNED.includes(a.key)))
        .map((a) => ({ title: a.ready === false ? `${a.name} · needs ${a.needs}` : a.name,
                       href: a.ready === false ? "#" : `#${a.key}` })),
    })).filter((s) => s.items.length)];
  })();

  // one delegated handler: the rail is a list of links, and a link means "run this"
  const railClick = (e) => {
    const a = e.target.closest("a[href^='#'], a[href^='@']");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href");
    const key = href.slice(1);
    if (href[0] === "@") {                       // a past answer: go to it, do not re-run
      document.getElementById(`ans-${key}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    const agent = agents.find((x) => x.key === key);
    if (agent && !busy) run(agent);
  };

  const Opener = () => {
    const cards = PINNED.map((k) => agents.find((a) => a.key === k)).filter(Boolean);
    return (
      <div className="cp-opener">
        <h2>What should we fix today?</h2>
        <p className="cp-opener-sub">
          Every agent reads your <b>{reg.freshness?.core || "—"} priority pages</b>, the product hubs plus the
          top pages by traffic, and ends with one thing you can do today.
        </p>
        <div className="cp-cards">
          {cards.map((a) => (
            <button key={a.key} className="cp-card" disabled={!!busy} onClick={() => run(a)}>
              <div className="cp-card-sec">{a.section}</div>
              <div className="cp-card-name">{a.name} <ArrowUpRight size={13} weight="bold" /></div>
              <div className="cp-card-why">{a.purpose}</div>
            </button>
          ))}
        </div>
        <div className="cp-fresh-row">
          {reg.freshness?.gsc && <span className="cp-fresh">Search Console to {dateS(reg.freshness.gsc)}</span>}
          {reg.freshness?.crawl && <span className="cp-fresh">Site crawl {dateS(reg.freshness.crawl)}</span>}
          {reg.freshness?.core && <span className="cp-fresh">{reg.freshness.core} priority pages</span>}
        </div>
      </div>
    );
  };

  return (
    <div className="cp-grid">
      <aside className="cp-rail">
        <div className="cp-rail-head"><b>SEO Copilot</b><span className="cp-rail-count">{agents.length}</span>
          {msgs.length > 0 && <button className="cp-clear" title="Clear this session's answers"
            onClick={() => { setMsgs([]); try { sessionStorage.removeItem(KEY); } catch {} }}>Clear</button>}
        </div>
        <label className="cp-find">
          <MagnifyingGlass size={13} weight="bold" />
          <input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find an agent" spellCheck={false} />
        </label>
        <div className="cp-rail-list" onClick={railClick}>
          {navItems.length
            ? <SidebarLight items={navItems} />
            : <div className="cp-norail">No agent matches “{find}”.</div>}
        </div>
      </aside>

      <section className="cp-chat">
        <div className="cp-scroll" ref={scroller}>
          {!msgs.length && !busy && <Opener />}
          {msgs.map((m, i) => (
            <Answer key={i} m={m}
              onDone={() => setDone((d) => ({ ...d, [m.agent || m.def?.key]: true }))}
              onRerun={() => { if (m.asked) { setQ(m.asked); setTimeout(() => run(null), 0); } else if (m.def?.key && m.def.key !== "__ask") run(m.def); }} />
          ))}
          {busy && <Running a={busy} />}
        </div>

        <div className="cp-foot">
          <CommandDialog open={plus} onOpenChange={setPlus}>
            <CommandInput placeholder="Run an agent…" />
            <CommandList>
              <CommandEmpty>No agent matches that.</CommandEmpty>
              {[...new Set(agents.map((a) => a.section))].map((sec) => (
                <CommandGroup key={sec} heading={sec}>
                  {agents.filter((a) => a.section === sec).map((a) => (
                    <CommandItem key={a.key} value={`${a.name} ${a.purpose}`}
                      onSelect={() => { setPlus(false); run(a); }}>
                      <span>{a.name}</span>
                      <CommandShortcut>{a.purpose.slice(0, 44)}</CommandShortcut>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </CommandDialog>
          {/* Structure from 21st.dev @kvnkld/ai-agent-input: the question gets its own
              line and the controls sit on a row beneath, so the field is tall enough
              to read. One border only — the original stacks a transparent border on a
              shadow ring, which is the doubled edge that looked like a bug. */}
          <div className={`cp-beam ${busy ? "is-running" : ""}`}>
          <div className="cp-frame">
            <div className="cp-frame-edit">
              <textarea value={q} rows={1} ref={ta}
                placeholder="Ask anything about your search data, or name a competitor, query or page…"
                onChange={(e) => { setQ(e.target.value); grow(e.target); }}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); run(null); } }} />
            </div>
            <div className="cp-frame-row">
              <button className={`cp-icon ${plus ? "on" : ""}`} title="All agents (⌘K)"
                onClick={() => setPlus((o) => !o)}><Plus size={17} /></button>
              <span className="cp-frame-hint">{q.trim() ? "Enter to ask" : "⌘K for agents"}</span>
              <button className="cp-icon send" disabled={!!busy || !q.trim()} title="Ask"
                onClick={() => run(null)}><ArrowUp size={17} weight="bold" /></button>
            </div>
          </div>
          </div>
          <div className="cp-scope">segment <b>{segment}</b> · {range.from} → {range.to}</div>
        </div>
      </section>
    </div>
  );
}

function Running({ a }) {
  const [t, setT] = useState(0);
  useEffect(() => { const i = setInterval(() => setT((x) => x + 1), 1000); return () => clearInterval(i); }, []);
  // Skeleton of the answer that is coming, so the wait has a shape. The sources are
  // the ones this agent WILL read — never ticked off, because the server does not
  // stream progress and a fake checkmark would be a lie.
  const SRC = { sql: "Search Console", ahrefs: "Ahrefs", scrape: "Page content", serp: "Google SERP", bing: "Bing", sitemap: "Sitemap", news: "News" };
  const reads = a.src ? [SRC[a.src] || a.src, "Search Console"] : ["Search Console"];
  return (
    <div className="cp-answer cp-loading" aria-busy="true">
      <div className="cp-ahead">
        <div><div className="cp-aname">{a.name || "Working"}</div>
          <div className="cp-apurpose">{a.purpose || "Reading your data"}</div></div>
        <div className="cp-badges">{[...new Set(reads)].map((s) => <span key={s} className="cp-src dim">{s}</span>)}</div>
      </div>
      <div className="cp-scopeline"><b>Scope:</b> {a.scope || "your priority pages"} · running for {t}s</div>
      <div className="sk sk-headline" /><div className="sk sk-headline short" />
      <div className="cp-skaction"><div className="sk sk-line w30" /><div className="sk sk-line w70" /><div className="sk sk-line w55" /></div>
      <div className="cp-sktable">{[...Array(5)].map((_, i) => (
        <div className="cp-skrow" key={i}><div className="sk sk-line w40" /><div className="sk sk-line w12" /><div className="sk sk-line w12" /><div className="sk sk-line w12" /></div>))}
      </div>
    </div>
  );
}

function Answer({ m, onDone, onRerun }) {
  const [open, setOpen] = useState(false);
  const [marked, setMarked] = useState(false);
  const d = m.def || {};
  if (m.error) return <div className="cp-answer"><div className="cp-error"><Warning size={16} weight="fill" /><div><b>{d.name || "Agent"} couldn't finish</b><div className="small">{m.error}</div></div><button className="cp-copy" onClick={onRerun}><ArrowClockwise size={13} /> Retry</button></div></div>;

  const empty = !m.rows?.length;
  return (
    <div className="cp-answer" id={`ans-${m.agent || d.key}`}>
      <div className="cp-ahead">
        <div><div className="cp-aname">{m.name || d.name}</div><div className="cp-apurpose">{m.purpose || d.purpose}</div></div>
        <div className="cp-badges">
          {(m.sources || []).map((s) => <span key={s} className="cp-src">{({ sql: "Search Console", scrape: "Page content", serp: "Google SERP", ahrefs: "Ahrefs", bing: "Bing", sitemap: "Sitemap", news: "News", fetch: "Live fetch" })[s] || s}</span>)}
        </div>
      </div>
      <div className="cp-scopeline"><b>Window:</b> {m.scope?.window || `${m.scope?.from} → ${m.scope?.to}`} · <b>Pages:</b> {m.scope?.label}{m.scope?.segment !== "ALL" ? ` · ${m.scope.segment}` : ""}{m.freshness?.gsc ? ` · Search Console data through ${dateS(m.freshness.gsc)}` : ""}</div>

      {empty ? (
        <div className="cp-clean">
          <EmptyStatesSet
            type={m.unchecked ? "error" : "search"}
            title={m.unchecked ? "This check could not finish" : "Nothing to fix here"}
            description={m.empty?.reason}
            actionLabel="Run again"
            onAction={onRerun} />
          <div className="cp-clean-checked">Checked: {m.empty?.checked}</div>
        </div>
      ) : (
        <>
          {(m.routed || m.asked) && <div className="cp-routed">
            You asked: “{m.routed?.question || m.asked}”
            {(m.routed?.resolved || m.resolved) && (m.routed?.resolved || m.resolved) !== (m.routed?.question || m.asked)
              ? <> · understood as <b>{m.routed?.resolved || m.resolved}</b></> : null}
            {m.routed ? <> · answered by <b>{m.name}</b></> : <> · answered from the data</>}
            {m.routed?.segment_from_text ? <> · filtered to <b>{m.routed.segment_from_text}</b></> : null}
          </div>}
          {m.no_model && <div className="cp-nomodel">
            Evidence only. Add a Gemini key in Setup to get the one-line summary and the recommended action.
          </div>}
          {m.headline && <div className="cp-headline">{human(m.headline)}</div>}
          {m.action && (
            <div className="cp-action">
              <div className="k">Do this next</div>
              <h3>{human(m.action.title)}</h3>
              {m.action.page && <div className="cp-action-page">{m.action.page}</div>}
              <p>{human(m.action.why)}</p>
              {m.action.impact && (() => {
                const s = String(m.action.impact);
                const k = /\blost\b|\bloss\b|missed|at risk|down\b/i.test(s) ? "loss"
                        : /\bgain|recover|win|upside|opportunity/i.test(s) ? "gain" : "";
                return <span className={`cp-impact ${k}`}>{human(s)}</span>;
              })()}
              {m.deliverable && <Deliverable d={m.deliverable} layout={m.layout} />}
            </div>
          )}
          <Layout m={m} />
          {Object.entries(m.extras || {}).filter(([, v]) => v.rows?.length).map(([k, v]) => (
            <Findings key={k} title={v.label} columns={v.columns} rows={v.rows} collapsed />
          ))}
        </>
      )}

      <div className="cp-steps">
        <button className="cp-steps-head" onClick={() => setOpen((o) => !o)}>
          How this was computed <span className="faint">· {m.steps?.length || 0} steps · {((m.ms || 0) / 1000).toFixed(1)}s</span>
          <CaretDown size={13} weight="bold" style={{ transform: open ? "rotate(180deg)" : "none", transition: ".15s" }} />
        </button>
        {open && <div className="cp-steps-body">{(m.steps || []).map((s, i) => (
          <div key={i} className="cp-step">{s.ok ? <CheckCircle size={13} weight="fill" className="ok" /> : <XCircle size={13} weight="fill" className="bad" />}
            <span className="cp-step-l">{s.label || s.tool}</span><span className="faint">{s.detail}{s.ms ? ` · ${s.ms}ms` : ""}</span></div>))}
          {m.ungrounded > 0 && <div className="cp-step faint">Removed {m.ungrounded} number{m.ungrounded > 1 ? "s" : ""} the data could not back.</div>}
        </div>}
      </div>

      {!empty && <div className="cp-next">
        <button className={`cp-nextbtn ${marked ? "done" : ""}`} onClick={() => { setMarked(true); onDone(); }}>{marked ? <><Check size={13} weight="bold" /> Marked done</> : "Mark done"}</button>
        <button className="cp-nextbtn" onClick={onRerun}><ArrowClockwise size={13} /> Run again</button>
        {m.rows?.length > 0 && <button className="cp-nextbtn" onClick={() => copy(tsv(m.columns, m.rows))}><DownloadSimple size={13} /> Copy all rows</button>}
      </div>}
    </div>
  );
}

function Deliverable({ d, layout }) {
  const preferCode = layout === "code" && d.content;
  if (d.items?.length && !preferCode) return (
    <div className="cp-deliv">
      <div className="cp-deliv-head"><span>{d.title || "Rewrites"}</span><button className="cp-copy" onClick={() => copy(d.items.map((i) => `${i.label}\nBefore: ${i.before || "(none)"}\nAfter:  ${i.after}`).join("\n\n"))}><Copy size={13} /> Copy all</button></div>
      {d.items.map((i, k) => (
        <div key={k} className="cp-ba">
          <div className="cp-ba-label">{i.label}</div>
          <div className="cp-ba-row"><span className="cp-ba-tag">Before</span><span className="cp-ba-old">{i.before || "— none —"}</span></div>
          <div className="cp-ba-row"><span className="cp-ba-tag new">After</span><span className="cp-ba-new">{i.after}</span><span className="cp-ba-chars">{(i.after || "").length} chars</span>
            <button className="cp-copy sm" onClick={() => copy(i.after)}><Copy size={12} /></button></div>
          {i.note && <div className="cp-ba-note">{i.note}</div>}
        </div>
      ))}
    </div>
  );
  if (!d.content) return null;
  return (
    <div className="cp-deliv">
      <div className="cp-deliv-head"><span>{d.title || "Ready to paste"}</span><button className="cp-copy" onClick={() => copy(d.content)}><Copy size={13} /> Copy</button></div>
      <pre className="cp-code">{d.content}</pre>
    </div>
  );
}

function Layout({ m }) {
  const { layout, columns, rows } = m;
  if (layout === "kpi") return <KPI m={m} />;
  if (layout === "pairs") return <Pairs columns={columns} rows={rows} />;
  return <Findings title={`Findings · ${rows.length}`} columns={columns} rows={rows} note={m.all_rows} />;
}

function Findings({ title, columns, rows, collapsed, note }) {
  const [open, setOpen] = useState(!collapsed);
  const [all, setAll] = useState(false);
  const show = all ? rows : rows.slice(0, 12);
  if (!rows?.length) return null;
  return (
    <div className="cp-result">
      <div className="cp-result-head">
        <button className="t plain" onClick={() => collapsed && setOpen((o) => !o)}>{title}{collapsed && <CaretDown size={12} weight="bold" style={{ marginLeft: 5, transform: open ? "rotate(180deg)" : "none" }} />}</button>
        <button className="cp-copy" onClick={() => copy(tsv(columns, rows))}><Copy size={13} /> Copy</button>
      </div>
      {open && <>
        {note && <div className="cp-allrows">All {rows.length} rows: {human(note)}</div>}
        <div className="cp-tablewrap"><table className="cp-table">
          <thead><tr>{columns.map((c) => <th key={c.key} className={c.align}>{c.label}</th>)}</tr></thead>
          <tbody>{show.map((r, i) => (
            <tr key={i}>{columns.map((c) => (
              <td key={c.key} className={c.align}>
                {c.type === "path" ? <span className="cp-path" title={r[c.key]}>{r[c.key]}</span>
                  : c.type === "badge" ? <span className={`cp-pill ${tone(r[c.key])}`}>{r[c.key]}</span>
                  : c.type === "delta" ? <span className={+r[c.key] >= 0 ? "up" : "down"}>{delta(r[c.key])}</span>
                  : cell(r[c.key], c.type)}
              </td>))}</tr>))}</tbody>
        </table></div>
        {rows.length > 12 && <button className="cp-more" onClick={() => setAll((a) => !a)}>{all ? "Show fewer" : `Show all ${rows.length}`}</button>}
      </>}
    </div>
  );
}

function KPI({ m }) {
  const rows = m.extras?.totals?.rows || [];
  return (
    <>
      {rows.length > 0 && <div className="cp-tiles">{rows.map((t) => {
        const up = (+t.change || 0) >= 0, isPct = String(t.metric).includes("%");
        return <div key={t.metric} className="cp-tile"><div className="k">{t.metric}</div>
          <div className="v">{isPct ? pct(t.this_week) : int(t.this_week)}</div>
          <div className={`d ${up ? "up" : "down"}`}>{up ? "▲" : "▼"} {isPct ? pct(Math.abs(t.change)) : int(Math.abs(t.change))}{t.change_pct != null && t.change_pct !== "" ? ` (${pct(Math.abs(t.change_pct))})` : ""} vs last week</div></div>;
      })}</div>}
      <Findings title={`Movers · ${m.rows.length}`} columns={m.columns} rows={m.rows} />
    </>
  );
}

function Pairs({ columns, rows }) {
  return (
    <div className="cp-pairs">
      {rows.map((r, i) => (
        <div key={i} className="cp-pair">
          <div className="cp-pair-q">{r.query}</div>
          <div className="cp-pair-body">
            <div className="cp-pair-side win"><span className="cp-pair-tag">Keep</span><span className="cp-path">{r.winner}</span><span className="faint small">{int(r.winner_clicks)} clicks · pos {pos(r.winner_pos)}</span></div>
            <div className="cp-pair-side lose"><span className="cp-pair-tag lose">Fix</span><span className="cp-path">{r.loser}</span><span className="faint small">{int(r.loser_impressions)} impressions · pos {pos(r.loser_pos)} · {pct(r.loser_share_pct)} of demand</span></div>
          </div>
          <div className={`cp-pill ${tone(r.diagnosis)}`}>{r.diagnosis}</div>
        </div>
      ))}
    </div>
  );
}
