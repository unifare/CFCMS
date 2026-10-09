/**
 * Architecture tests — the machine enforcement of docs/ARCHITECTURE.md.
 *
 * These do not test behaviour. They test *shape*: which layer may depend on
 * which, what must never appear in an extension, and which conventions are
 * non-negotiable. They exist because documentation cannot stop a future change
 * (human or AI) from drifting; a failing test can.
 *
 * Every test here corresponds to a numbered rule in docs/ARCHITECTURE.md §10.
 * When a rule changes there, change it here in the same commit.
 *
 * Usage: node tests/suites/architecture.test.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, isAbsolute, sep } from "node:path";
import { langPackProblems, themeManifestProblems } from "../fixtures/_extension-rules.mjs";
// The editor palette must be this array (see the one-definition guard below).
import { CORE_BLOCKS } from "../../src/rendering/blocks.ts";
// The field-type classification is imported, never re-listed: the validator and
// the scaffolder read the same source, so "is this field prose?" has one answer.
import {
  ALLOWED_AGGREGATES,
  ALLOWED_FIELD_TYPES,
  ALLOWED_PAGE_BLOCKS,
  ALLOWED_TABLE_FIELD_TYPES,
  LANGUAGE_NEUTRAL_FIELD_TYPES,
  PLUGIN_PAGE_SCREEN_PREFIX,
  PROSE_FIELD_TYPES,
  isProseFieldType,
} from "../../src/extensions/contract/manifest.ts";
// The channel contract's closed type set has to agree with the admin control
// list, the same way the table field types do. Imported, not copied.
import { ALLOWED_CHANNEL_FIELD_TYPES, HOST_CHANNEL_CODES } from "../../src/extensions/contract/channels.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    failures.push({ name, detail });
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}

/**
 * Assert a list is empty — the *only* correct way to write "no offenders".
 *
 * ⚠️ Do not write `check(name, offenders, [])`. `check` tests **truthiness**,
 * and an empty array is truthy, so that spelling asserts nothing and cannot
 * fail. Seven guards in the batch-6 sections were written that way and stayed
 * green with a blatant defect (a duplicate `MediaUploaded`) sitting on disk —
 * the eighth false-green in this repo, and the first one *inside the guards*.
 *
 * This helper exists so the intent is expressible without repeating
 * `offenders.length === 0` at every call site; the parameter name is `offenders`
 * rather than `list` to make the call read as the rule it enforces.
 */
function checkEmpty(name, offenders) {
  const list = Array.isArray(offenders) ? offenders : [offenders];
  check(
    name,
    list.length === 0,
    list.length ? `${list.length}: ${list.join(" | ")}` : ""
  );
}

/**
 * Guard the guard: no `check()` may pass a collection as its condition.
 *
 * A shape error in an assertion is invisible at runtime — the assertion simply
 * never fails — so it has to be caught *lexically*. This scans this file for
 * the exact spelling above and fails if it reappears. It is the same idea as
 * `tests/suites/architecture.test.mjs` refusing to match strings where a structure
 * needs parsing: here the "structure" is the argument being a bare identifier
 * whose name is in a known collection-noun set.
 *
 * Keep this near `checkEmpty` so the two read together.
 */
function findTruthyCollectionCalls(src) {
  // Any `check(<string>, <anything>, [])`. The third argument of `check` is a
  // *detail string*, so passing `[]` there means the author believed this was a
  // comparison helper — and whatever they passed as the condition (a bare
  // identifier, `.filter(...)`, a spread) is being tested for **truthiness**.
  // An array is always truthy, so the assertion cannot fail.
  //
  // Matching any expression, not just a bare identifier, matters: the first
  // version of this scan only caught `check("x", someList, [])`, and two
  // vacuous calls whose condition was `.filter(...)` sailed through.
  const re = /check\(\s*"[^"]*"\s*,\s*[\s\S]*?,\s*\[\]\s*\)/g;
  return [...src.matchAll(re)].map((m) => m[0].replace(/\s+/g, " ").slice(0, 80));
}

function section(title) {
  console.log(`\n${title}`);
}

/** Every file under `dir` whose name ends with one of `exts`. */
function walk(dir, exts, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, exts, out);
    else if (exts.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

const read = (f) => readFileSync(f, "utf8");
const rel = (f) => relative(ROOT, f).split(sep).join("/");

/**
 * Replace comments with same-length whitespace, preserving newlines.
 *
 * Guards below must read *code*, not prose: several of them document the very
 * pattern they forbid, and a guard that fires on its own explanatory comment is
 * unusable. Deleting comments outright would work too — but then every reported
 * line number drifts upward by the size of the comments above it, and an
 * offender list that points at the wrong line trains people to ignore it.
 */
function blankComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^([ \t]*)\/\/.*$/gm, (m, indent) => indent);
}

// ---------------------------------------------------------------------------
section("Layer boundaries (docs/ARCHITECTURE.md §7.3)");
// ---------------------------------------------------------------------------

/**
 * Rule 2/3: platform and rendering must not know about extensions.
 *
 * This is the load-bearing rule behind "a theme or plugin can be added or
 * removed without touching the platform". If platform code imported an
 * extension, that extension would silently become a hard dependency.
 *
 * Paths are resolved rather than text-matched, for the same reason as the
 * theme/plugin check below: `"../extensions/..."` is the real spelling, and a
 * naive `includes("/extensions/")` test is easy to fool.
 */
const extensionRoot = join(ROOT, "src/extensions");
const platformOffenders = [];
for (const pdir of ["src/platform", "src/rendering"]) {
  const dir = join(ROOT, pdir);
  for (const f of walk(dir, [".ts"])) {
    for (const m of read(f).matchAll(/from\s*["']([^"']+)["']/g)) {
      const spec = m[1];
      if (!spec.startsWith(".")) continue;
      const abs = resolve(dirname(f), spec);
      const relToExt = relative(extensionRoot, abs);
      if (relToExt !== "" && !relToExt.startsWith("..") && !isAbsolute(relToExt)) {
        platformOffenders.push(`${rel(f)} -> ${spec}`);
      }
    }
  }
}
check(
  "platform/ and rendering/ do not import extensions/",
  platformOffenders.length === 0,
  platformOffenders.join("\n       ")
);

/**
 * Rule 5: `shared/` is a leaf. It may not depend on any business layer.
 *
 * `shared/` is imported by everybody, so a dependency from it on `platform/`
 * or `extensions/` would make the whole dependency graph cyclic and mean a
 * change to a business rule could ripple into "pure" utilities.
 */
const sharedDir = join(ROOT, "src/shared");
const sharedOffenders = [];
for (const f of walk(sharedDir, [".ts"])) {
  for (const m of read(f).matchAll(/from\s*["']([^"']+)["']/g)) {
    const spec = m[1];
    if (!spec.startsWith(".")) continue;
    const abs = resolve(dirname(f), spec);
    for (const forbidden of ["platform", "rendering", "extensions"]) {
      const relTo = relative(join(ROOT, "src", forbidden), abs);
      if (relTo !== "" && !relTo.startsWith("..") && !isAbsolute(relTo)) {
        sharedOffenders.push(`${rel(f)} -> ${spec}  (reaches ${forbidden}/)`);
      }
    }
  }
}
check(
  "shared/ depends on no business layer",
  sharedOffenders.length === 0,
  sharedOffenders.join("\n       ")
);

/**
 * Rule 4: themes and plugins must not import each other.
 *
 * Both consume the *same* host interface, which is what makes "a plugin can
 * register an admin menu" free rather than a special case. A cross-import
 * would break that symmetry and couple two independently-installable units.
 *
 * ## Why this check resolves paths instead of matching text
 *
 * An earlier version tested `spec.includes("/extensions/plugin/")`. That never
 * matched anything in practice: the real specifier is `"../plugin/runtime"`,
 * which contains no `/extensions/` at all. The check passed vacuously — and an
 * injection test (adding `import ... from "../plugin/runtime"` to a theme)
 * confirmed it *still* passed. A guard against coupling that cannot see the
 * coupling is worse than no guard, because it is trusted.
 *
 * So we resolve each specifier against the file's own directory and compare
 * real paths. This also makes the check immune to how the import is spelled
 * (relative, aliased, or `from"..."` with no space).
 */
const themeDir = join(ROOT, "src/extensions/theme");
const pluginDir = join(ROOT, "src/extensions/plugin");

/** True when `spec` as written in `file` resolves into `targetDir`. */
function resolvesInto(file, spec, targetDir) {
  const abs = resolve(dirname(file), spec);
  const relToTarget = relative(targetDir, abs);
  return relToTarget !== "" && !relToTarget.startsWith("..") && !isAbsolute(relToTarget);
}

const crossOffenders = [];
for (const [sourceDir, targetDir, label] of [
  [themeDir, pluginDir, "plugin/"],
  [pluginDir, themeDir, "theme/"],
]) {
  for (const f of walk(sourceDir, [".ts"])) {
    const src = read(f);
    for (const m of src.matchAll(/from\s*["']([^"']+)["']/g)) {
      const spec = m[1];
      if (!spec.startsWith(".")) continue;
      if (resolvesInto(f, spec, targetDir)) {
        crossOffenders.push(`${rel(f)} -> ${spec}  (resolves into ${label})`);
      }
    }
  }
}
check(
  "theme/ and plugin/ do not import each other",
  crossOffenders.length === 0,
  crossOffenders.join("\n       ")
);

// ---------------------------------------------------------------------------
section("Extensions never touch the database directly (§10 rule 9)");
// ---------------------------------------------------------------------------

/**
 * Rule 9: a theme must not write SQL. It declares a table and calls the host
 * facade; the platform owns the DDL, the naming and the migration path.
 *
 * Rationale (docs §3.3): business tables are generated, so a theme that issued
 * its own `CREATE TABLE` would produce a table the platform cannot see, name,
 * migrate or clean up.
 *
 * Only the *shipped* extension bundles are scanned. Test fixtures under
 * tests/ are allowed to reach into the database, since that is how they assert
 * what the platform did on the extension's behalf.
 */
const dbWriteRe = /\.prepare\s*\(\s*[`"']\s*(?:SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/i;
for (const [label, dirs] of [
  ["content/themes/", ["content/themes"]],
  ["content/plugins/", ["content/plugins"]],
]) {
  const files = dirs.flatMap((d) => walk(join(ROOT, d), [".js", ".mjs", ".ts"]));
  const offenders = [];
  for (const f of files) {
    const src = read(f);
    // Strip comments so prose *about* SQL does not trip the check.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    if (dbWriteRe.test(code)) offenders.push(rel(f));
  }
  check(
    `${label} contains no direct SQL`,
    offenders.length === 0,
    offenders.length ? `offenders: ${offenders.join(", ")}` : ""
  );
}

// ---------------------------------------------------------------------------
section("No hardcoded site / locale defaults (§10 rules 4, 5)");
// ---------------------------------------------------------------------------

/**
 * Rule 4: data-access functions take `siteId` and `locale` explicitly, with no
 * default value.
 *
 * A `siteId = "default"` default is how a multi-site bug hides: the call site
 * compiles, runs, and silently reads the wrong site's data. Making the
 * parameter required turns that into a compile error. This was the root cause
 * of the `activeTheme()` defect fixed in v0.7.0.
 *
 * ✅ SATISFIED as of the batch-1 cleanup: all 26 defaults are gone. The ratchet
 * that previously allowed them has been deleted — this is now a hard rule with
 * zero tolerance, so there is no constant left to quietly raise later.
 *
 * The pattern also matches *constant* defaults (`siteId = DEFAULT_SITE_ID`).
 * An earlier version only matched string literals, which let six constant-form
 * defaults sit in src/api.ts while the test reported the rule as merely
 * "tracked". A default is a default regardless of how it is spelled.
 *
 * Precision matters here: a naive `siteId\s*=` match also fires on SQL
 * fragments (`WHERE locale=?`), object-literal properties (`{ locale: x }`)
 * and ternaries (`locale = a ? b : c`). So the pattern is anchored to a
 * *function parameter list*: match `=` only when the token is followed by a
 * literal default and the enclosing bracket is a `(`. The lookahead for
 * `=>`/`?` excludes arrow bodies and ternaries.
 *
 * Carve-out: a default is legitimate when the value is *derived from the
 * request* — `requestSiteId(url)` falling back to the default site is the one
 * place the choice actually has to be made. That is written as a call, not a
 * literal default, so it does not match (and does not need an exception list).
 */
const defaultParamRe =
  /\b(siteId|locale)\s*(?::\s*[\w<>[\]| ]+)?\s*=\s*("default"|'default'|[A-Z][A-Z0-9_]{2,})\s*(?=[,)])/g;

const srcFiles = walk(join(ROOT, "src"), [".ts"]);
const defaultParamOffenders = [];
for (const f of srcFiles) {
  const src = read(f);
  const code = blankComments(src);
  for (const m of code.matchAll(defaultParamRe)) {
    // Confirm the match sits inside a parameter list: the nearest unmatched
    // `(` before it must not be a call to something else. A cheap, reliable
    // proxy is to require the match to be preceded by `(` or `,` on the same
    // logical line, which is how parameters are written.
    const before = code.slice(0, m.index);
    const lineStart = before.lastIndexOf("\n") + 1;
    const sameLine = code.slice(lineStart, m.index);
    if (!/[(,]\s*(?:readonly\s+)?\w+\s*(?::\s*[\w<>[\]| ]+)?\s*,?\s*$/.test(sameLine)) continue;

    const line = src.slice(0, m.index).split("\n").length;
    defaultParamOffenders.push(`${rel(f)}:${line}  ${m[0].trim()}`);
  }
}

check(
  "no `siteId`/`locale` parameter defaults anywhere in src/",
  defaultParamOffenders.length === 0,
  defaultParamOffenders.length
    ? `make the parameter required and fix the call sites instead:\n       ${defaultParamOffenders.join("\n       ")}`
    : ""
);

/**
 * Rule 4, second form: *fallback expressions* that produce the same effect as a
 * parameter default.
 *
 * The check above matches `siteId = "default"`. It does **not** match
 * `o.siteId ?? "default"` — and that is not a technicality. When this guard was
 * first written it caught the `=` spelling and the constant spelling; by
 * v0.7.1 two `??`/`||` fallbacks had quietly reappeared
 * (`runtime-declarative.ts` `o.siteId ?? "default"`, `api.ts` `|| "en"`).
 * **The problem had not been eliminated — it had been pushed from `=` into
 * `??`.** A guard that matches one spelling of an intent teaches the next
 * author to use the other.
 *
 * So this matches the *operator* forms: `??` and `||` whose right-hand side is
 * a site/locale literal. Together with the parameter check above, every way of
 * spelling "silently fall back to the default" is now covered.
 *
 * Legitimate carve-outs, and why they do not match:
 *  - `requestSiteId(url)` returns `DEFAULT_SITE_ID` — but as a `return`, not as
 *    a `??`/`||` operand. That is the one place the choice has to be made.
 *  - `x || y` where `y` is a *variable* (e.g. `const next = enabled.find(...)`)
 *    is not a hardcoded default and does not match.
 *  - Reading `?site=` and validating with a regex does not match: the fallback
 *    is inside `requestSiteId`.
 */
const fallbackLiteralRe =
  /(?:^|[^\w$])(?:siteId|locale)\b[^\n]{0,120}?(\?\?|\|\|)\s*(?:"(?:default|en)"|'(?:default|en)'|DEFAULT_SITE_ID)/g;

/**
 * An exemption marker, deliberately spelled as a comment so it can be grepped
 * and reviewed. There is exactly one legal site/locale fallback in the
 * codebase — `resolveSite()` in `platform/sites.ts` — and this is how that file
 * declares it. Any other caller that wants one must come here and argue for it
 * in review, rather than quietly typing `?? "default"`.
 *
 * Why a marker instead of an exception list in this test: a list here would be
 * invisible from the source file. A marker lives next to the code it excuses,
 * so a reader of `sites.ts` sees why it is allowed, and a reader of this test
 * sees that only one marker is expected.
 */
const EXEMPT_MARKER = "ARCH-RULE-EXEMPT: site-default";

const fallbackOffenders = [];
const exemptFiles = [];
for (const f of srcFiles) {
  const raw = read(f);
  const hasMarker = raw.includes(EXEMPT_MARKER);
  if (hasMarker) exemptFiles.push(rel(f));
  // Same comment-stripping rationale as above: this file's own prose quotes
  // the offending forms, and a guard that trips on its own documentation is a
  // guard nobody can keep.
  //
  // Strip comments by replacing them with *newlines equal to their length*, so
  // offsets still line up with the original file. Blanking with "" would shift
  // every reported line number, and a guard that points at the wrong line is a
  // guard people learn to ignore.
  const code = blankComments(raw);
  for (const m of code.matchAll(fallbackLiteralRe)) {
    if (hasMarker) continue;
    const line = code.slice(0, m.index).split("\n").length;
    fallbackOffenders.push(`${rel(f)}:${line}  ${m[0].trim()}`);
  }
}

check(
  "no `siteId`/`locale` fallback to a hardcoded default (`??` / `||`)",
  fallbackOffenders.length === 0,
  fallbackOffenders.length
    ? `resolve the value at its source instead of falling back here; if this is\n` +
      `       genuinely the one place the choice is made, spell it as an explicit\n` +
      `       branch in requestSiteId()/resolveSite():\n       ${fallbackOffenders.join("\n       ")}`
    : ""
);

// The exemption must stay narrow. Count *markers*, not "files where a marker
// happened to matter" — an earlier version of this check only counted a marker
// when the same file also contained an offence, so a second file could claim
// the exemption for free as long as it had nothing to exempt. A guard whose
// scope depends on the absence of violations cannot see scope creep.
check(
  "the fallback exemption is confined to the documented single site",
  exemptFiles.length <= 1,
  exemptFiles.length > 1
    ? `${exemptFiles.length} files carry "${EXEMPT_MARKER}": ${exemptFiles.join(", ")}.\n` +
      `       Only resolveSite() in src/platform/sites.ts may. If this is\n` +
      `       intentional, update §10 rule 4 and this test in the same commit.`
    : ""
);

// ---------------------------------------------------------------------------
section("i18n key namespacing (§10 rule 7)");
// ---------------------------------------------------------------------------

/**
 * Rule 11 (§10): every key in an extension's language pack must carry its
 * owner's prefix — `theme.{name}.` or `plugin.{name}.`.
 *
 * Without this, two extensions that both define `nav.home` overwrite each
 * other in the merged dictionary, and which one wins depends on load order.
 * That is a heisenbug with no correct fix at the call site.
 *
 * The rule itself lives in `tests/fixtures/_extension-rules.mjs`, because
 * `tests/suites/scaffold.test.mjs` asks the same question of a *generated* theme. A
 * copied rule drifts from the original, and the copy is always the stale one.
 */
for (const kind of ["theme", "plugin"]) {
  const problems = langPackProblems(ROOT).filter((p) => p.startsWith(`content/${kind}s/`));
  check(
    `${kind} language packs are correctly namespaced`,
    problems.length === 0,
    problems.join("\n       ")
  );
}

// ---------------------------------------------------------------------------
section("Manifest declarations are internally consistent (§5.3)");
// ---------------------------------------------------------------------------

/**
 * A theme that declares a template it does not ship, or resolves a route
 * against a table it never declared, will fail at render time — deep inside a
 * request, with an error that points at the renderer rather than the manifest.
 * Catching it here makes the manifest the single place a theme can be wrong.
 *
 * Shared with the scaffold test for the same reason as the rule above: the
 * documented acceptance criterion for a generated theme is "passes the
 * architecture test", and running the real rule is the only honest way to say
 * that.
 */
const manifestProblems = themeManifestProblems(ROOT);
check(
  "theme manifests are internally consistent",
  manifestProblems.length === 0,
  manifestProblems.join("\n       ")
);

// ---------------------------------------------------------------------------
section("Every declared field carries multi-language capability (§10 rule 41)");
// ---------------------------------------------------------------------------

/**
 * The product rule this section enforces: **all data in this system has
 * multi-language capability**. A field holding prose must be translatable; a
 * field holding a number, flag or date must not be.
 *
 * Enforced at three levels, deliberately:
 *   1. the validator (`contract/validation.ts`) — catches third-party zips at
 *      install time, which the architecture test can never see;
 *   2. this test — catches *shipped* themes, with a better error message and
 *      without needing a running Worker;
 *   3. the scaffolder — so a newly generated theme is born compliant.
 *
 * The check below is the structural half: the two type lists must **partition**
 * the allowed set. Without it, adding a seventh field type would compile, pass
 * every conformance check (because no shipped theme uses it yet), and quietly
 * escape the rule — which is exactly how the previous guard generations died.
 */
const proseSet = new Set(PROSE_FIELD_TYPES);
const neutralSet = new Set(LANGUAGE_NEUTRAL_FIELD_TYPES);
const allowedSet = new Set(ALLOWED_TABLE_FIELD_TYPES);

const overlap = [...proseSet].filter((t) => neutralSet.has(t));
check(
  "prose and language-neutral field types do not overlap",
  overlap.length === 0,
  overlap.length ? `declared in both lists: ${overlap.join(", ")}` : ""
);

const uncovered = [...allowedSet].filter((t) => !proseSet.has(t) && !neutralSet.has(t));
check(
  "every allowed field type is classified as prose or language-neutral",
  uncovered.length === 0,
  uncovered.length
    ? `unclassified: ${uncovered.join(", ")} — add each to PROSE_FIELD_TYPES or\n` +
      `       LANGUAGE_NEUTRAL_FIELD_TYPES in contract/manifest.ts. A new type that is\n` +
      `       in neither list silently escapes the multi-language rule.`
    : ""
);

const phantom = [...proseSet, ...neutralSet].filter((t) => !allowedSet.has(t));
check(
  "no classification names a field type that does not exist",
  phantom.length === 0,
  phantom.length ? `not in ALLOWED_TABLE_FIELD_TYPES: ${phantom.join(", ")}` : ""
);

/**
 * Which shipped fields violate the rule — checked directly on the manifests so
 * the failure names the file and the field, not just "a manifest is bad".
 *
 * `isProseFieldType` is imported rather than re-derived here: this is the third
 * place that needs the same answer, and a third copy of the rule would drift.
 */
const langOffenders = [];
let langTablesChecked = 0;
for (const dir of ["content/themes", "content/plugins"]) {
  for (const f of walk(join(ROOT, dir), [".json"])) {
    if (!f.endsWith("theme.json") && !f.endsWith("plugin.json")) continue;
    let manifest;
    try {
      manifest = JSON.parse(read(f));
    } catch {
      continue;
    }
    for (const t of manifest.tables ?? []) {
      langTablesChecked++;
      const declared = new Set((t.translatable ?? []).map(String));
      for (const field of t.fields ?? []) {
        const key = String(field?.key ?? "");
        const type = String(field?.type ?? "text");
        const prose = isProseFieldType(type);
        if (prose && !declared.has(key)) {
          langOffenders.push(`${rel(f)}: table ${t.name}, field "${key}" (${type}) is not in translatable`);
        }
        if (!prose && declared.has(key)) {
          langOffenders.push(`${rel(f)}: table ${t.name}, field "${key}" (${type}) is wrongly marked translatable`);
        }
      }
    }
  }
}

// Non-vacuity: a check that iterated zero tables would pass while proving
// nothing. Fail loudly instead, so a rename that hides the manifests from this
// walk is caught rather than celebrated.
check(
  "the multi-language check actually saw some declared tables",
  langTablesChecked > 0,
  langTablesChecked === 0
    ? `walked themes/ and plugins/ and found no manifest with a tables[] block.\n` +
      `       Either every extension dropped its tables, or this check is now\n` +
      `       looking in the wrong place — both need a human.`
    : ""
);

check(
  "shipped themes declare translatable exactly for prose fields",
  langOffenders.length === 0,
  langOffenders.join("\n       ")
);

// ---------------------------------------------------------------------------
section("Extension entry points exist");
// ---------------------------------------------------------------------------

/**
 * A manifest that points at a missing file fails at activation, in production,
 * with the site already switched over. Checking the file exists is cheap and
 * turns that into a caught mistake.
 */
const themeRoot = join(ROOT, "content", "themes");
const themeDirs = existsSync(themeRoot)
  ? readdirSync(themeRoot).filter((d) => statSync(join(themeRoot, d)).isDirectory())
  : [];

const entryProblems = [];
for (const name of themeDirs) {
  const manifestPath = join(themeRoot, name, "theme.json");
  if (!existsSync(manifestPath)) continue;
  let manifest;
  try {
    manifest = JSON.parse(read(manifestPath));
  } catch {
    continue; // already reported above
  }
  if (manifest.runtime === "worker") {
    const entry = String(manifest.entry ?? "worker.js");
    if (!existsSync(join(themeRoot, name, entry))) {
      entryProblems.push(`content/themes/${name}: runtime=worker but ${entry} is missing`);
    }
  }
}

const pluginRoot = join(ROOT, "content", "plugins");
const pluginDirs = existsSync(pluginRoot)
  ? readdirSync(pluginRoot).filter((d) => statSync(join(pluginRoot, d)).isDirectory())
  : [];
for (const name of pluginDirs) {
  const manifestPath = join(pluginRoot, name, "plugin.json");
  if (!existsSync(manifestPath)) continue;
  let manifest;
  try {
    manifest = JSON.parse(read(manifestPath));
  } catch (e) {
    entryProblems.push(`plugins/${name}/plugin.json: invalid JSON (${e.message})`);
    continue;
  }
  if (!manifest.name) entryProblems.push(`plugins/${name}: manifest has no "name"`);
  const hooks = Array.isArray(manifest.hooks) ? manifest.hooks : [];
  if (hooks.length === 0 && manifest.runtime !== "declarative") {
    // Not an error — a plugin may register nothing yet — but the manifest must
    // still be self-describing.
  }
}

check(
  "worker-runtime themes ship the entry file they declare",
  entryProblems.length === 0,
  entryProblems.join("\n       ")
);

// ---------------------------------------------------------------------------
section("Declared admin menus are renderable (batch 3)");
// ---------------------------------------------------------------------------

/**
 * A manifest's `adminMenus[].screen` is the only thing that decides which admin
 * page opens. An unknown value does not fail the install — it produces a
 * sidebar entry that leads to a "no renderer for this screen type" panel, and
 * nothing points back at the manifest. So the shipped extensions are checked
 * against the same list the validator uses.
 *
 * The list is read out of `contract/manifest.ts` rather than copied, and then
 * compared against a pinned set. Copying it would let the two drift; not
 * pinning it would let someone "fix" a failure by adding a screen nobody
 * implements.
 */
const manifestSrc = read(join(ROOT, "src/extensions/contract/manifest.ts"));
const allowedBlock = manifestSrc.match(/const ALLOWED_ADMIN_SCREENS\s*=\s*\[([\s\S]*?)\]/);
const allowedScreens = allowedBlock
  ? [...allowedBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
  : [];
const EXPECTED_SCREENS = [
  "dashboard", "content-list", "content-edit", "settings", "media", "custom",
  "theme-settings", "plugin-settings", "table-list", "table-edit", "features",
];

/** The switch keys the platform ships. Pinned so deleting or renaming one is a
 *  deliberate edit here rather than a silent removal from the admin. */
const FEATURE_SWITCH_KEYS_EXPECTED = ["cache_mirror_kv", "theme_runtime_worker"];
check(
  "ALLOWED_ADMIN_SCREENS contains exactly the pinned set",
  JSON.stringify([...allowedScreens].sort()) === JSON.stringify([...EXPECTED_SCREENS].sort()),
  `implementation: ${JSON.stringify(allowedScreens)}\n       pinned:         ${JSON.stringify(EXPECTED_SCREENS)}`
);

/**
 * The feature-switch vocabulary has exactly one definition, and it is in
 * `shared/features.ts`.
 *
 * It lives in `shared/` and not in `contract/manifest.ts` because
 * `shared/cache.ts` consumes one of the switches and `shared/` is a leaf that
 * may not import `extensions/` (§7.3 rule 5) — the layering check above failed
 * when the vocabulary was first put in `manifest.ts`, which is what caught it.
 *
 * A re-export from `manifest.ts` was tried and removed: it typechecked, but
 * Node loads `manifest.ts` as plain ESM in this suite, and a *value* re-export
 * needs an explicit `.ts` extension that `tsc` in turn rejects without
 * `allowImportingTsExtensions`. Two constraints pointing opposite ways is a
 * signal the extra hop was not wanted — importers go straight to the source.
 *
 * The guard is therefore: the array is defined in exactly one file, that file
 * is the leaf, and nothing else defines a second copy.
 */
const featuresSrc = read(join(ROOT, "src/shared/features.ts"));
const switchDefs = [...walk(join(ROOT, "src"), [".ts"])].filter((f) =>
  /export\s+const\s+FEATURE_SWITCHES\s*(?::[^=]*)?=\s*\[/.test(read(f))
);
check(
  "FEATURE_SWITCHES is defined in exactly one file",
  switchDefs.length === 1 && rel(switchDefs[0]) === "src/shared/features.ts",
  switchDefs.length
    ? `defined in: ${switchDefs.map(rel).join(", ")}`
    : "no definition found — the switch vocabulary has gone missing"
);
check(
  "the switch vocabulary lives in the leaf layer, not in contract/",
  !/FEATURE_SWITCHES/.test(manifestSrc),
  "contract/manifest.ts mentions the switches — it must not own or re-export them"
);

// Every switch must carry all four fields, and the defaults must be explicit
// booleans. A missing `defaultOn` would read as `undefined` -> falsy, which
// happens to be the intended default today and would silently become "on" for
// a future switch whose author forgot the field.
const declaredSwitches = [...featuresSrc.matchAll(/\{\s*key:\s*"([a-z0-9_]+)",[\s\S]*?defaultOn:\s*(true|false),/g)]
  .map((m) => ({ key: m[1], defaultOn: m[2] === "true" }));
check(
  "every declared feature switch states its default explicitly",
  declaredSwitches.length === FEATURE_SWITCH_KEYS_EXPECTED.length,
  `parsed ${declaredSwitches.length} of ${FEATURE_SWITCH_KEYS_EXPECTED.length}: ${declaredSwitches.map((s) => s.key).join(", ")}`
);
check(
  "both switches default to off",
  declaredSwitches.length > 0 && declaredSwitches.every((s) => s.defaultOn === false),
  declaredSwitches.filter((s) => s.defaultOn).map((s) => `${s.key}=on`).join(", ")
);
check(
  "declared switch keys match the expected set",
  JSON.stringify(declaredSwitches.map((s) => s.key).sort()) ===
    JSON.stringify([...FEATURE_SWITCH_KEYS_EXPECTED].sort()),
  `implementation: ${JSON.stringify(declaredSwitches.map((s) => s.key))}\n       expected:      ${JSON.stringify(FEATURE_SWITCH_KEYS_EXPECTED)}`
);

// The `varName` in each switch must be a name the runtime can actually read
// off `Env`. `types.ts` spells them out (an interface cannot be derived from
// data), so the two are cross-checked here — a rename on one side only would
// otherwise leave a switch whose deploy-time fallback silently never applies.
const envSrc = read(join(ROOT, "src/shared/types.ts"));
const varNames = [...featuresSrc.matchAll(/varName:\s*"([A-Z0-9_]+)"/g)].map((m) => m[1]);
const undeclaredVars = varNames.filter(
  (v) => !new RegExp(`\\b${v}\\??:\\s*string`).test(envSrc)
);
check(
  "every switch varName is declared on the Env interface",
  varNames.length > 0 && undeclaredVars.length === 0,
  undeclaredVars.map((v) => `${v} is not declared in src/shared/types.ts`).join("\n       ")
);

const TABLE_SCREENS = ["table-list", "table-edit"];
const menuProblems = [];
for (const [kind, dir] of [["theme", "content/themes"], ["plugin", "content/plugins"]]) {
  const base = join(ROOT, dir);
  if (!existsSync(base)) continue;
  for (const name of readdirSync(base)) {
    const manifestPath = join(base, name, kind === "theme" ? "theme.json" : "plugin.json");
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try { manifest = JSON.parse(read(manifestPath)); } catch { continue; }
    const declaredTables = new Set(
      (Array.isArray(manifest.tables) ? manifest.tables : []).map((t) => String(t?.name ?? ""))
    );
    // Pages this plugin declared. A `plugin-page:<id>` menu that names an id
    // which is not here opens a screen with nothing to render — the menu entry
    // looks fine in the sidebar and the page behind it is blank, which reads as
    // a load failure rather than a manifest typo. Rule 50.
    const declaredPages = new Set(
      (Array.isArray(manifest.adminPages) ? manifest.adminPages : []).map((p) => String(p?.id ?? ""))
    );
    for (const menu of Array.isArray(manifest.adminMenus) ? manifest.adminMenus : []) {
      const where = `${dir}/${name}: menu "${menu?.id}"`;
      const screen = String(menu?.screen ?? "");
      if (screen.startsWith(PLUGIN_PAGE_SCREEN_PREFIX)) {
        const pageId = screen.slice(PLUGIN_PAGE_SCREEN_PREFIX.length);
        if (!pageId) menuProblems.push(`${where} uses "${screen}" with no page id`);
        else if (!declaredPages.has(pageId)) {
          menuProblems.push(
            `${where} opens page "${pageId}", which is not in its adminPages[] (${[...declaredPages].join(", ") || "none declared"})`
          );
        }
        continue;
      }
      if (!allowedScreens.includes(screen)) {
        menuProblems.push(`${where} uses unknown screen "${screen}"`);
        continue;
      }
      if (TABLE_SCREENS.includes(screen)) {
        const table = String(menu?.args?.table ?? "");
        if (!table) menuProblems.push(`${where} screen "${screen}" has no args.table`);
        else if (!declaredTables.has(table)) {
          menuProblems.push(`${where} references table "${table}" which is not in its tables[]`);
        }
      }
      if (screen === "custom" && !String(menu?.args?.view ?? "")) {
        menuProblems.push(`${where} screen "custom" has no args.view`);
      }
    }
  }
}
check(
  "every shipped admin menu uses a known screen and names a real table",
  menuProblems.length === 0,
  menuProblems.join("\n       ")
);

// ---------------------------------------------------------------------------
section("Plugins declare data, not code (§10 rule 48)");
// ---------------------------------------------------------------------------

/**
 * A plugin may not ship executable code. This is the rule that makes the whole
 * no-build design honest: a Workers runtime forbids `eval` / `new Function` /
 * dynamic `import` of user code, so a plugin that "runs" can only be one whose
 * behaviour the host performs on its behalf.
 *
 * Two things would break it:
 *
 *   * a `.js`/`.mjs`/`.ts` file inside a shipped plugin directory — even unused,
 *     its presence says "you may load this", and the next change loads it;
 *   * a manifest key that names code (`entry`, `entryFile`, `handler`, `main`,
 *     `script`) — the reference implementation had both `entry` and `entryFile`
 *     for the same idea, which is two authorities for one fact.
 *
 * The check is on shipped directories, not on the contract type: a manifest
 * arriving as a zip is validated by `validation.ts` (which has the same list),
 * and this covers the ones in the repo that a reader would copy from.
 */
const CODE_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".jsx", ".tsx"];
const CODE_KEYS = ["entry", "entryFile", "handler", "main", "script", "activate", "deactivate"];
const pluginCodeProblems = [];
{
  const pluginBase = join(ROOT, "content", "plugins");
  if (existsSync(pluginBase)) {
    for (const name of readdirSync(pluginBase)) {
      const dir = join(pluginBase, name);
      let isDir = false;
      try { isDir = statSync(dir).isDirectory(); } catch { isDir = false; }
      if (!isDir) continue;
      for (const f of walk(dir, CODE_EXTENSIONS)) {
        pluginCodeProblems.push(`plugins/${name}/${relative(dir, f).split(sep).join("/")} is executable code`);
      }
      const manifestPath = join(dir, "plugin.json");
      if (!existsSync(manifestPath)) continue;
      let manifest;
      try { manifest = JSON.parse(read(manifestPath)); } catch { continue; }
      for (const key of CODE_KEYS) {
        if (Object.prototype.hasOwnProperty.call(manifest, key)) {
          pluginCodeProblems.push(
            `plugins/${name}/plugin.json declares "${key}" — a plugin declares data, and the host performs the behaviour`
          );
        }
      }
    }
  }
}
check(
  "no shipped plugin ships executable code or a code-bearing manifest key",
  pluginCodeProblems.length === 0,
  pluginCodeProblems.join("\n       ")
);

// ---------------------------------------------------------------------------
section("Declared plugin pages are renderable (§10 rule 49)");
// ---------------------------------------------------------------------------

/**
 * Every `adminPages[].blocks[].type` must have a renderer in the admin SPA.
 * A block type with no renderer draws nothing where content was promised — a
 * blank screen at HTTP 200, which is the same shape of failure as a template
 * slot that never fills.
 *
 * The SPA is plain ESM with no build step, so the renderer list is a switch in
 * `public/admin/js/plugin-page.js`. Rather than parsing that switch (a
 * structure that could be written several ways), the module exports the list it
 * renders — one authority, and the check is a set comparison.
 */
const pageBlockProblems = [];
{
  const pinnedBlocks = ["table", "stats", "form"];
  check(
    "ALLOWED_PAGE_BLOCKS contains exactly the pinned set",
    JSON.stringify([...ALLOWED_PAGE_BLOCKS].sort()) === JSON.stringify([...pinnedBlocks].sort()),
    `implementation: ${JSON.stringify([...ALLOWED_PAGE_BLOCKS])}\n       pinned:         ${JSON.stringify(pinnedBlocks)}`
  );

  const rendererPath = join(ROOT, "public", "admin", "js", "plugin-page.js");
  if (!existsSync(rendererPath)) {
    pageBlockProblems.push("public/admin/js/plugin-page.js does not exist");
  } else {
    const src = read(rendererPath);
    const match = src.match(/export const RENDERED_BLOCK_TYPES\s*=\s*\[([\s\S]*?)\]/);
    const rendered = match ? [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
    if (!rendered.length) {
      pageBlockProblems.push(
        "plugin-page.js does not export RENDERED_BLOCK_TYPES — the guard cannot tell what it renders"
      );
    } else if (JSON.stringify([...rendered].sort()) !== JSON.stringify([...ALLOWED_PAGE_BLOCKS].sort())) {
      pageBlockProblems.push(
        `renderer/contract mismatch — contract: ${JSON.stringify([...ALLOWED_PAGE_BLOCKS])}, renderer: ${JSON.stringify(rendered)}`
      );
    }

    // The `stats` aggregate list is a second closed set with the same failure
    // shape: the validator refuses a name the renderer cannot draw, and the
    // renderer draws a name the server cannot compute. All three read
    // `ALLOWED_AGGREGATES`; this compares the renderer's exported copy so a
    // one-sided edit fails here instead of shipping a "cannot compute" panel.
    const aggMatch = src.match(/export const RENDERED_AGGREGATES\s*=\s*\[([\s\S]*?)\]/);
    const renderedAgg = aggMatch ? [...aggMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
    if (!renderedAgg.length) {
      pageBlockProblems.push(
        "plugin-page.js does not export RENDERED_AGGREGATES — the guard cannot tell what aggregates it draws"
      );
    } else if (JSON.stringify([...renderedAgg].sort()) !== JSON.stringify([...ALLOWED_AGGREGATES].sort())) {
      pageBlockProblems.push(
        `aggregate mismatch — contract: ${JSON.stringify([...ALLOWED_AGGREGATES])}, renderer: ${JSON.stringify(renderedAgg)}`
      );
    }
  }

  // And every shipped page may only use block types the contract knows.
  for (const name of existsSync(join(ROOT, "content", "plugins")) ? readdirSync(join(ROOT, "content", "plugins")) : []) {
    const manifestPath = join(ROOT, "content", "plugins", name, "plugin.json");
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try { manifest = JSON.parse(read(manifestPath)); } catch { continue; }
    const tables = new Set((Array.isArray(manifest.tables) ? manifest.tables : []).map((t) => String(t?.name ?? "")));
    // The declared numeric fields, so a shipped `sum` can be checked against a
    // column that actually exists and is summable — the same two conditions the
    // server-side `tableAggregate` enforces before it will run a query.
    const numericFields = new Set();
    for (const t of Array.isArray(manifest.tables) ? manifest.tables : []) {
      for (const f of Array.isArray(t?.fields) ? t.fields : []) {
        if (String(f?.type ?? "") === "number") numericFields.add(`${String(t?.name ?? "")}.${String(f?.key ?? "")}`);
      }
    }
    for (const page of Array.isArray(manifest.adminPages) ? manifest.adminPages : []) {
      for (const block of Array.isArray(page?.blocks) ? page.blocks : []) {
        const where = `plugins/${name}: page "${page?.id}" block`;
        const type = String(block?.type ?? "");
        if (!(ALLOWED_PAGE_BLOCKS).includes(type)) {
          pageBlockProblems.push(`${where} has unknown type "${type}"`);
        }
        // A block that reads a table must name one of *its own* tables.
        if (type === "table" || type === "stats" || type === "form") {
          const source = String(block?.source ?? "");
          if (!source) pageBlockProblems.push(`${where} ("${type}") has no source`);
          else if (!tables.has(source)) {
            pageBlockProblems.push(`${where} reads table "${source}", which is not in its tables[]`);
          }
        }
        // A shipped `stats` must name an aggregate the host computes, and a
        // `sum` must point at a declared numeric column.
        if (type === "stats") {
          const agg = String(block?.aggregate ?? "count");
          if (!(ALLOWED_AGGREGATES).includes(agg)) {
            pageBlockProblems.push(`${where} has unknown aggregate "${agg}"`);
          }
          if (agg === "sum") {
            const field = String(block?.field ?? "");
            if (!field) pageBlockProblems.push(`${where} sums with no field`);
            else if (!numericFields.has(`${String(block?.source ?? "")}.${field}`)) {
              pageBlockProblems.push(`${where} sums "${field}", which is not a declared numeric field`);
            }
          }
        }
      }
    }
  }
}
check(
  "every page block type has a renderer, and every shipped block is renderable",
  pageBlockProblems.length === 0,
  pageBlockProblems.join("\n       ")
);

// ---------------------------------------------------------------------------
section("Channel declarations match the host (§10 rule 51)");
// ---------------------------------------------------------------------------

/**
 * A channel declaration has two halves that must agree with the host:
 *
 *   * `code` must be one the host implements. Declaring an unimplemented
 *     channel puts a selectable option in the admin that fails at send time.
 *   * every `configSchema[].type` must have an admin control. The settings form
 *     is generated from the schema, so an unrenderable type makes an empty
 *     input that looks like a data problem rather than a manifest one.
 *
 * The control list lives in `public/admin/js/plugin-page.js`, which exports it
 * for the same reason the block renderer exports its list: a guard that parses
 * a switch statement is guessing at structure it could just be told.
 */
const channelProblems = [];
{
  const pinnedTypes = ["text", "password", "url", "number", "boolean"];
  check(
    "ALLOWED_CHANNEL_FIELD_TYPES contains exactly the pinned set",
    JSON.stringify([...ALLOWED_CHANNEL_FIELD_TYPES].sort()) === JSON.stringify([...pinnedTypes].sort()),
    `implementation: ${JSON.stringify([...ALLOWED_CHANNEL_FIELD_TYPES])}\n       pinned:         ${JSON.stringify(pinnedTypes)}`
  );

  const pageJsPath = join(ROOT, "public", "admin", "js", "plugin-page.js");
  let controlled = [];
  if (!existsSync(pageJsPath)) {
    channelProblems.push("public/admin/js/plugin-page.js does not exist");
  } else {
    const src = read(pageJsPath);
    const match = src.match(/export const RENDERED_CHANNEL_FIELD_TYPES\s*=\s*\[([\s\S]*?)\]/);
    controlled = match ? [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
    if (!controlled.length) {
      channelProblems.push("plugin-page.js does not export RENDERED_CHANNEL_FIELD_TYPES");
    } else if (JSON.stringify([...controlled].sort()) !== JSON.stringify([...ALLOWED_CHANNEL_FIELD_TYPES].sort())) {
      channelProblems.push(
        `control/contract mismatch — contract: ${JSON.stringify([...ALLOWED_CHANNEL_FIELD_TYPES])}, controls: ${JSON.stringify(controlled)}`
      );
    }
  }

  for (const name of existsSync(join(ROOT, "content", "plugins")) ? readdirSync(join(ROOT, "content", "plugins")) : []) {
    const manifestPath = join(ROOT, "content", "plugins", name, "plugin.json");
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try { manifest = JSON.parse(read(manifestPath)); } catch { continue; }
    for (const ch of Array.isArray(manifest.channels) ? manifest.channels : []) {
      const where = `plugins/${name}: channel "${ch?.code}"`;
      if (!(HOST_CHANNEL_CODES).includes(String(ch?.code ?? ""))) {
        channelProblems.push(`${where} is not implemented by the host (${HOST_CHANNEL_CODES.join(", ")})`);
      }
      for (const field of Array.isArray(ch?.configSchema) ? ch.configSchema : []) {
        const type = String(field?.type ?? "");
        if (!(ALLOWED_CHANNEL_FIELD_TYPES).includes(type)) {
          channelProblems.push(`${where} field "${field?.key}" has unknown type "${type}"`);
        }
      }
    }
  }
}
check(
  "every declared channel and config field matches what the host implements",
  channelProblems.length === 0,
  channelProblems.join("\n       ")
);

// ---------------------------------------------------------------------------
section("The retired menu table stays retired");
// ---------------------------------------------------------------------------

/**
 * 0012 moved theme menus into `admin_menu_registry` and dropped
 * `theme_admin_menus`. Two things would quietly undo that:
 *
 *   * source code still reading or writing the old table — the new registry
 *     would fill up while a stale reader returned an empty list, which looks
 *     exactly like "the theme declared no menus";
 *   * a later migration re-creating it, which would leave two tables holding
 *     the same thing again.
 *
 * A text scan is the right shape here: this is a *name* that must not appear,
 * not a structure to be parsed. Comments are stripped first — prose *about*
 * the retirement ("0012 moved rows out of theme_admin_menus") is documentation,
 * not a reader of the table, and punishing it would push the next person to
 * delete the explanation.
 */
const RETIRED = "theme_admin_menus";
const withoutComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const retiredOffenders = [];
for (const f of walk(join(ROOT, "src"), [".ts"])) {
  if (withoutComments(read(f)).includes(RETIRED)) retiredOffenders.push(`${rel(f)} still references ${RETIRED}`);
}
const migrationsRoot = join(ROOT, "content", "migrations");
const laterMigrations = readdirSync(migrationsRoot)
  .filter((f) => /^\d+_.*\.sql$/.test(f))
  .filter((f) => Number(f.split("_")[0]) > 12)
  .filter((f) => withoutComments(read(join(migrationsRoot, f))).includes(RETIRED));
for (const f of laterMigrations) {
  retiredOffenders.push(`content/migrations/${f} references ${RETIRED} after 0012 retired it`);
}
check(
  "no source file or later migration uses the dropped menu table",
  retiredOffenders.length === 0,
  retiredOffenders.join("\n       ")
);

// ---------------------------------------------------------------------------
// The hook contract and the hook implementation must name the same hooks
// ---------------------------------------------------------------------------
//
// `DECLARABLE_HOOKS` is what a plugin manifest may declare; `HOOK_IMPLS` is what
// the host actually supplies. They live in different files on purpose (the
// contract may not import the implementation), which is exactly why they need a
// guard: the list is what the manifest validator checks against, so a hook that
// exists in the implementation but not in the list is undeclarable, and one in
// the list but not the implementation is a typo trap — the validator accepts it
// and the runtime silently drops it.
{
  const hooksSrc = read(join(ROOT, "src/extensions/contract/hooks.ts"));
  const implSrc = read(join(ROOT, "src/extensions/plugin/runtime.ts"));

  const declaredBlock = hooksSrc.match(/export const DECLARABLE_HOOKS\s*=\s*\[([\s\S]*?)\]\s*as const/);
  const declaredHooks = declaredBlock ? [...declaredBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];

  // `HOOK_IMPLS` is an object literal; take its top-level keys, which are the
  // hook names the host can attach.
  const implBlock = implSrc.match(/const HOOK_IMPLS[^=]*=\s*\{([\s\S]*?)\n\};/);
  const implHooks = implBlock ? [...implBlock[1].matchAll(/^  ([A-Za-z][A-Za-z0-9_]*):\s*\{/gm)].map((m) => m[1]) : [];

  // Both halves must be non-empty, or the comparison below passes vacuously.
  check(
    "hook lists were actually parsed (guards against an empty-set pass)",
    declaredHooks.length > 0 && implHooks.length > 0,
    `DECLARABLE_HOOKS=${declaredHooks.length} entries, HOOK_IMPLS=${implHooks.length} entries`
  );
  check(
    "every declarable hook is implemented, and every implementation is declarable",
    JSON.stringify([...declaredHooks].sort()) === JSON.stringify([...implHooks].sort()),
    `declarable:     ${JSON.stringify([...declaredHooks].sort())}\n       implemented:    ${JSON.stringify([...implHooks].sort())}`
  );
}

// ---------------------------------------------------------------------------
section("The domain event contract is coherent (§10 rule 45)");
// ---------------------------------------------------------------------------

/**
 * `events.ts` declares *what happened*; `hooks.ts` declares *where you may
 * attach*. Both are contracts, so both need the same treatment as the hook
 * list above: parsed from source, compared against a pinned set, and checked
 * for non-vacuity before anything is asserted about the set.
 *
 * These are read out of the file rather than imported for the same reason the
 * hook guard does it: the file may not import the implementation, and the
 * architecture suite is deliberately dependency-free (it must run first, with
 * no build step, on a bare checkout).
 */
{
  const eventsSrc = read(join(ROOT, "src/extensions/contract/events.ts"));
  const hooksSrc = read(join(ROOT, "src/extensions/contract/hooks.ts"));

  const eventsBlock = eventsSrc.match(/export const DOMAIN_EVENTS\s*=\s*\[([\s\S]*?)\]\s*as const/);
  const events = eventsBlock ? [...eventsBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];

  const scopedBlock = eventsSrc.match(/export const LOCALE_SCOPED_EVENTS\s*=\s*\[([\s\S]*?)\]\s*as const/);
  const scoped = scopedBlock ? [...scopedBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];

  // Non-vacuity first: every assertion below is a statement about a set, and a
  // set that failed to parse is trivially "consistent".
  check(
    "the event contract was actually parsed (non-vacuity)",
    events.length > 0 && scoped.length > 0,
    `DOMAIN_EVENTS=${events.length} entries, LOCALE_SCOPED_EVENTS=${scoped.length} entries`
  );

  const dupes = events.filter((e, i) => events.indexOf(e) !== i);
  checkEmpty(
    "no domain event is declared twice",
    dupes
  );

  // Naming is the contract's readability: a reader of `PostPublished` knows it
  // already happened, where `savePost` leaves them guessing before-or-after.
  const badlyNamed = events.filter((e) => !/^[A-Z][A-Za-z0-9]*$/.test(e));
  checkEmpty(
    "every domain event is PascalCase, past tense by convention",
    badlyNamed
  );

  // A subscription target that is not an event is the `beforRender` typo again:
  // the validator accepts it, and the hook never fires.
  const scopedNotEvents = scoped.filter((e) => !events.includes(e));
  checkEmpty(
    "every locale-scoped event is a declared domain event",
    scopedNotEvents
  );

  const scopedDupes = scoped.filter((e, i) => scoped.indexOf(e) !== i);
  checkEmpty(
    "no locale-scoped event is listed twice",
    scopedDupes
  );

  // Payload versioning must be *total*: every event resolves to a version even
  // when the override map is empty. `payloadVersionOf` falls back to 1, so the
  // guard checks the fallback path is real by looking for the `?? 1`.
  const versionFn = eventsSrc.match(/export function payloadVersionOf[\s\S]*?\n\}/);
  check(
    "payloadVersionOf has a total fallback (an event with no override still has a version)",
    Boolean(versionFn) && /\?\?\s*1\b/.test(versionFn[0]),
    versionFn ? versionFn[0].replace(/\s+/g, " ").slice(0, 120) : "payloadVersionOf not found"
  );

  // Events live above hooks, not beside them. Collapsing the two is how a CMS
  // gets a `save_post` that means six things — so the file must say so, and the
  // hook list must not have quietly grown event names.
  const hooksLookingLikeEvents = declaredHooksForEvents(hooksSrc).filter((h) => events.includes(h));
  checkEmpty(
    "no domain event is smuggled into the hook list",
    hooksLookingLikeEvents
  );

  // Every event that carries a language must be one whose fact *is* a
  // language-specific statement. `SiteCreated` has no locale; `PostPublished`
  // does. This is a sanity bound rather than a proof — it catches the case
  // where someone marks a site-level fact as locale-scoped by accident.
  const SITE_LEVEL_EVENTS = [
    "SiteCreated", "SiteDeleted", "ExtensionInstalled", "ExtensionEnabled",
    "ExtensionDisabled", "ThemeActivated", "ThemeDeactivated",
    "UserCreated", "UserPasswordChanged", "UserDeleted", "MediaUploaded", "MediaDeleted",
  ];
  const misScoped = scoped.filter((e) => SITE_LEVEL_EVENTS.includes(e));
  checkEmpty(
    "site-level facts are not marked locale-scoped",
    misScoped
  );
}

/** Hook names declared in `hooks.ts`, for the cross-check above. */
function declaredHooksForEvents(src) {
  const block = src.match(/export const DECLARABLE_HOOKS\s*=\s*\[([\s\S]*?)\]\s*as const/);
  return block ? [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
}

// ---------------------------------------------------------------------------
section("Multilingual and URL rules (AGENTS.md 56-59)");
// ---------------------------------------------------------------------------

// Rules 56-59 exist because every layer of i18n has a spelling that fails
// *silently*: a hand-rolled locale regex drifts from the one definition, a
// `|| "en"` fallback makes a zh-CN site read English rows at 200 OK, a slug
// filter without COALESCE 404s every language that named its own slug while
// the default language works fine, and a site-blind SEO endpoint serves
// site A's sitemap on site B's host. Each guard below scans with comments
// blanked and each scan is paired with a non-vacuity check, per §12.

{
  const srcDir = join(ROOT, "src");
  const files = walk(srcDir, [".ts"]);
  const blanked = files.map((f) => ({
    path: relative(ROOT, f).split(sep).join("/"),
    src: blankComments(read(f)),
  }));

  // -- Rule 56: the locale-segment matcher is defined exactly once ----------
  // The BCP-47-ish shape is the fingerprint of "I am parsing a locale off a
  // path". resolve.ts owns it; a second copy is a second policy that will
  // disagree with the first.
  const segRe = /\[\s*a-z\s*\]\s*\{\s*2\s*\}\s*\(\s*\?:\s*-\s*\[A-Za-z\]\s*\{\s*2\s*\}\s*\)\s*\?/;
  const segOwners = blanked.filter((f) => f.path.startsWith("src/platform/i18n/") === false && segRe.test(f.src));
  checkEmpty("the locale-segment matcher lives only in platform/i18n (rule 56)", segOwners.map((f) => f.path));
  check(
    "rule 56 scan actually saw resolve.ts (non-vacuity)",
    blanked.some((f) => f.path.replace(/\\/g, "/") === "src/platform/i18n/resolve.ts") &&
      segRe.test(blankComments(read(join(ROOT, "src/platform/i18n/resolve.ts"))))
  );

  // -- Rule 57: no hardcoded locale fallbacks outside the i18n layer --------
  // `|| "en"` reads as "the caller forgot the locale" and answers with a
  // literal. The blessed path is resolveContentLocale / defaultLocale, both
  // site-scoped; anything else freezes one language into the code.
  const fallbackRe = /(\|\||\?\?)\s*["'](en|zh(?:-CN)?|ja|ko|fr|de|es|pt(?:-BR)?)["']/g;
  const fallbackers = blanked
    .filter((f) => !f.path.startsWith("src/platform/i18n/"))
    .map((f) => ({ path: f.path, hits: [...f.src.matchAll(fallbackRe)].length }))
    .filter((f) => f.hits > 0);
  checkEmpty("no hardcoded locale fallbacks outside platform/i18n (rule 57)", fallbackers.map((f) => `${f.path} (${f.hits})`));

  // -- Rule 58: slug filters across the translations join are COALESCE'd ----
  // Every statement that joins post_translations and filters on p.slug must
  // read COALESCE(t.slug, p.slug) — the per-language URL segment wins, the
  // main-table slug is the fallback. A bare `p.slug = ?` 404s every language
  // that named its own slug.
  const stmtRe = /`[^`]*FROM posts p\s*JOIN post_translations[^`]*`/g;
  const slugStmts = [];
  for (const f of blanked) {
    for (const m of f.src.matchAll(stmtRe)) {
      const stmt = m[0];
      if (/(?:AND|WHERE)\s+p\.slug\s*=/i.test(stmt) && !stmt.includes("COALESCE")) {
        slugStmts.push(`${f.path}: ${stmt.slice(0, 60)}…`);
      }
    }
  }
  checkEmpty("every posts⋈translations slug filter is COALESCE'd (rule 58)", slugStmts);
  // Non-vacuity: the scan must be seeing the real join sites (there are at
  // least four on disk: findContent, the front router's single lookup, the
  // theme query, and the Worker theme's API). If this drops, the statement
  // regex has stopped matching and rule 58 is unguarded.
  const joinCount = blanked.reduce((n, f) => n + [...f.src.matchAll(stmtRe)].length, 0);
  check(
    "rule 58 scan actually saw the join sites (non-vacuity)",
    joinCount >= 3,
    `found ${joinCount} posts⋈translations statements`
  );

  // -- Rule 59: SEO endpoints are site-scoped -------------------------------
  // sitemap/robots/feed each take siteId and use it. A function that "forgot"
  // the parameter compiles fine and serves the default site on every host —
  // exactly the bug the SEO endpoints already had once.
  const seoSrc = blankComments(read(join(ROOT, "src/platform/seo.ts")));
  const exports = [...seoSrc.matchAll(/export\s+(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g)];
  const siteBlind = exports
    .filter(([, , params]) => !/\bsiteId\b/.test(params))
    .map(([, name]) => name);
  checkEmpty("every exported seo.ts function takes siteId (rule 59)", siteBlind);
  check(
    "rule 59 scan actually saw the SEO exports (non-vacuity)",
    exports.length >= 3,
    `found ${exports.length} exported functions`
  );
}

// ---------------------------------------------------------------------------
section("The editor palette comes from the renderer (one definition)");
// ---------------------------------------------------------------------------

// The insertable block set lives in `CORE_BLOCKS` (rendering/blocks.ts) and
// reaches the editor through `GET /api/v1/blocks`. A block-name literal in the
// SPA is a second list guaranteed to drift — the hand-written palette had
// already dropped gallery, button and columns while the renderer kept
// supporting them, and nothing failed because both sides were green.
{
  const blockNameRe = /["'`]core\/(?:paragraph|heading|list|quote|code|image|gallery|button|separator|html|group|columns)["'`]/;
  const spaFiles = walk(join(ROOT, "public", "admin"), [".js"]);
  const offenders = spaFiles
    .filter((f) => blockNameRe.test(blankComments(read(f))))
    .map((f) => relative(ROOT, f).split(sep).join("/"));
  checkEmpty("the admin SPA carries no block-name literals (palette comes from CORE_BLOCKS)", offenders);
  check(
    "palette scan actually saw the SPA (non-vacuity)",
    spaFiles.length >= 15,
    `scanned ${spaFiles.length} js files`
  );
  check(
    "the renderer's CORE_BLOCKS is the source being scanned for (non-vacuity)",
    Array.isArray(CORE_BLOCKS) && CORE_BLOCKS.length >= 12 && CORE_BLOCKS.every((b) => blockNameRe.test(`"${b.name}"`)),
    `CORE_BLOCKS has ${Array.isArray(CORE_BLOCKS) ? CORE_BLOCKS.length : 0} entries`
  );
}

// ---------------------------------------------------------------------------
section("Dashboard stat cards arrive as data (one definition)");
// ---------------------------------------------------------------------------

// The dashboard's stat cards are produced by the API — labels from the UI
// dictionary, values from site-scoped counts, extendable by plugins through
// the `dashboardCards` filter. A `stat("Posts", …)` literal in the screen is
// a client-side copy that will not translate and will not see plugin cards.
{
  const dash = join(ROOT, "public", "admin", "js", "screens", "dashboard.js");
  const statLiteralRe = /stat\(\s*["'](Posts|Pages|Media|Drafts)["']/;
  const hasLiteral = statLiteralRe.test(blankComments(read(dash)));
  checkEmpty("the dashboard screen carries no hard-coded stat cards", hasLiteral ? ["dashboard.js stat(\"Posts|Pages|Media|Drafts\")"] : []);
  // Non-vacuity: the scan must be looking at the screen that renders cards.
  check(
    "dashboard scan actually saw the cards renderer (non-vacuity)",
    /d\.cards/.test(blankComments(read(dash)))
  );
}

// ---------------------------------------------------------------------------
section("The declarative settings form covers every declared field type");
// ---------------------------------------------------------------------------

// `settings[]` entries may declare any of `ALLOWED_FIELD_TYPES` — the same
// closed set the manifest validator enforces. The one auto-form that renders
// them (theme-menu.js, for themes AND plugins) must have a branch per type:
// a type without a branch silently degrades to a text input, which is how a
// declared select loses its choices and a declared boolean becomes free text.
{
  const form = blankComments(read(join(ROOT, "public", "admin", "js", "screens", "theme-menu.js")));
  const missing = ALLOWED_FIELD_TYPES.filter((t) => !form.includes(`case "${t}"`));
  checkEmpty("every allowed field type has a rendering branch in the settings form", missing);
  check(
    "settings-form scan actually saw the type switch (non-vacuity)",
    (form.match(/case "/g) ?? []).length >= ALLOWED_FIELD_TYPES.length,
    `found ${(form.match(/case "/g) ?? []).length} case labels`
  );
}

// ---------------------------------------------------------------------------
section("The media read path resolves the site before it reads the object (rule 60)");
// ---------------------------------------------------------------------------

/**
 * `/media/<key>` used to be matched near the top of the router — above site
 * resolution and above authentication — and served straight out of R2. The
 * object key embeds its tenant (`uploads/{siteId}/…`), so that made a key
 * minted for one site readable on another site's host, and readable by an
 * anonymous visitor. `media_files` was already per-site; only this door was
 * site-blind, and because the admin list was already scoped the hole survived
 * every existing assertion.
 *
 * Two things are checked, and they fail independently:
 *
 *   1. **Order.** The branch has to sit after the `resolveSite` call, because
 *      only then is there a site to judge the key against. Moving it back up
 *      is a one-line edit that keeps every behaviour test green for as long as
 *      every site happens to be the default one.
 *   2. **It goes through the policy module.** A read path that reaches R2
 *      directly is the original defect wearing a different line number.
 */
{
  const index = blankComments(read(join(ROOT, "src", "index.ts")));
  // Anchored on `startsWith("/media/")`, not on the bare path literal: the
  // `media()` helper itself mentions `"/media/"` when slicing the prefix off,
  // and that mention sits *above* the router — so the looser anchor reported
  // the function definition as "the branch" and the guard was red on a correct
  // tree. It also has to match the shape a moved-back branch takes
  // (`u.pathname.startsWith(...)`), or moving it would go unnoticed.
  const mediaAt = index.indexOf('startsWith("/media/")');
  const resolveAt = index.indexOf("await resolveSite(");
  // Non-vacuity first: `-1 > -1` is false, so a renamed anchor would turn the
  // order assertion red for the wrong reason; state both anchors' presence.
  check(
    "the media branch and the site-resolution call are both present (non-vacuity)",
    mediaAt > -1 && resolveAt > -1,
    `"/media/" at ${mediaAt}, "await resolveSite(" at ${resolveAt}`
  );
  check(
    "the /media/ branch is matched after the site is resolved",
    mediaAt > resolveAt,
    `"/media/" at ${mediaAt} must come after "await resolveSite(" at ${resolveAt}`
  );
  checkEmpty(
    "the /media/ read path decides through platform/media-policy, not straight out of R2",
    index.includes("mediaReadDecision") ? [] : ["src/index.ts never calls mediaReadDecision"]
  );
}

// ---------------------------------------------------------------------------
section("This suite's own assertions can actually fail (meta-guard)");
// ---------------------------------------------------------------------------

/**
 * The eighth false-green was not in the code under test — it was in **this
 * file's own assertion spelling**. `check("…", offenders, [])` reads as "assert
 * no offenders" and asserts nothing, because `check` tests truthiness and an
 * empty array is truthy. Any such call is a guard that can never fail, and it
 * is invisible: the output says `ok` either way.
 *
 * So the spelling is banned lexically. This is deliberately a *text* check
 * rather than a structural one: the defect is a spelling, and the thing being
 * guarded is a spelling, which is the one case in this repo where text is the
 * right tool (see AGENTS.md on `theme_admin_menus`).
 *
 * It must not match its own source, so the pattern is assembled from parts and
 * the scan runs on the file with comments blanked (the explanatory comment
 * above contains the forbidden form as an example).
 */
{
  const selfSrc = blankComments(read(join(ROOT, "tests/suites/architecture.test.mjs")));
  const open = "check\\(";
  const arg = "\\s*\"[^\"]*\"\\s*,\\s*([A-Za-z_$][A-Za-z0-9_$]*)\\s*,\\s*\\[\\]\\s*\\)";
  const banned = new RegExp(open + arg, "g");
  const offenders = [...selfSrc.matchAll(banned)].map((m) => m[1]);

  checkEmpty("no assertion passes a collection as its truthiness condition", offenders);

  // And prove the scan is looking at something: the file must contain the
  // helper and enough `check*` calls that a zero-result scan is meaningful.
  const checkCalls = (selfSrc.match(/\bcheck(?:Empty)?\(/g) ?? []).length;
  check(
    "the meta-guard actually scanned this suite's assertions (non-vacuity)",
    checkCalls > 20,
    `found ${checkCalls} check/checkEmpty calls`
  );
}

// ---------------------------------------------------------------------------
section("The schema declaration covers the real database (§10 rules 41–44)");
// ---------------------------------------------------------------------------

/**
 * `tests/tools/_schema-scope.mjs` builds a throwaway SQLite from the migration
 * stream and checks every real table against `contract/schema.ts`. That is the
 * strong version of this check, but it needs `node:sqlite` and a temp dir, so
 * it is its own suite.
 *
 * What this section adds is the *cheap* structural half, runnable with zero
 * setup: the declaration must partition cleanly (no table both tenant-scoped
 * and platform-global), the derived lists must agree with the entries they are
 * derived from, and the runtime list must not overlap the platform schema.
 * A partition that overlaps is a table with two contradictory answers, which
 * is worse than no answer — a reader will believe whichever they read first.
 */
{
  const schemaSrc = read(join(ROOT, "src/extensions/contract/schema.ts"));

  const entryBlock = schemaSrc.match(/export const PLATFORM_SCHEMA\s*=\s*\[([\s\S]*?)\]\s*as const/);
  const entryLines = entryBlock ? entryBlock[1].split("\n").filter((l) => l.includes("{ table:")) : [];

  // Parse each entry line for `table:` and `tenant:` without importing — same
  // rationale as above (this suite stays dependency-free). A line-by-line read
  // is enough because the declaration is deliberately one table per line; that
  // convention is itself asserted by the "one entry per line" count below.
  const declaredTables = entryLines.map((l) => l.match(/table:\s*"([^"]+)"/)?.[1]).filter(Boolean);
  const declaredTenants = entryLines.map((l) => l.match(/tenant:\s*"([^"]+)"/)?.[1]).filter(Boolean);

  check(
    "the schema declaration was actually parsed (non-vacuity)",
    declaredTables.length > 0,
    `${declaredTables.length} declared entries`
  );
  check(
    "every entry states a tenant scope",
    declaredTables.length === declaredTenants.length,
    `${declaredTables.length} tables vs ${declaredTenants.length} tenant values`
  );
  checkEmpty(
    "the tenant scope is only ever site or platform",
    [...new Set(declaredTenants)].filter((t) => t !== "site" && t !== "platform")
  );

  const dupTables = declaredTables.filter((t, i) => declaredTables.indexOf(t) !== i);
  checkEmpty(
    "no table is declared twice (two answers is worse than none)",
    dupTables
  );

  // The derived exports must be derived. If someone hand-writes `TENANT_TABLES`
  // it will drift from `PLATFORM_SCHEMA` on the next edit, and the collection
  // script will agree with whichever it happens to read.
  for (const [name, filter] of [
    ["TENANT_TABLES", '"site"'],
    ["PLATFORM_TABLES", '"platform"'],
  ]) {
    const derivedFrom = new RegExp(
      `export const ${name}\\s*=\\s*PLATFORM_SCHEMA[\\s\\S]{0,120}?tenant\\s*===\\s*${filter}`
    ).test(schemaSrc);
    check(`${name} is derived from PLATFORM_SCHEMA, not hand-written`, derivedFrom);
  }

  // RUNTIME_TABLES describes tables the runtime owns; one of them also being a
  // declared platform table would make `scopeOf()` ambiguous.
  const runtimeBlock = schemaSrc.match(/export const RUNTIME_TABLES\s*=\s*\[([\s\S]*?)\]\s*as const/);
  const runtimeNames = runtimeBlock ? [...runtimeBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
  check(
    "the runtime table list was parsed (non-vacuity)",
    runtimeNames.length > 0,
    `${runtimeNames.length} entries`
  );
  checkEmpty(
    "no runtime-owned table is also a declared platform table",
    runtimeNames.filter((t) => declaredTables.includes(t))
  );
}

// ---------------------------------------------------------------------------
section("Docs do not reference test suites that no longer exist");
// ---------------------------------------------------------------------------

/**
 * Documentation is executable here: AGENTS.md tells a contributor which suite
 * to run after which change, and `package.json` / the launchers are checked
 * against disk by `tests/suites/launcher-parity.test.mjs`. A doc that names a deleted
 * suite is not a cosmetic wart — it is an instruction that fails when followed,
 * and the failure looks like "the suite is broken", not "the doc is stale".
 *
 * Batch 10 deleted two theme suites and left eight references behind. They were
 * found by hand, which is the exact failure mode this repo keeps re-learning:
 * a convention nobody enforces is a convention that expires.
 *
 * Scope: only test paths written **inside a fenced code block**, and only the
 * `tests/` tree. Prose is deliberately exempt — the history section legitimately
 * quotes retired names ("`theme-aurora` was deleted in batch 10"), and a guard
 * that forbids mentioning a deleted file would forbid explaining *why* it was
 * deleted. A fenced block is the unambiguous "run this" position; prose is not.
 *
 * ⚠️ The pattern must accept the `tests/<group>/` layout: a character class that
 * stops at `/` silently matched **nothing** once the suites moved into
 * `tests/suites/`, so the existence half passed by finding zero offenders. The
 * non-vacuity counter below is what caught it — keep that counter.
 */
{
  const DOCS = [
    "AGENTS.md",
    "README.md",
    ...walk(join(ROOT, "docs"), [".md"]).map((f) => rel(f)),
  ];
  const missing = [];
  let refsScan = 0;

  for (const doc of DOCS) {
    const src = read(join(ROOT, doc));
    // Split on fences; odd-indexed chunks are the inside of a code block.
    const chunks = src.split(/^[ \t]*(?:```|~~~)[^\n]*$/m);
    const fenced = chunks.filter((_, i) => i % 2 === 1).join("\n");
    for (const m of fenced.matchAll(/\btests\/[A-Za-z0-9_./-]+\.(?:mjs|cjs)\b/g)) {
      refsScan++;
      if (!existsSync(join(ROOT, m[0]))) missing.push(`${doc}: ${m[0]}`);
    }
  }

  checkEmpty(
    "every test path named in a doc code block exists on disk",
    [...new Set(missing)]
  );
  // Non-vacuity: a rename of the docs directory would silently empty the scan
  // and the assertion above would pass by finding nothing to complain about.
  check(
    "the doc scan actually read the code blocks (non-vacuity)",
    refsScan > 5,
    `${refsScan} fenced test-path references across ${DOCS.length} docs`
  );

  // -------------------------------------------------------------------------
  // Second half: *executable commands* outside code blocks.
  // -------------------------------------------------------------------------
  //
  // The fenced-block rule above deliberately exempts prose, so that the history
  // section can quote a retired suite name while explaining why it was retired.
  // But a line of prose that says `node tests/_foo-inject.mjs` is not history —
  // it is a copy-pasteable command, and if that file was deleted the reader gets
  // `MODULE_NOT_FOUND` and blames the tooling. That is exactly how
  // `tests/_eshop-inject.mjs` survived batch 10: it was deleted, and two prose
  // lines in AGENTS.md kept telling contributors to run it.
  //
  // A bare `node <path>` is the unambiguous "run this" form in prose, so it can
  // be checked without the false positives a name-mention rule would cause.
  const runMissing = [];
  let runScan = 0;
  for (const doc of DOCS) {
    const src = read(join(ROOT, doc));
    for (const m of src.matchAll(/\bnode\s+(?:--[a-z-]+\s+)*((?:tests|scripts)\/[A-Za-z0-9_./-]+\.(?:mjs|cjs))/g)) {
      runScan++;
      if (!existsSync(join(ROOT, m[1]))) runMissing.push(`${doc}: node ${m[1]}`);
    }
  }
  checkEmpty(
    "every `node <path>` command written in a doc points at a file that exists",
    [...new Set(runMissing)]
  );
  check(
    "the runnable-command scan actually found commands (non-vacuity)",
    runScan > 5,
    `${runScan} node commands across ${DOCS.length} docs`
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
//
// ⚠️ This suite is the one that *documents* the sixth false-green ("no summary
// line means the run did not finish, which is not the same as success") and it
// violated that rule itself: the summary sat at the bottom of the file, so any
// throw from a guard above it produced an empty output and a non-zero exit —
// legible in CI, but exactly the shape a script grepping for `N passed, M
// failed` reads as "no failures". The post-restore check in
// `tests/tools/_skeleton-inject.mjs` walked straight into it.
//
// The fix is the one the rule prescribes: one `finish()` that always prints,
// wired to the uncaught-exception path so a crash reports as `(aborted)` and
// still carries a failure count.
let finished = false;
function finish(tag = "", extraFailures = 0) {
  if (finished) return;
  finished = true;
  const total = failed + extraFailures;
  console.log(`\n${"=".repeat(64)}`);
  console.log(`${passed} passed, ${total} failed${tag}`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f.name}`);
    console.log(
      "\nThese are architecture rules, not style preferences. See docs/ARCHITECTURE.md §5 and §10."
    );
  }
  // No second summary line. This suite used to also print
  // `${total ? "1" : "0"} failure(s)` — a different spelling of the same fact,
  // which is how a grep-based checker reads the wrong line and misses a failure
  // (AGENTS.md "false green" type 6). The `${pass} passed, ${fail} failed` line
  // printed above is the only summary.
  process.exit(total ? 1 : 0);
}
process.on("uncaughtException", (e) => {
  console.error("\nSUITE ERROR:", (e && e.stack) || e);
  finish(" (aborted)", 1);
});
process.on("unhandledRejection", (e) => {
  console.error("\nSUITE ERROR (unhandled rejection):", (e && e.stack) || e);
  finish(" (aborted)", 1);
});

finish();
