import { useEffect, useState } from "react";
import { api } from "./api";
import { CheckCircle, Circle, Copy, ArrowSquareOut, Warning, CaretDown, Plug, UploadSimple } from "@phosphor-icons/react";

const copy = (t) => navigator.clipboard?.writeText(t);

/* Each Google Cloud step names the exact screen and the exact thing to click, so a
   user can match what they see rather than interpret prose. */
const GOOGLE_STEPS = [
  { n: 1, title: "Create a Google Cloud project",
    body: "Any name works — it is only a container. If you already have one, skip to step 2.",
    link: "https://console.cloud.google.com/projectcreate", cta: "Open project creation" },
  { n: 2, title: "Enable the Search Console API",
    body: "Pick the project you just made, then press Enable. Without this the connection fails with “API not enabled”.",
    link: "https://console.cloud.google.com/apis/library/searchconsole.googleapis.com", cta: "Open the API page" },
  { n: 3, title: "Configure the consent screen",
    body: "Choose External, fill in an app name and your email, then Save. On the Test users step, add your own Google address — the one that owns the Search Console property. Skipping this causes “access blocked”.",
    link: "https://console.cloud.google.com/apis/credentials/consent", cta: "Open the consent screen" },
  { n: 4, title: "Create an OAuth client",
    body: "Create credentials → OAuth client ID → application type Desktop app. Desktop matters: a Web application client will reject the redirect below.",
    link: "https://console.cloud.google.com/apis/credentials", cta: "Open credentials" },
];

export default function SetupTab() {
  const [s, setS] = useState(null);
  const [cid, setCid] = useState("");
  const [csec, setCsec] = useState("");
  const [site, setSite] = useState("");
  const [gem, setGem] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [openTrouble, setOpenTrouble] = useState(false);
  const [crawl, setCrawl] = useState(null);
  const [upMsg, setUpMsg] = useState("");
  useEffect(() => { api("/api/crawl").then(setCrawl).catch(() => {}); }, []);

  // A crawl CSV is read in the browser and posted as text — no upload service,
  // no file ever leaving this machine.
  async function uploadCrawl(file) {
    if (!file) return;
    setUpMsg("Reading…"); setBusy(true);
    try {
      const text = await file.text();
      const r = await fetch("/api/crawl", { method: "POST", headers: { "content-type": "text/csv" }, body: text });
      const d = await r.json();
      setUpMsg(d.ok ? `Imported ${d.pages.toLocaleString()} pages from ${d.columns_found} columns.` : d.error);
      if (d.ok) api("/api/crawl").then(setCrawl).catch(() => {});
    } catch (e) { setUpMsg(String(e.message).slice(0, 200)); }
    setBusy(false);
  }

  const load = () => api("/api/setup").then((d) => { setS(d); setSite(d.steps.site.value || ""); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  async function saveCfg(updates) {
    setBusy(true); setErr("");
    try { await api("/api/config", { method: "POST", body: JSON.stringify({ updates }) }); await load(); }
    catch (e) { setErr(String(e.message).slice(0, 300)); }
    setBusy(false);
  }

  async function connect() {
    setBusy(true); setErr("");
    try {
      const d = await api("/api/setup/google", { method: "POST", body: JSON.stringify({ client_id: cid.trim(), client_secret: csec.trim() }) });
      if (d.auth_url) window.open(d.auth_url, "_blank", "noopener");
      setTimeout(load, 3000);
    } catch (e) { setErr(String(e.message).slice(0, 300)); }
    setBusy(false);
  }

  if (err && !s) return <div className="su"><div className="su-err"><Warning size={15} /> {err}</div></div>;
  if (!s) return <div className="su"><div className="faint">Loading setup…</div></div>;

  const Step = ({ done, n, title, children }) => (
    <section className={`su-step ${done ? "done" : ""}`}>
      <div className="su-mark">{done ? <CheckCircle size={19} weight="fill" /> : <Circle size={19} />}</div>
      <div className="su-body">
        <h3>{n}. {title}</h3>
        {children}
      </div>
    </section>
  );

  return (
    <div className="su">
      <header className="su-head">
        <h2>Set up your copilot</h2>
        <p>Everything runs on this machine and connects to your own accounts. Your data never leaves it.</p>
      </header>

      {s.degraded && (
        <div className="su-note">
          <b>Running without a model key.</b> Agents still run and show their evidence tables.
          The written headline, the recommended action and free-text questions need a Gemini key — step 4.
        </div>
      )}

      <Step done={s.steps.site.done} n="1" title="Name the site you want to analyse">
        <p>Type it exactly as it appears in Search Console, including https and any www.</p>
        <div className="su-row">
          <input value={site} onChange={(e) => setSite(e.target.value)} placeholder="https://www.example.com" spellCheck={false} />
          <button className="su-btn" disabled={busy || !site.trim()} onClick={() => saveCfg({ "site.url": site.trim() })}>Save</button>
        </div>
      </Step>

      <Step done={s.steps.google_client.done} n="2" title="Create your Google credentials">
        <p>
          You create your own Google credentials so this tool talks to Search Console as you.
          Nobody else can see your data, and there is no app-verification warning. Four steps, about ten minutes.
        </p>
        <ol className="su-gsteps">
          {GOOGLE_STEPS.map((g) => (
            <li key={g.n}>
              <b>{g.title}</b>
              <div>{g.body}</div>
              <a href={g.link} target="_blank" rel="noreferrer">{g.cta} <ArrowSquareOut size={12} weight="bold" /></a>
            </li>
          ))}
        </ol>
        <div className="su-redirect">
          If Google asks for an authorised redirect URI, use this:
          <code>{s.redirect_uri}</code>
          <button className="su-copy" onClick={() => copy(s.redirect_uri)}><Copy size={13} /> Copy</button>
        </div>
      </Step>

      <Step done={s.steps.google_connected.done} n="3" title="Connect Search Console">
        <p>Paste the client ID and secret from step 2, then approve in the browser tab that opens.</p>
        <div className="su-row">
          <input value={cid} onChange={(e) => setCid(e.target.value)} placeholder="…apps.googleusercontent.com" spellCheck={false} />
        </div>
        <div className="su-row">
          <input value={csec} onChange={(e) => setCsec(e.target.value)} type="password" placeholder="Client secret" spellCheck={false} />
          <button className="su-btn primary" disabled={busy || !cid.trim() || !csec.trim()} onClick={connect}>
            <Plug size={14} weight="bold" /> Connect
          </button>
        </div>
        {s.steps.google_connected.done && (
          <div className="su-props">
            <b>Connected.</b> This account can read {s.steps.google_connected.properties.length} propert
            {s.steps.google_connected.properties.length === 1 ? "y" : "ies"}:
            <ul>{s.steps.google_connected.properties.slice(0, 8).map((p) => (
              <li key={p.url}><code>{p.url}</code> <span className="faint">{p.permission}</span></li>))}</ul>
          </div>
        )}
        <button className="su-trouble" onClick={() => setOpenTrouble((o) => !o)}>
          Something went wrong? <CaretDown size={12} weight="bold" style={{ transform: openTrouble ? "rotate(180deg)" : "none" }} />
        </button>
        {openTrouble && (
          <dl className="su-faq">
            <dt>“Google hasn’t verified this app”</dt>
            <dd>Expected — it is your own app, used only by you. Click Advanced, then “Go to … (unsafe)”.</dd>
            <dt>“Access blocked: app has not completed verification”</dt>
            <dd>You are not on the test-user list. Go back to the consent screen, add your own Google address under Test users, then try again.</dd>
            <dt>“redirect_uri_mismatch”</dt>
            <dd>The client was created as a Web application. Delete it and make a new one of type Desktop app.</dd>
            <dt>Connected, but my site is not listed</dt>
            <dd>You approved a different Google account from the one that owns the property. Revoke the app at myaccount.google.com/permissions and connect again with the right account.</dd>
            <dt>“API not enabled”</dt>
            <dd>Step 2 was skipped, or it was enabled on a different project from the one the client belongs to.</dd>
          </dl>
        )}
      </Step>

      <Step done={s.steps.gemini.done} n="4" title="Add a Gemini key">
        <p>
          Free from Google AI Studio and takes about a minute. It writes the one-line headline
          and the recommended action on each answer, and powers free-text questions.
        </p>
        <div className="su-row">
          <input value={gem} onChange={(e) => setGem(e.target.value)} type="password"
            placeholder={s.steps.gemini.done ? "Saved — paste a new key to replace it" : "AIza…"} spellCheck={false} />
          <button className="su-btn" disabled={busy || !gem.trim()} onClick={() => { saveCfg({ "keys.gemini": gem.trim() }); setGem(""); }}>Save</button>
        </div>
        <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">Get a free key <ArrowSquareOut size={12} weight="bold" /></a>
      </Step>

      <Step done={Object.values(s.optional).some(Boolean)} n="5" title="Optional integrations">
        <p>Each one unlocks its own agents. Without a key those agents are hidden rather than broken.</p>
        <ul className="su-opt">
          <li><b>Ahrefs</b> <span className={s.optional.ahrefs ? "on" : ""}>{s.optional.ahrefs ? "added" : "not added"}</span> — backlink gap, lost links, anchor text, toxic links, keyword gap</li>
          <li><b>SerpAPI</b> <span className={s.optional.serpapi ? "on" : ""}>{s.optional.serpapi ? "added" : "not added"}</span> — live search-result checks</li>
          <li><b>Firecrawl</b> <span className={s.optional.firecrawl ? "on" : ""}>{s.optional.firecrawl ? "added" : "not added"}</span> — reads your pages for schema and content checks</li>
        </ul>
        <p className="faint">Add these in the Config tab.</p>
      </Step>

      <Step done={!!crawl?.pages} n="6" title="Crawl data (optional)">
        <p>
          Eight agents read a site crawl: crawl errors, indexability, orphan pages, thin and
          duplicate content, headings, page speed and internal linking. Without one they are
          hidden. Two ways to provide it.
        </p>
        <div className="su-crawl">
          <div>
            <b>Screaming Frog on this Mac</b>
            <div>If you have a licensed copy installed, the nightly job crawls your site and
            imports it automatically. Licence required: the free edition caps at 500 URLs and
            cannot export from the command line.</div>
          </div>
          <div>
            <b>Or upload an export</b>
            <div>Crawl your site in any tool, export the <i>Internal → All</i> tab as CSV, and
            drop it here. It is parsed in your browser and stored locally.</div>
            <label className="su-btn" style={{ marginTop: 8, display: "inline-flex" }}>
              <UploadSimple size={14} weight="bold" /> Choose CSV
              <input type="file" accept=".csv,text/csv" style={{ display: "none" }}
                onChange={(e) => uploadCrawl(e.target.files?.[0])} />
            </label>
            {upMsg && <div className="su-upmsg">{upMsg}</div>}
          </div>
        </div>
        {crawl?.pages > 0 && (
          <div className="su-props">
            <b>{crawl.pages.toLocaleString()} pages</b> from the crawl on {crawl.crawled_at}.
          </div>
        )}
      </Step>

      {err && <div className="su-err"><Warning size={15} /> {err}</div>}
    </div>
  );
}
