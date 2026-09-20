// THE JUDGE — grades every agent's real output against what it promises.
//
// The sweep proves nothing is FALSE. The judge asks the harder question a person
// asks: does this actually answer its own question, and would an SEO lead act on
// it? Run it after any agent change; fix everything it flags before a human looks.
import { readFileSync } from "node:fs";
const vars = Object.fromEntries(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
  .split("\n").filter((l) => l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const KEY = vars.GEMINI_API_KEY, MODEL = vars.GEMINI_MODEL || "gemini-3.7-flash";
const API = "http://127.0.0.1:8788/api/copilot";
const RANGE = { from: "2026-06-18", to: "2026-09-16", segment: "ALL" };

const RUBRIC = `You are auditing one agent of an SEO tool used by the site, an Indian insurance company.
You are given what the agent PROMISES and what it actually RETURNED.

Judge it as a demanding Head of SEO would. Fail it for any of these:
- USELESS COLUMN: a column that restates another column, or whose every value is identical, or that a reader cannot act on.
- NOT THE PROMISED ANSWER: the name promises a decision or a list of X, but the output is something else.
- UNPROVABLE CLAIM: any statement of absence, cause, or opportunity that the returned columns do not demonstrate.
- BAD ADVICE FOR THIS BUSINESS: recommending a topic the site does not sell, or a competitor's branded query, or deleting something valuable.
- MISSING DATA SHOWN AS A NUMBER: a 0 or "no" that actually means "we did not measure it".
- EMPTY WITHOUT EXPLANATION: zero rows and no specific reason why.

Reply ONLY with JSON:
{"verdict":"good"|"weak"|"broken","issues":["short, specific, one per problem"],"worst_row":"quote the single worst row or line, or empty string"}
"good" = an SEO lead would act on this as-is. "weak" = correct but low value. "broken" = wrong, misleading, or not what it promises.`;

async function judge(agent, payload) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ system_instruction: { parts: [{ text: RUBRIC }] },
      contents: [{ role: "user", parts: [{ text: JSON.stringify(payload).slice(0, 14000) }] }],
      generationConfig: { temperature: 0, responseMimeType: "application/json" } }) });
  const d = await r.json();
  if (d.error) return { verdict: "judge-error", issues: [d.error.message], worst_row: "" };
  try { return JSON.parse(d?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "{}"); }
  catch { return { verdict: "judge-error", issues: ["unparseable judge reply"], worst_row: "" }; }
}

const reg = await (await fetch(API)).json();
const agents = reg.agents;
const out = [];
for (const a of agents) {
  let j;
  try {
    const r = await fetch(API, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: a.key, ...RANGE }) });
    j = await r.json();
  } catch (e) { out.push({ key: a.key, name: a.name, verdict: "run-error", issues: [e.message] }); continue; }
  if (j.error) { out.push({ key: a.key, name: a.name, verdict: "run-error", issues: [j.error] }); continue; }
  const payload = {
    promises: { name: a.name, purpose: a.purpose, scope: a.scope },
    returned: { rows_returned: j.rows?.length ?? 0, columns: (j.columns || []).map((c) => c.label),
      headline: j.headline, action: j.action, rows: (j.rows || []).slice(0, 8),
      caption_true_of_every_row: j.all_rows,
      empty_reason: j.empty?.reason, meta: j.meta,
      deliverable: j.deliverable ? { title: j.deliverable.title,
        content: j.deliverable.content?.slice(0, 900),
        items: (j.deliverable.items || []).slice(0, 6) } : null,
      supporting_tables: Object.fromEntries(Object.entries(j.extras || {})
        .map(([k, v]) => [k, (v.rows || []).slice(0, 4)])) },
  };
  const v = await judge(a.key, payload);
  out.push({ key: a.key, name: a.name, rows: j.rows?.length ?? 0, ...v });
  const mark = v.verdict === "good" ? "✓" : v.verdict === "weak" ? "~" : "✗";
  console.log(`${mark} ${a.key.padEnd(22)} ${String(v.verdict).padEnd(12)} ${(v.issues || []).join(" | ").slice(0, 110)}`);
}
const n = (v) => out.filter((o) => o.verdict === v).length;
console.log(`\n=== good ${n("good")} · weak ${n("weak")} · broken ${n("broken")} · errors ${n("run-error") + n("judge-error")} of ${out.length} ===`);
import { writeFileSync } from "node:fs";
writeFileSync("/tmp/judge-report.json", JSON.stringify(out, null, 2));
console.log("full report: /tmp/judge-report.json");
