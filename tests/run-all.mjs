/**
 * Run every test suite in sequence and report a single verdict.
 *
 * The suites share one local D1 database and one in-memory R2 each, so running
 * them in order is itself a regression test for cross-suite state leakage.
 *
 * Usage: node tests/run-all.mjs
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const suites = [
  ["migrations", "_apply-migrations.mjs"],
  ["template engine (unit)", "template-engine.test.mjs"],
  ["theme integration (e2e)", "theme-integration.test.mjs"],
  ["multi-site", "multisite.test.mjs"],
  ["admin contract", "admin-contract.test.mjs"],
  ["plugin hooks", "plugin-hooks.test.mjs"],
  ["theme sandbox (L3)", "theme-worker.test.mjs"],
];

const results = [];
for (const [label, file] of suites) {
  process.stdout.write(`\n${"=".repeat(64)}\n${label}\n${"=".repeat(64)}\n`);
  const r = spawnSync(process.execPath, [join(__dirname, file)], { encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  // Print only the meaningful lines; node's SQLite warning is noise.
  for (const line of out.split("\n")) {
    if (/ExperimentalWarning|trace-warnings/.test(line)) continue;
    if (!line.trim()) continue;
    console.log(line);
  }
  const m = out.match(/(\d+) passed, (\d+) failed/);
  const failed = r.status !== 0;
  results.push({ label, status: r.status, summary: m ? `${m[1]} passed, ${m[2]} failed` : "(no summary)" });
  if (failed) {
    console.log(`\n>>> ${label} FAILED (exit ${r.status})`);
  }
}

console.log(`\n${"=".repeat(64)}\nSUMMARY\n${"=".repeat(64)}`);
let bad = 0;
for (const r of results) {
  const mark = r.status === 0 ? "PASS" : "FAIL";
  if (r.status !== 0) bad++;
  console.log(`  ${mark}  ${r.label.padEnd(28)} ${r.summary}`);
}
console.log(bad ? `\n${bad} suite(s) failed.` : "\nAll suites passed.");
process.exit(bad ? 1 : 0);
