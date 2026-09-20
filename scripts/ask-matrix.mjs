// Question × history matrix. Every combination a real user can create, not the one
// shape that happened to work. A question is a PASS only if it returns rows or
// declines for a reason the data genuinely justifies.
const API = "http://127.0.0.1:8788/api/copilot";
const RANGE = { from: "2026-06-22", to: "2026-09-17" };
const post = (b) => fetch(API, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ ...RANGE, ...b }) }).then((r) => r.json());
const hist = (j, q) => ({ question: q,
  answer: [j.headline, j.rows?.length ? `${j.rows.length} rows: ${(j.columns || []).map((c) => c.label).join(", ")}` : ""].filter(Boolean).join(" · ").slice(0, 300),
  sql: j.generated_sql });

// Histories a user can actually be in when they type a follow-up
const CONTEXTS = {
  "no history":        async () => [],
  "after an agent":    async () => { const j = await post({ agent: "lost_link_monitor" }); return [hist(j, "Lost links")]; },
  "after a question":  async () => { const q = "how many queries got more than 100 clicks last month?";
                                     const j = await post({ question: q }); return [hist(j, q)]; },
};

// Questions a user can actually ask. `expect`: rows = must return data.
const QUESTIONS = [
  { q: "what is the homepage traffic year over year?", expect: "rows" },
  { q: "which pages lost the most clicks in the last 28 days?", expect: "rows" },
  { q: "top 10 queries by impressions", expect: "rows" },
  { q: "which pages get impressions but under 1% CTR?", expect: "rows" },
  { q: "how many pages got zero clicks last month?", expect: "rows" },
  { q: "compare this month against the same month last year", expect: "rows" },
  { q: "which queries improved position by 2 or more this month?", expect: "rows" },
  { q: "show me the worst performing blog pages", expect: "rows" },
  { q: "what is the search volume for car insurance?", expect: "decline" },
  { q: "how many backlinks did we gain?", expect: "decline" },
];
// Follow-ups only make sense with history
const FOLLOWUPS = [
  { q: "show me the top 5 of those", expect: "rows" },
  // after a Search Console answer this switches dimension; after a backlinks agent
  // it asks for backlinks per page, which these tables do not hold
  { q: "now the same for pages instead", expect: "either" },
  // after a Search Console answer this refines it; after a backlinks agent the
  // data genuinely is not here, so either answering or declining is correct
  { q: "only the ones with more than 500 impressions", expect: "either" },
];

const run = async (question, history) => {
  const j = await post({ question, history });
  const rows = j.rows?.length ?? 0;
  const declined = !!(j.no_match || j.no_key);
  const sqlFail = (j.steps || []).find((s) => s.tool === "sql" && !s.ok);
  return { rows, declined, sqlFail: sqlFail ? String(sqlFail.detail).slice(0, 70) : null,
    why: j.error ? String(j.error).slice(0, 90) : "", agent: j.agent };
};

let pass = 0, fail = 0; const failures = [];
for (const [ctxName, mk] of Object.entries(CONTEXTS)) {
  const history = await mk();
  console.log(`\n── ${ctxName} ──`);
  const set = ctxName === "no history" ? QUESTIONS : [...QUESTIONS, ...FOLLOWUPS];
  for (const { q, expect } of set) {
    const r = await run(q, history);
    const ok = expect === "either" ? (r.rows > 0 || r.declined) : expect === "rows" ? r.rows > 0 : r.declined;
    if (ok) pass++; else { fail++; failures.push({ ctx: ctxName, q, expect, ...r }); }
    console.log(`  ${ok ? "✓" : "✗"} ${q.slice(0, 54).padEnd(56)} ${r.declined ? "declined" : r.rows + " rows"}${r.sqlFail ? " SQLFAIL" : ""}`);
  }
}
console.log(`\n=== ask matrix: ${pass}/${pass + fail} ===`);
if (failures.length) {
  console.log("\nfailures:");
  for (const f of failures) console.log(`  [${f.ctx}] ${f.q}\n     expected ${f.expect}, got ${f.declined ? "decline" : f.rows + " rows"}${f.sqlFail ? `\n     SQL: ${f.sqlFail}` : ""}${f.why ? `\n     ${f.why}` : ""}`);
}
process.exit(fail ? 1 : 0);
