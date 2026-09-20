// KNOWN-ANSWER GATE — the test the old sweep could not be.
//
// The sweep proves an agent says nothing FALSE. That is not enough: "clicks down"
// in a column labelled Verdict is perfectly true and perfectly useless, and it
// passed 39/39. This file asserts, per agent, that the answer is USEFUL and that
// facts Aloke can verify by eye come out right.
//
// Rule: an agent does not ship until its checks here pass. Add checks BEFORE
// rebuilding an agent, never after.
const API = "http://127.0.0.1:8788/api/copilot";
const RANGE = { from: "2026-06-18", to: "2026-09-16", segment: "ALL" };

const run = async (agent) => {
  const r = await fetch(API, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent, ...RANGE }) });
  return r.json();
};

const CHECKS = {
  // ── 16. Keep / update / merge / kill ──────────────────────────────────────
  content_audit: [
    ["every row ends in a real verdict", (j) =>
      j.rows.every((r) => /^(keep|update|kill|merge into \/)/.test(r.verdict || ""))
        || `found: ${[...new Set(j.rows.map((r) => r.verdict))].slice(0, 3).join(" | ")}`],
    ["no measurement masquerading as a verdict", (j) =>
      !j.rows.some((r) => /clicks (down|fell|flat)|impressions|position/i.test(r.verdict || ""))],
    ["a page with referring domains is never killed", (j) =>
      !j.rows.some((r) => r.verdict === "kill" && +r.referring_domains > 0)],
    ["kill is never based on an uncrawled page", (j) =>
      !j.rows.some((r) => r.verdict === "kill" && !(r.words > 0))],
    ["Delhi e-challan collapsed 27,701 -> 1,499, so it must say update", (j) => {
      const d = j.rows.find((r) => /e-challan-delhi/.test(r.page));
      return !d ? "row missing from the table" : d.verdict === "update" || `said "${d.verdict}"`; }],
    ["verdicts that no page qualified for are declared, not hidden", (j) => {
      const used = new Set(j.rows.map((r) => String(r.verdict).split(" ")[0]));
      const missing = ["keep", "update", "merge", "kill"].filter((v) => !used.has(v));
      return !missing.length || !!j.meta?.no_page_qualified_for || `silently absent: ${missing.join(", ")}`; }],
  ],

  // ── 2. Queries one push from page 1 ───────────────────────────────────────
  striking_distance: [
    ["every query is on page 2, not already on page 1", (j) =>
      j.rows.every((r) => +r.pos > 10) || `found position ${Math.min(...j.rows.map((r) => +r.pos))}`],
  ],
  // ── 3. Internal links ─────────────────────────────────────────────────────
  internal_linking: [
    ["only genuinely under-linked pages", (j) =>
      j.rows.every((r) => +r.current_inlinks < 20) || `found ${Math.max(...j.rows.map((r) => +r.current_inlinks))} inlinks`],
    ["the source page to link FROM is in the table", (j) =>
      j.rows.some((r) => r.link_from) || "no link_from on any row"],
  ],
  // ── 4. Spammy backlinks ───────────────────────────────────────────────────
  toxic_link_detector: [
    ["a high-authority host is never called spam to disavow", (j) =>
      !j.rows.some((r) => +r.domain_rating >= 30 && /worth disavowing/.test(r.diagnosis || ""))],
  ],
  // ── 5. Geography ──────────────────────────────────────────────────────────
  intent_mismatch: [
    ["'ts challan' on the Telangana page is a MATCH, never a mismatch", (j) =>
      !j.rows.some((r) => /^ts /.test(r.query || "") && /telangana/.test(r.page || ""))],
    ["every row is an actual mismatch", (j) =>
      j.rows.every((r) => !/same place|both non-geographic/.test(r.diagnosis || ""))],
  ],
  // ── 6. Orphans ────────────────────────────────────────────────────────────
  orphan_page: [
    ["never claims an orphan from a page the crawler only seeded", (j) =>
      j.rows.every((r) => +r.depth > 0) || "a row has crawl depth 0, where inlinks are never discovered"],
  ],
};

let pass = 0, fail = 0;
for (const [agent, checks] of Object.entries(CHECKS)) {
  const j = await run(agent);
  if (j.error) { console.log(`✗ ${agent}: ${j.error}`); fail += checks.length; continue; }
  console.log(`\n${agent} — ${j.rows?.length ?? 0} rows`);
  for (const [name, fn] of checks) {
    let out; try { out = fn(j); } catch (e) { out = "threw: " + e.message; }
    if (out === true) { console.log(`  ✓ ${name}`); pass++; }
    else { console.log(`  ✗ ${name}${typeof out === "string" ? ` — ${out}` : ""}`); fail++; }
  }
}
console.log(`\n=== known answers: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
