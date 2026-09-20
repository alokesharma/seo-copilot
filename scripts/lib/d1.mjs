// Talk to the SAME local D1 that `wrangler pages dev` uses, so the UI and
// these loaders share one database.
//
// HARDENED (2026-07-25): never shell out to `npx` — launchd/cron environments
// have a minimal PATH where npx doesn't exist (this exact ENOENT silently
// broke the automated freshness recompute). We invoke wrangler's JS entry with
// THIS node binary (process.execPath) — both are absolute paths, environment-proof.
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";

const DB = "seo-copilot";
const ROOT = new URL("../../", import.meta.url).pathname;
const TMP = ROOT + "tmp-sql/";
const WRANGLER = ROOT + "node_modules/wrangler/bin/wrangler.js";
if (!existsSync(WRANGLER)) throw new Error("wrangler not found at " + WRANGLER + " — run npm install");

function wrangler(args, opts = {}) {
  return execFileSync(process.execPath, [WRANGLER, ...args], {
    cwd: ROOT, // wrangler must resolve wrangler.toml + .wrangler state from the project root
    ...opts,
  });
}

export function runFile(sql) {
  mkdirSync(TMP, { recursive: true });
  const path = TMP + "batch.sql";
  writeFileSync(path, sql);
  // Retry on transient SQLite lock (e.g. dev server touching the same local D1).
  for (let i = 0; ; i++) {
    try {
      wrangler(["d1", "execute", DB, "--local", `--file=${path}`],
        { stdio: ["ignore", "ignore", i < 5 ? "ignore" : "inherit"] });
      return;
    } catch (e) {
      if (i >= 6) throw e;
      const t = Date.now(); while (Date.now() - t < 2000) { /* sync wait, no PATH deps */ }
    }
  }
}

export function query(sql) {
  const out = wrangler(["d1", "execute", DB, "--local", "--json", "--command", sql],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const parsed = JSON.parse(out);
  return parsed?.[0]?.results ?? parsed?.results ?? [];
}

export const esc = (s) => String(s).replace(/'/g, "''");

export function setMeta(key, value) {
  runFile(`INSERT OR REPLACE INTO meta(key,value) VALUES('${esc(key)}','${esc(value)}');`);
}
export function getMeta(key) {
  const r = query(`SELECT value FROM meta WHERE key='${esc(key)}'`);
  return r[0]?.value ?? null;
}
