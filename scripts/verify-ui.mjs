// Catch a blank screen before the user does: load every tab and fail on any
// console error or React error boundary.
import { chromium } from "playwright";
const PORT = process.argv[2] || "8788";
const b = await chromium.launch({ channel: "chrome" });
const p = await b.newPage({ viewport: { width: 1440, height: 940 } });
const errors = [];
p.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
p.on("pageerror", (e) => errors.push("PAGE: " + String(e.message).slice(0, 160)));
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle" });
for (const tab of ["Traffic Decay", "Keywords", "Freshness", "SEO Copilot", "Config", "Setup"]) {
  const b2 = p.getByRole("button", { name: new RegExp(`^${tab}$`) });
  if (await b2.count()) { await b2.first().click(); await p.waitForTimeout(900); }
  const boom = await p.locator("text=/Dashboard error/i").count();
  console.log(`  ${boom ? "✗" : "✓"} ${tab}${boom ? "  — ERROR BOUNDARY" : ""}`);
  if (boom) errors.push(`${tab}: error boundary rendered`);
}
await b.close();
const real = errors.filter((e) => !/favicon|404 \(Not Found\)/i.test(e));
if (real.length) { console.log("\nerrors:"); real.slice(0, 5).forEach((e) => console.log("  " + e)); process.exit(1); }
console.log("\n=== all tabs render clean ===");
