/**
 * Reverse-validation for the system-skeleton guards (§10 rules 41–45).
 *
 * ## What this proves
 *
 * `architecture.test.mjs` and `_schema-scope.mjs` now assert the *shape* of the
 * system skeleton: the schema declaration, the language structure, the hook
 * contract, the domain event contract. A guard that has never been seen to fail
 * is indistinguishable from no guard at all — this repo has already shipped
 * seven false greens, and every one of them was a check whose red state nobody
 * had ever looked at.
 *
 * So this tool injects a specific, realistic defect for each guard, asserts the
 * **expected** assertion goes red, then restores and asserts the tree is
 * pristine again.
 *
 * ## The two traps this tool itself avoids (both were real bugs)
 *
 * 1. **Byte count cannot see an equal-length replacement.** `"site"` →
 *    `"sote"` is the same length, so a byte-count guard prints "nothing
 *    changed" while the injection *did* land — a false negative in the tool
 *    that exists to prevent false negatives. So the before/after comparison is
 *    a **content hash** (SHA-256).
 * 2. **A snapshot taken from a dirty tree restores a dirty tree.** If a
 *    previous run left an injected file behind, "restore" faithfully restores
 *    the corruption. So `assertPristine()` runs **before** the snapshot *and*
 *    **after** the restore.
 *
 * ## Why it is not in `npm test`
 *
 * It is a tool, not a suite: it mutates the working tree and shells out to the
 * suites. Same category as `_eshop-inject.mjs` and `_i18n-browser.cjs`.
 *
 * Usage: node tests/tools/_skeleton-inject.mjs
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(pathToFileURL(join(ROOT, "package.json")).href);
const rel = (f) => relative(ROOT, f).split(sep).join("/");
const normalize = (s) => s.replace(/\r\n/g, "\n");
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 12);

const SCHEMA = join(ROOT, "src/extensions/contract/schema.ts");
const EVENTS = join(ROOT, "src/extensions/contract/events.ts");
const ARCH = join(ROOT, "tests/suites/architecture.test.mjs");
const SCOPE = join(ROOT, "tests/tools/_schema-scope.mjs");
const MANIFEST = join(ROOT, "src/extensions/contract/manifest.ts");
const VALIDATION = join(ROOT, "src/extensions/contract/validation.ts");

/**
 * The scenarios. Each names the suite to run and the assertion (a substring of
 * its `ok`/`FAIL` name) that must flip.
 *
 * `flip` is the *whole* point: without it the tool proves only "some test was
 * red", not "the guard for this defect was red". A guard that fails for an
 * unrelated reason is still broken.
 */
const SCENARIOS = [
  {
    label: "a table is removed from the schema declaration",
    file: SCHEMA,
    before: [
      '  { table: "rewrites", tenant: "site", locale: null, note: "rewrite rules are per site" },\n',
    ],
    after: [""],
    runs: [["tests/tools/_schema-scope.mjs", "no table is missing from the schema declaration"]],
  },
  {
    label: "a tenant-scoped table is misclassified as platform-global",
    file: SCHEMA,
    before: [
      '{ table: "settings", tenant: "site", locale: null, note: "site settings (UNIQUE(site_id,key))" }',
    ],
    after: [
      '{ table: "settings", tenant: "platform", locale: null, note: "site settings (UNIQUE(site_id,key))" }',
    ],
    runs: [["tests/tools/_schema-scope.mjs", "no platform-global table carries a site_id column"]],
  },
  {
    label: "a derived list is hand-written instead of derived",
    file: SCHEMA,
    before: [
      "export const TENANT_TABLES = PLATFORM_SCHEMA\n  .filter((t) => t.tenant === \"site\")\n  .map((t) => t.table);",
    ],
    after: [
      "export const TENANT_TABLES = [\n  \"settings\",\n].filter(Boolean);",
    ],
    runs: [["tests/suites/architecture.test.mjs", "TENANT_TABLES is derived from PLATFORM_SCHEMA, not hand-written"]],
  },
  {
    label: "the same table is declared twice",
    file: SCHEMA,
    before: [
      '  { table: "menus", tenant: "site", locale: null, note: "menu containers; items carry the locale" },\n',
    ],
    after: [
      '  { table: "menus", tenant: "site", locale: null, note: "menu containers; items carry the locale" },\n' +
        '  { table: "menus", tenant: "platform", locale: null, note: "a contradictory second answer" },\n',
    ],
    runs: [["tests/suites/architecture.test.mjs", "no table is declared twice"]],
  },
  {
    label: "a value is added to the locale-scoped event list",
    file: EVENTS,
    before: ['  "SiteDefaultLocaleChanged",\n] as const;'],
    after: ['  "SiteDefaultLocaleChanged",\n  "PostPublishd",\n] as const;'],
    runs: [["tests/suites/architecture.test.mjs", "every locale-scoped event is a declared domain event"]],
  },
  {
    label: "a domain event is duplicated",
    file: EVENTS,
    before: ['  // -- media ----------------------------------------------------------------\n  "MediaUploaded",'],
    after: ['  // -- media ----------------------------------------------------------------\n  "MediaUploaded",\n  "MediaUploaded",'],
    runs: [["tests/suites/architecture.test.mjs", "no domain event is declared twice"]],
  },
  {
    label: "a domain event is added to the hook list (contracts collapsed)",
    file: join(ROOT, "src/extensions/contract/hooks.ts"),
    before: ['export const DECLARABLE_HOOKS = ['], 
    after: ['export const DECLARABLE_HOOKS = [\n  "PostPublished",'],
    runs: [["tests/suites/architecture.test.mjs", "no domain event is smuggled into the hook list"]],
  },
  {
    label: "a site-level fact is marked as carrying a language",
    file: EVENTS,
    before: ['  "PostTranslationCreated",\n  "SiteDefaultLocaleChanged",'],
    after: ['  "PostTranslationCreated",\n  "SiteDefaultLocaleChanged",\n  "SiteCreated",'],
    runs: [["tests/suites/architecture.test.mjs", "site-level facts are not marked locale-scoped"]],
  },
  {
    label: "the payload version fallback is removed",
    file: EVENTS,
    before: ['  return EVENT_PAYLOAD_VERSIONS[event] ?? 1;'],
    after: ['  return EVENT_PAYLOAD_VERSIONS[event] as number;'],
    runs: [["tests/suites/architecture.test.mjs", "payloadVersionOf has a total fallback"]],
  },
  {
    label: "a runtime-owned table is also declared as a platform table",
    file: SCHEMA,
    before: ['export const RUNTIME_TABLES = ["\\u005fcf_METADATA", "d1_migrations"] as const;'],
    after: ['export const RUNTIME_TABLES = ["\\u005fcf_METADATA", "d1_migrations", "locales"] as const;'],
    // Adding "locales" to the runtime list mutates the array in place from the
    // derived-export guard's point of view too, so more than one assertion can
    // go red; the one that *must* is the runtime/platform overlap.
    runs: [["tests/suites/architecture.test.mjs", "no runtime-owned table is also a declared platform table"]],
    alsoAccept: ["TENANT_TABLES is derived from PLATFORM_SCHEMA, not hand-written"],
  },
  {
    label: "an unknown language strategy is admitted by the vocabulary",
    file: MANIFEST,
    before: ['export const TABLE_LANGUAGE_STRATEGIES = ["none", "sidecar", "versioned"] as const;'],
    after: ['export const TABLE_LANGUAGE_STRATEGIES = ["none", "sidecar", "versioned", "sideways"] as const;'],
    // The failure is proved by the validator suite's own pinned statement; it
    // has no per-assertion name here, so this scenario only requires red.
    runs: [["tests/suites/manifest-validation.test.mjs", null]],
  },
  {
    label: "a doc code block names a test suite that does not exist",
    file: join(ROOT, "docs/guides/THEME-DEV.md"),
    before: ["node tests/suites/theme-fixture.test.mjs # 真主题渲染快照"],
    after: ["node tests/theme-deleted-long-ago.test.mjs # 真主题渲染快照"],
    runs: [["tests/suites/architecture.test.mjs", "every test path named in a doc code block exists on disk"]],
  },
  {
    // The second half of the doc guard: a `node <path>` command written in
    // *prose* (not in a code block). Prose is exempt from the fenced-block rule
    // so the history section can quote retired names — but a copy-pasteable
    // command is not history. `tests/_eshop-inject.mjs` survived batch 10
    // precisely here: deleted from disk, still named in two prose lines.
    label: "a doc tells the reader to run a `node` command that no file backs",
    file: join(ROOT, "AGENTS.md"),
    before: ["node tests/suites/launcher-parity.test.mjs"],
    after: ["node tests/suites/launcher-parity-GONE.test.mjs"],
    runs: [["tests/suites/architecture.test.mjs", "every `node <path>` command written in a doc points at a file that exists"]],
  },
];

/** Every file any scenario may touch, hashed before and after. */
const WATCHED = [...new Set([SCHEMA, EVENTS, ARCH, SCOPE, MANIFEST, VALIDATION,
  join(ROOT, "src/extensions/contract/hooks.ts"),
  join(ROOT, "AGENTS.md"),
  join(ROOT, "docs/guides/THEME-DEV.md")])];

function hashAll() {
  const out = {};
  for (const f of WATCHED) out[rel(f)] = existsSync(f) ? sha(normalize(readFileSync(f, "utf8"))) : "<absent>";
  return out;
}

/**
 * Assert the working tree matches the pristine snapshot.
 *
 * Called **before** injecting (so a previous run's leftovers cannot be baked
 * into the snapshot) and **after** restoring (so a failed restore is not
 * mistaken for a clean tree).
 */
function assertPristine(pristine, when) {
  const now = hashAll();
  const diffs = Object.keys(now).filter((k) => now[k] !== pristine[k]);
  if (diffs.length) {
    console.error(`\n✗ TREE NOT PRISTINE (${when}):`);
    for (const d of diffs) console.error(`    ${d}: ${pristine[d]} -> ${now[d]}`);
    console.error("  Restore the tree and re-run before trusting any result below.");
    process.exit(1);
  }
}

/** Promise-based worker run; resolves with the suite's captured output + code. */
function runSuite(relPath) {
  return new Promise((resolve) => {
    // ⚠️ The worker is created with `eval:true` from an **ESM** parent, so its
    // scope is ESM: `require` is not defined there. `import()` is the loader
    // that works, and it is what the suites are written for (`"type":"module"`).
    // The first version used `require` and every load threw, which surfaced as
    // "no summary" — i.e. as a broken *runner*, not a broken *guard*.
    const entry = `
      let out = "";
      process.stdout.write = (c) => { out += c; };
      process.stderr.write = (c) => { out += c; };
      const done = (code) => { parentPort.postMessage({ out, code: code == null ? 0 : code }); };
      process.exit = done;
      import(${JSON.stringify(pathToFileURL(join(ROOT, relPath)).href)})
        .then(() => done(0))
        .catch((e) => done(1));
    `;
    let settled = false;
    const w = new Worker(`const { parentPort } = require("node:worker_threads");\n${entry}`, {
      eval: true,
    });
    const finish = (verdict) => {
      if (settled) return;
      settled = true;
      try { w.terminate(); } catch { /* already gone */ }
      resolve(verdict);
    };
    w.on("message", (m) => finish(parseVerdict(m.out, m.code)));
    w.on("error", (e) => finish({
      passed: null, failed: null, aborted: true, code: 1,
      text: `WORKER ERROR: ${(e && e.stack) || e}`, err: "worker error",
    }));
    w.on("exit", () => finish({
      passed: null, failed: null, aborted: true, code: 1,
      text: "", err: "worker exited without reporting",
    }));
    // Hard ceiling so a hung suite cannot wedge the tool.
    setTimeout(() => finish({
      passed: null, failed: null, aborted: true, code: 1,
      text: "", err: "worker timed out",
    }), 120_000).unref?.();
  });
}

/** Turn raw suite output into a verdict; a missing summary is never a pass. */
function parseVerdict(text, code) {
  const m = text.match(/(\d+) passed, (\d+) failed/);
  if (!m) return { passed: null, failed: null, aborted: true, text, code, err: "no summary" };
  return {
    passed: Number(m[1]),
    failed: Number(m[2]),
    aborted: /\(aborted\)/.test(text),
    text,
    code,
    err: null,
  };
}

const problems = [];
/**
 * Apply an injection, proving the anchor was present and unique.
 *
 * ⚠️ Anchors are written with `\n` and matched against text that has been
 * newline-normalised first (`normalize`, defined with the other helpers). The
 * first version matched the file as-read, and `schema.ts` happened to be CRLF
 * (written on Windows) while every other file was LF — so three scenarios
 * silently reported "anchor appears 0x" and were skipped. A scenario that never
 * ran is not a scenario that passed.
 */
const apply = (file, before, after) => {
  const src = normalize(readFileSync(file, "utf8"));
  const hits = src.split(before).length - 1;
  if (hits !== 1) {
    throw new Error(`injection anchor appears ${hits} time(s) in ${rel(file)} (need exactly 1): ${JSON.stringify(before.slice(0, 70))}`);
  }
  writeFileSync(file, src.replace(before, after));
};

// ---------------------------------------------------------------------------
async function main() {
console.log("Snapshotting the pristine tree...");
const pristine = hashAll();
assertPristine(pristine, "pre-flight");
console.log(`  ${WATCHED.length} watched files; baseline hashes:\n    ` +
  Object.entries(pristine).map(([k, v]) => `${k}=${v}`).join("\n    "));

let ran = 0;
for (const sc of SCENARIOS) {
  if (sc.skip) continue;
  console.log(`\n${"=".repeat(64)}\nScenario: ${sc.label}\n${"=".repeat(64)}`);

  // Pre-condition: the scenario's own anchor must be present and unique.
  const beforeSrc = normalize(readFileSync(sc.file, "utf8"));
  const anchorHits = beforeSrc.split(sc.before[0]).length - 1;
  if (anchorHits !== 1) {
    problems.push(`${sc.label}: anchor appears ${anchorHits}x (need 1)`);
    console.log(`  FAIL anchor not unique (${anchorHits}) — scenario not executed`);
    console.log(`       anchor: ${JSON.stringify(sc.before[0].slice(0, 90))}`);
    console.log(`       file:   ${rel(sc.file)} (${beforeSrc.length} chars)`);
    continue;
  }

  // Capture only the watched files the scenario touches, by hash.
  const preHashes = {};
  for (const f of [sc.file]) preHashes[rel(f)] = sha(normalize(readFileSync(f, "utf8")));

  try {
    apply(sc.file, sc.before[0], sc.after[0]);
  } catch (e) {
    problems.push(`${sc.label}: ${e.message}`);
    console.log(`  FAIL ${e.message}`);
    assertPristine(pristine, `after failed injection of "${sc.label}"`);
    continue;
  }

  // **The injection must be proven to have landed.** Hash, not byte count:
  // `"site"` -> `"sote"` is equal length and would fool a size check.
  const postHash = sha(normalize(readFileSync(sc.file, "utf8")));
  if (postHash === preHashes[rel(sc.file)]) {
    problems.push(`${sc.label}: injection produced no change in ${rel(sc.file)} (hash unchanged)`);
    console.log(`  FAIL injection did not land (${preHashes[rel(sc.file)]} == ${postHash}) — nothing was proved`);
    writeFileSync(sc.file, beforeSrc);
    assertPristine(pristine, `after no-op injection of "${sc.label}"`);
    continue;
  }
  console.log(`  injected ${rel(sc.file)}: ${preHashes[rel(sc.file)]} -> ${postHash}`);

  // Run the suites and check the *named* assertion flipped.
  let allFlipped = true;
  for (const [suite, expectRed] of sc.runs) {
    const res = await runSuite(suite);
    if (res.aborted) {
      problems.push(`${sc.label}: ${suite} produced no summary (aborted) while injected`);
      console.log(`  FAIL ${suite}: no summary while injected — cannot read the result (treated as failure)`);
      allFlipped = false;
      continue;
    }
    if (expectRed === null) {
      // No pinned assertion for this scenario; just require that it went red at
      // all. Recorded as a weak scenario so it is visible in the output.
      const red = res.failed > 0;
      console.log(`  ${red ? "ok  " : "FAIL"} ${suite}: ${res.passed} passed, ${res.failed} failed (expected >0 failures)`);
      if (!red) { problems.push(`${sc.label}: ${suite} stayed green`); allFlipped = false; }
      continue;
    }
    // The expected assertion must be the thing that failed.
    const failedBlock = res.text.match(/FAIL [^\n]*/g) ?? [];
    const hit = res.text.includes(`FAIL ${expectRed}`) || res.text.includes(`- ${expectRed}`);
    console.log(`  ${hit ? "ok  " : "FAIL"} ${suite}: "${expectRed}" ${hit ? "went red" : "did NOT go red"} (${res.passed}p/${res.failed}f)`);
    if (!hit) {
      problems.push(`${sc.label}: expected assertion never went red — ${failedBlock.slice(0, 3).join(" | ") || "nothing failed"}`);
      allFlipped = false;
    }
  }

  // Restore, then prove the restore — a silent restore failure makes every
  // later scenario run on top of this one's damage (the batch-4 trap).
  writeFileSync(sc.file, beforeSrc);
  const restored = sha(normalize(readFileSync(sc.file, "utf8")));
  assertPristine(pristine, `after restoring "${sc.label}"`);
  console.log(`  restored (${restored})  ${allFlipped ? "✓ scenario valid" : "✗ scenario INVALID"}`);
  ran++;
}

// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(64)}`);
const final = await runSuite("tests/suites/architecture.test.mjs");
const finalScope = await runSuite("tests/tools/_schema-scope.mjs");
const finalManifest = await runSuite("tests/suites/manifest-validation.test.mjs");
console.log(`post-restore: architecture ${final.passed}p/${final.failed}f, ` +
  `schema-scope ${finalScope.passed}p/${finalScope.failed}f, ` +
  `manifest ${finalManifest.passed}p/${finalManifest.failed}f`);
// A missing summary here means "I could not read the result", which is a
// failure — not an absence of failure.
for (const [label, res] of [["architecture", final], ["schema-scope", finalScope], ["manifest", finalManifest]]) {
  if (res.aborted) problems.push(`${label} produced no readable verdict after restore (${res.err})`);
  else if (res.failed) problems.push(`${label} not green after restore (${res.failed} failed)`);
}
assertPristine(pristine, "final");

console.log(`\n${ran} scenario(s) executed, ${problems.length} problem(s)`);
if (problems.length) {
  console.log("\nProblems:");
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log("Every guard under test was observed to fail on its own defect.");
}

main().catch((e) => {
  console.error("\nTOOL ERROR:", (e && e.stack) || e);
  process.exit(1);
});
