/**
 * Deploy-config parity guard: does `wrangler.local.jsonc` still mirror
 * `wrangler.jsonc`?
 *
 * ## Why this exists
 *
 * `wrangler.jsonc` is committed and carries `REPLACE_WITH_*` placeholders;
 * `wrangler.local.jsonc` is gitignored and carries this account's real ids.
 * Every command runs against the **local** file, so the local file is the one
 * that actually ships — but the committed file is the one that gets reviewed.
 * The local file says so itself, in its own header:
 *
 *     Keep the two files structurally identical apart from the three ids and
 *     the paid-plan block; a field added to one but not the other is a deploy
 *     that silently differs from the repository.
 *
 * That invariant had already drifted. The `vars` block added in batch 11 (the
 * platform feature switches) went into `wrangler.jsonc` only, and nobody
 * noticed for two batches — because an **omitted** var and an explicit
 * `"false"` both resolve to off. The deployed Worker therefore had no `vars`
 * at all, and the only way to find out was to set one and watch the deploy
 * ignore it. This guard is what turns that into a red line.
 *
 * ## Why it is a tool and not an assertion in `architecture.test.mjs`
 *
 * The local file is gitignored, so it is absent on a fresh clone. An assertion
 * that skips when the file is missing is green-by-absence: it would report the
 * same "pass" for a perfectly mirrored config and for a config nobody has ever
 * compared. So the file-present case is checked here, loudly, and the
 * file-absent case is reported as **n/a** — never as a pass. The half of this
 * rule that *is* checkable from the repository (`varName` ↔ `vars` keys) lives
 * in `architecture.test.mjs`, where it cannot be skipped.
 *
 * ## What it checks
 *
 *   1. Top-level key sets are identical, in both directions.
 *   2. `vars` key sets are identical, in both directions.
 *   3. Placeholder hygiene: the committed file keeps `REPLACE_WITH_*` and
 *      contains no UUID- or 32-hex-shaped id, and the local file contains no
 *      `REPLACE_WITH_*` (it is the one that has to be runnable).
 *
 * Usage: node tests/tools/_config-parity.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEMPLATE = join(ROOT, "wrangler.jsonc");
const LOCAL = join(ROOT, "wrangler.local.jsonc");

let pass = 0;
let fail = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else {
    fail++;
    console.log(`  FAIL ${name}`);
    console.log(`       actual:   ${JSON.stringify(actual)}`);
    console.log(`       expected: ${JSON.stringify(expected)}`);
    failures.push(name);
  }
}

/** Strip line comments and block comments, then parse.
 *  Deliberately the same idiom the suites use — a JSONC parser dependency for
 *  one file would be a second definition of "how these configs are read". */
function readJsonc(path) {
  const src = readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(src);
}

console.log("Deploy config parity (wrangler.jsonc vs wrangler.local.jsonc)");

const template = readJsonc(TEMPLATE);

if (!existsSync(LOCAL)) {
  console.log("  n/a  wrangler.local.jsonc is absent — nothing to compare");
  console.log("");
  console.log("This is NOT a pass. The local deploy config is gitignored, so on a");
  console.log("fresh clone there is nothing here to verify; the committed half of");
  console.log("the rule (switch varName <-> wrangler.jsonc vars) is asserted in");
  console.log("tests/suites/architecture.test.mjs, which cannot be skipped.");
  console.log("");
  console.log("0 passed, 0 failed");
  process.exit(0);
}

const local = readJsonc(LOCAL);

// -- 1. top-level keys, both directions ------------------------------------
const templateKeys = Object.keys(template).sort();
const localKeys = Object.keys(local).sort();
check("the two configs declare the same top-level keys", localKeys, templateKeys);

// -- 2. `vars`, both directions --------------------------------------------
// Split out from (1) because a `vars` block present on both sides but holding
// different switches is the exact shape batch 11 shipped, and "the key exists"
// would not have caught it.
const templateVars = Object.keys(template.vars ?? {}).sort();
const localVars = Object.keys(local.vars ?? {}).sort();
check("the two configs declare the same vars keys", localVars, templateVars);

// -- 3. placeholder hygiene ------------------------------------------------
// Checked against **values**, never raw source: both files legitimately *talk
// about* placeholders in their comments (the local file's header explains the
// mechanism), and a guard that cannot tell documentation from configuration
// would fail on the comment that documents it. First run of this tool did
// exactly that.
const stringValues = (o, out = []) => {
  if (typeof o === "string") out.push(o);
  else if (Array.isArray(o)) for (const v of o) stringValues(v, out);
  else if (o && typeof o === "object") for (const v of Object.values(o)) stringValues(v, out);
  return out;
};
const templateValues = stringValues(template);
const localValues = stringValues(local);
// An account-scoped id in a public repository: a D1/KV id is a UUID, and some
// Cloudflare ids are 32 hex chars. Matching the *shape* rather than a known
// value means this still works after the ids rotate.
const ID_SHAPED = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i;
check(
  "the committed config keeps placeholders instead of real ids",
  templateValues.filter((v) => ID_SHAPED.test(v)),
  []
);
check(
  "the committed config still documents its placeholders",
  templateValues.filter((v) => v.includes("REPLACE_WITH_")).length > 0,
  true
);
check(
  "the local config has replaced every placeholder",
  localValues.filter((v) => v.includes("REPLACE_WITH_")),
  []
);

console.log("");
console.log(`${pass} passed, ${fail} failed`);
if (fail) {
  console.log("");
  console.log("Failing checks:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail ? 1 : 0);
