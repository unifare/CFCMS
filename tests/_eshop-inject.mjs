/**
 * Reverse-validation for tests/theme-eshop.test.mjs.
 *
 * Usage:
 *   node tests/_eshop-inject.mjs inject <scenario>   # mutate themes/eshop
 *   node tests/_eshop-inject.mjs restore             # byte-exact rollback
 *   node tests/_eshop-inject.mjs list
 *
 * Not wired into `npm test` — it is a *tool*, run by hand when the eshop suite
 * itself changes, the same way you would re-inject a defect to check a guard.
 * See `tests/_extension-rules.mjs` for the other half of that idea.
 *
 * ## Three mistakes this file exists to not repeat
 *
 * 1. **A byte-count guard cannot see a same-length mutation.** The first
 *    version asserted `before !== after` in *length*; `"/shop/"` -> `"/blog/"`
 *    is exactly the same number of bytes, so the guard reported "changed
 *    nothing" for a mutation that had in fact landed — a false negative in the
 *    very tool meant to prevent false negatives. This version compares a
 *    content hash.
 *
 * 2. **`git checkout -- <path>` cannot restore a file git has never seen.**
 *    `themes/eshop/` was new and untracked, so the earlier "restore" was a
 *    silent no-op: every scenario stacked on the previous one and the suite
 *    accumulated failures from defects that were supposedly undone.
 *
 * 3. **A snapshot taken while the tree was already dirty preserves the dirt.**
 *    Twice, a leftover mutation was captured into the snapshot and then
 *    dutifully "restored" seven times, so the suite kept failing on a defect no
 *    scenario had introduced. `assertPristine` now rejects both a dirty
 *    snapshot and a restore that did not clean up.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const THEME_DIR = join(root, "themes", "eshop");
const SNAP = join(root, ".wrangler", "eshop-snapshot");

const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

function read(rel) { return readFileSync(join(THEME_DIR, rel), "utf8"); }
function write(rel, text) { writeFileSync(join(THEME_DIR, rel), text); }

// `probe` runs the same substitution the mutation will, so the guard can verify
// the *content* changed even when the length does not. `minMatches` asserts the
// mutation hit every instance it intended to: a scoped defect that exists twice
// and is injected once leaves the other instance green — the fixture-drift
// lesson again, one level down.
function mutate(rel, re, to, minMatches = 1) {
  const before = read(rel);
  const hits = (before.match(new RegExp(re.source, re.flags + (re.flags.includes("g") ? "" : "g"))) ?? []).length;
  if (hits < minMatches) {
    throw new Error(`${rel}: pattern ${re} matched ${hits} time(s), expected >= ${minMatches}`);
  }
  const after = before.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"), to);
  if (after === before) throw new Error(`${rel}: pattern ${re} matched nothing`);
  write(rel, after);
  return { rel, before: hash(before), after: hash(after), hits };
}

// Whole-document surgery for mutations a single regex cannot express safely
// (deleting one route object via regex would stop at the first inner `}`).
// The pristine checks below are semantic, so a re-serialized manifest is fine.
function mutateJson(rel, fn) {
  const before = read(rel);
  const doc = JSON.parse(before);
  const changed = fn(doc);
  if (!changed) throw new Error(`${rel}: JSON mutation was a no-op`);
  write(rel, JSON.stringify(doc, null, 2) + "\n");
  return { rel, before: hash(before), after: hash(read(rel)) };
}

const SCENARIOS = {
  // A child that leaves a section unclosed: the engine reads it as a layout
  // slot and renders an empty <main> at HTTP 200. Must redden
  // "every child closes every section it opens".
  "unclosed-section": () => mutate("templates/archive-product.html", /\{\{\/section\}\}/, ""),

  // Both listing routes (the front page and /shop) lose their scope name, so
  // the `products` collection the archive template iterates is declared
  // nowhere. The front page and /shop share one defect class; injecting only
  // one would leave the other half green. Must redden both
  // "the listing route names its scope" AND "the front-page route names its scope".
  "route-scope": () => mutate("theme.json", /"as":\s*"products"/, '"as": "items"', 2),

  // The item route forgets which column identifies a single object, so a miss
  // stops being distinguishable from a hit. Must redden
  // "the item route resolves the table by slug".
  "resolve-by": () => mutate("theme.json", /"by":\s*"slug"/, '"by": "id"'),

  // A field the templates render stops being translatable — the two halves of
  // the declaration disagree. Must redden
  // "only the text-bearing fields are translatable".
  translatable: () => mutate("theme.json", /"translatable":\s*\[[^\]]*\]/, '"translatable": ["name"]'),

  // The front page stops being the shop: the "/" route vanishes and the home
  // request falls back to the blog listing. Must redden all four
  // "the front page / route" assertions.
  "home-route": () =>
    mutateJson("theme.json", (doc) => {
      const n = doc.routes.length;
      doc.routes = doc.routes.filter((r) => r.path !== "/");
      return doc.routes.length === n - 1;
    }),

  // The link points at a path no route serves: the classic "renders 200, points
  // at a 404" defect. **Same byte length as the correct form** — which is why
  // this scenario is the regression test for mistake (1) above.
  // Must redden "archive links to the route's own path".
  "link-path": () => mutate("templates/archive-product.html", /\/\{\{locale\}\}\/shop\//, "/{{locale}}/blog/"),

  // A declared template ships no file. Must redden
  // "every declared template exists" (and the architecture rule).
  "missing-template-file": () => {
    const rel = "templates/single-product.html";
    if (!existsSync(join(THEME_DIR, rel))) throw new Error(`${rel} already absent`);
    renameSync(join(THEME_DIR, rel), join(THEME_DIR, rel + ".hidden"));
    return { rel, before: read(rel + ".hidden").length, after: -1 };
  },

  // A locale is declared but ships no pack, so the key-prefix rule would be
  // enforced against an empty set — the second recorded false-green mode.
  // Must redden "every declared locale ships a pack".
  "missing-lang-pack": () => {
    const rel = "langs/zh-CN.json";
    if (!existsSync(join(THEME_DIR, rel))) throw new Error(`${rel} already absent`);
    renameSync(join(THEME_DIR, rel), join(THEME_DIR, rel + ".hidden"));
    return { rel, before: read(rel + ".hidden").length, after: -1 };
  },
};

const [, , action, scenario] = process.argv;

function snapshot() {
  rmSync(SNAP, { recursive: true, force: true });
  if (existsSync(SNAP)) throw new Error(`could not clear ${SNAP}`);
  cpSync(THEME_DIR, SNAP, { recursive: true });
  const probe = join(SNAP, "theme.json");
  if (!existsSync(probe)) throw new Error("snapshot did not copy theme.json");
  assertPristine(SNAP, "refusing to snapshot");
}

/**
 * A snapshot taken while the tree was already dirty faithfully preserves the
 * dirt — every "restore" then restores the corruption, and the suite keeps
 * failing on a defect that no scenario introduced. That happened twice while
 * writing this file: a leftover `by: "id"` was snapshotted and dutifully
 * restored seven times, then a missing `{{/section}}` in
 * `templates/archive-product.html` survived the same way.
 *
 * So the snapshot is checked against the properties the suite asserts, and a
 * dirty tree is rejected instead of enshrined.
 */
function assertPristine(dir, prefix) {
  const manifest = readFileSync(join(dir, "theme.json"), "utf8");
  const problems = [];
  if (!/"by":\s*"slug"/.test(manifest)) problems.push('by is not "slug"');
  if (!/"as":\s*"products"/.test(manifest)) problems.push('query.as is not "products"');
  if (!/"translatable":\s*\[\s*"name",\s*"blurb"\s*\]/.test(manifest)) {
    problems.push('translatable is not ["name","blurb"]');
  }
  // The front page must be claimed: a snapshot missing the "/" route would
  // faithfully restore a theme whose home page is the blog again.
  const routes = JSON.parse(manifest).routes.map((r) => r.path);
  if (!routes.includes("/")) problems.push('no "/" route (front page not claimed)');
  // Every child must close every section it opens; a layout legitimately has an
  // unclosed slot, so only files that `@extends` are checked.
  for (const f of ["404", "archive-product", "index", "page", "single", "single-product"]) {
    const p = join(dir, "templates", `${f}.html`);
    if (!existsSync(p)) { problems.push(`${f}.html missing`); continue; }
    const src = readFileSync(p, "utf8");
    if (!/\{\{@extends/.test(src)) continue;
    const opens = (src.match(/\{\{@section\s/g) ?? []).length;
    const closes = (src.match(/\{\{\/section\}\}/g) ?? []).length;
    if (opens !== closes) problems.push(`${f}.html ${opens} open / ${closes} closed`);
  }
  if (problems.length) {
    throw new Error(`${prefix}: themes/eshop/ is not pristine — ${problems.join("; ")}. ` +
      "Fix the tree, confirm `node tests/theme-eshop.test.mjs` is green, then re-run.");
  }
}

function restore() {
  if (!existsSync(SNAP)) throw new Error("no snapshot to restore from");
  rmSync(THEME_DIR, { recursive: true, force: true });
  if (existsSync(THEME_DIR)) throw new Error(`could not clear ${THEME_DIR}`);
  cpSync(SNAP, THEME_DIR, { recursive: true });
  // Prove it: the restored theme.json must hash to what we snapshotted.
  const want = readFileSync(join(SNAP, "theme.json"), "utf8");
  const got = readFileSync(join(THEME_DIR, "theme.json"), "utf8");
  if (hash(want) !== hash(got)) throw new Error("restore did not reproduce theme.json");
  const strays = ["templates/single-product.html.hidden", "langs/zh-CN.json.hidden"];
  for (const s of strays) {
    if (existsSync(join(THEME_DIR, s))) throw new Error(`stray ${s} survived the restore`);
  }
  // A restore that cannot prove it restored is not a restore.
  assertPristine(THEME_DIR, "restore produced a non-pristine tree");
  console.log(`restored themes/eshop/ from snapshot (theme.json ${hash(got)})`);
}

if (action === "list") {
  console.log(Object.keys(SCENARIOS).join("\n"));
  process.exit(0);
}

if (action === "restore") { restore(); process.exit(0); }

if (action !== "inject" || !SCENARIOS[scenario]) {
  console.error(`usage: node .wrangler/eshop-inject.mjs inject <${Object.keys(SCENARIOS).join("|")}>`);
  console.error("       node .wrangler/eshop-inject.mjs restore | list");
  process.exit(2);
}

snapshot();
const r = SCENARIOS[scenario]();
// Compare hashes, not lengths. A same-length edit is exactly what mistake (1)
// was, and it is the mutation this guard would otherwise wave through.
if (r.before === r.after) {
  throw new Error(`injection "${scenario}" changed nothing (hash ${r.before} -> ${r.after})`);
}
console.log(`injected ${scenario} into ${r.rel}`);
console.log(`  hash ${r.before} -> ${r.after}`);
