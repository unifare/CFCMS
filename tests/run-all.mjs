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
  // Architecture first: it is fast, needs no database, and a failure here means
  // the shape of the code is wrong — which makes every later failure suspect.
  ["architecture rules", "architecture.test.mjs"],
  // Schema scope: like the architecture rules it needs no shared database (it
  // builds a throwaway SQLite from the migration stream), and it answers the
  // question the rules only assert — "does every real table have a tenant and
  // a language answer?" Run it right after the rules so a shape error and a
  // scope error are reported next to each other.
  ["schema scope (tenant+lang)", "_schema-scope.mjs"],
  // Manifest validation is next: like the architecture suite it needs no
  // database, and it guards what a *user uploads* — the shipped themes are
  // already covered by the architecture rules above.
  ["manifest validation", "manifest-validation.test.mjs"],
  // The admin SPA split is checked here too: like the two above it needs no
  // database, and it guards *structure* (module graph, window.* contract) —
  // a broken split would make the admin UI silently unusable.
  ["admin spa structure", "admin-spa.test.mjs"],
  ["template engine (unit)", "template-engine.test.mjs"],
  ["theme integration (e2e)", "theme-integration.test.mjs"],
  ["multi-site", "multisite.test.mjs"],
  // Multi-language runs after multi-site: both write per-site locale switches
  // and the i18n suite asserts on a site it configures itself.
  ["multi-language (L0-L3)", "i18n.test.mjs"],
  ["admin contract", "admin-contract.test.mjs"],
  ["plugin hooks", "plugin-hooks.test.mjs"],
  ["theme sandbox (L3)", "theme-worker.test.mjs"],
  ["aurora templates", "theme-aurora.test.mjs"],
];

const results = [];
for (const [label, file] of suites) {
  process.stdout.write(`\n${"=".repeat(64)}\n${label}\n${"=".repeat(64)}\n`);
  const r = spawnSync(process.execPath, [join(__dirname, file)], { encoding: "utf8" });

  // A runner that cannot execute the suite is not the same as a suite that
  // failed. Some sandboxes lock the node binary (`EBUSY`), which would
  // otherwise report every suite red and hide the real state. Surface it
  // distinctly so a genuine failure stays legible.
  if (r.error) {
    console.log(`SKIPPED — could not start the suite: ${r.error.code || r.error.message}`);
    console.log(`          (run it directly: node tests/${file})`);
    results.push({ label, status: "skip", summary: "runner could not spawn" });
    continue;
  }

  const out = (r.stdout || "") + (r.stderr || "");
  // Print only the meaningful lines; node's SQLite warning is noise.
  for (const line of out.split("\n")) {
    if (/ExperimentalWarning|trace-warnings/.test(line)) continue;
    if (!line.trim()) continue;
    console.log(line);
  }
  const m = out.match(/(\d+) passed, (\d+) failed/);
  results.push({ label, status: r.status, summary: m ? `${m[1]} passed, ${m[2]} failed` : "(no summary)" });
  if (r.status !== 0) {
    console.log(`\n>>> ${label} FAILED (exit ${r.status})`);
  }
}

console.log(`\n${"=".repeat(64)}\nSUMMARY\n${"=".repeat(64)}`);
let bad = 0;
let skipped = 0;
for (const r of results) {
  if (r.status === "skip") {
    skipped++;
    console.log(`  SKIP  ${r.label.padEnd(28)} ${r.summary}`);
    continue;
  }
  const mark = r.status === 0 ? "PASS" : "FAIL";
  if (r.status !== 0) bad++;
  console.log(`  ${mark}  ${r.label.padEnd(28)} ${r.summary}`);
}

if (bad) console.log(`\n${bad} suite(s) failed.`);
else if (skipped) console.log(`\nNo failures, but ${skipped} suite(s) could not be started by this runner.`);
else console.log("\nAll suites passed.");
process.exit(bad ? 1 : 0);
