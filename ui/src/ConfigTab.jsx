import { useEffect, useState } from "react";
import { api } from "./api";
import { FloppyDisk, CheckCircle, Warning } from "@phosphor-icons/react";

export default function ConfigTab() {
  const [fields, setFields] = useState(null);
  const [ctx, setCtx] = useState(null);
  const [draft, setDraft] = useState({});
  const [errs, setErrs] = useState({});
  const [saved, setSaved] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loadErr, setLoadErr] = useState(null);

  useEffect(() => {
    api("/api/config").then((d) => { setFields(d.fields); setCtx(d.context);
      setDraft(Object.fromEntries(d.fields.map((f) => [f.key, f.value]))); })
      .catch((e) => setLoadErr(e.message));
  }, []);

  const set = (k, v) => { setDraft((d) => ({ ...d, [k]: v })); setSaved(null); setErrs((e) => ({ ...e, [k]: null })); };
  const dirty = fields?.some((f) => String(draft[f.key] ?? "") !== String(f.value ?? ""));

  async function save() {
    if (busy) return;
    setBusy(true); setErrs({});
    const updates = Object.fromEntries(fields
      .filter((f) => String(draft[f.key] ?? "") !== String(f.value ?? ""))
      .map((f) => [f.key, draft[f.key]]));
    try {
      await api("/api/config", { method: "POST", body: JSON.stringify({ updates }) });
      const d = await api("/api/config");
      setFields(d.fields); setDraft(Object.fromEntries(d.fields.map((f) => [f.key, f.value])));
      setSaved(new Date().toLocaleTimeString());
    } catch (e) {
      let parsed = null;
      try { parsed = JSON.parse(String(e.message).slice(String(e.message).indexOf("{"))); } catch {}
      if (parsed?.errors) setErrs(parsed.errors); else setErrs({ _: e.message });
    }
    setBusy(false);
  }

  if (loadErr) return <div className="cfg-wrap"><div className="cfg-err"><Warning size={15} /> Could not load settings: {loadErr}</div></div>;
  if (!fields) return <div className="cfg-wrap"><div className="faint">Loading settings…</div></div>;

  const Field = ({ f }) => {
    const v = draft[f.key] ?? "";
    const err = errs[f.key];
    return (
      <div className={`cfg-row ${err ? "bad" : ""}`}>
        <div className="cfg-label">
          <div className="cfg-name">{f.label}</div>
          {f.hint && <div className="cfg-hint">{f.hint}</div>}
          {err && <div className="cfg-fielderr"><Warning size={12} weight="bold" /> {err}</div>}
        </div>
        <div className="cfg-input">
          {f.type === "bool" && (
            <label className="cfg-toggle">
              <input type="checkbox" checked={v === "true"} onChange={(e) => set(f.key, e.target.checked ? "true" : "false")} />
              <span>{v === "true" ? "On" : "Off"}</span>
            </label>)}
          {f.type === "choice" && (
            <select value={v} onChange={(e) => set(f.key, e.target.value)}>
              {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>)}
          {f.type === "multi" && (
            <div className="cfg-checks">
              {f.options.map((o) => {
                const on = String(v).split(",").map((x) => x.trim()).includes(o);
                return (
                  <label key={o} className={on ? "on" : ""}>
                    <input type="checkbox" checked={on} onChange={() => {
                      const cur = String(v).split(",").map((x) => x.trim()).filter(Boolean);
                      set(f.key, (on ? cur.filter((x) => x !== o) : [...cur, o]).join(","));
                    }} />
                    {o.replace("_", " ")}
                  </label>);
              })}
            </div>)}
          {(f.type === "text" || f.type === "emails" || f.type === "int") && (
            <input type={f.type === "int" ? "number" : "text"} value={v}
              min={f.min} max={f.max}
              onChange={(e) => set(f.key, e.target.value)} />)}
        </div>
      </div>);
  };

  return (
    <div className="cfg-wrap">
      <div className="cfg-head">
        <div>
          <h2>Weekly brief</h2>
          <p className="faint">
            Sent from this Mac. Every figure is computed from Search Console and the CMS —
            nothing here is written by a model.
          </p>
        </div>
        <button className="cfg-save" disabled={!dirty || busy} onClick={save}>
          <FloppyDisk size={14} weight="bold" /> {busy ? "Saving…" : dirty ? "Save changes" : "Saved"}
        </button>
      </div>

      {saved && <div className="cfg-ok"><CheckCircle size={15} weight="fill" /> Saved at {saved}. The next run picks this up.</div>}
      {errs._ && <div className="cfg-err"><Warning size={15} /> {errs._}</div>}

      <div className="cfg-card">{fields
        .filter((f) => {
          // a field that does nothing under the chosen transport is hidden, not shown dead
          if (!f.onlyWhen) return true;
          const [k, v] = f.onlyWhen.split("=");
          return String(draft[k] ?? "") === v;
        })
        .map((f) => <Field key={f.key} f={f} />)}</div>

      <div className="cfg-notes">
        <div><b>Schedule.</b> Changing the day or hour rewrites this Mac's timer the next time the brief runs.</div>
        <div><b>CMS last read.</b> {ctx?.cms_last_checked
          ? new Date(ctx.cms_last_checked).toLocaleString()
          : "never — the new-pages section will say so rather than report zero"}</div>
        <div><b>Sending limits.</b> Until a domain is verified in Resend, the brief can only
          reach the account owner's own address. Other recipients will be rejected.</div>
      </div>
    </div>);
}
