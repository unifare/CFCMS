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
 * Usage: node tests/architecture.test.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, isAbsolute, sep } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

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
  ["themes/", ["themes"]],
  ["plugins/", ["plugins"]],
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
  // Strip comments first: prose explaining *why* a default was removed would
  // otherwise match its own example.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
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

// ---------------------------------------------------------------------------
section("i18n key namespacing (§10 rule 7)");
// ---------------------------------------------------------------------------

/**
 * Rule 7: every key in an extension's language pack must carry its owner's
 * prefix — `theme.{name}.` or `plugin.{name}.`.
 *
 * Without this, two extensions that both define `nav.home` overwrite each
 * other in the merged dictionary, and which one wins depends on load order.
 * That is a heisenbug with no correct fix at the call site.
 */
function checkLangPacks(kind) {
  const baseDir = join(ROOT, kind === "theme" ? "themes" : "plugins");
  if (!existsSync(baseDir)) return [];
  const problems = [];
  for (const owner of readdirSync(baseDir)) {
    const langDir = join(baseDir, owner, "langs");
    if (!existsSync(langDir) || !statSync(langDir).isDirectory()) continue;
    for (const file of readdirSync(langDir)) {
      if (!file.endsWith(".json")) continue;
      let dict;
      try {
        dict = JSON.parse(read(join(langDir, file)));
      } catch (e) {
        problems.push(`${kind}s/${owner}/langs/${file}: invalid JSON (${e.message})`);
        continue;
      }
      const prefix = `${kind}.${owner}.`;
      for (const key of Object.keys(dict)) {
        const isCore = key.startsWith("core.");
        if (!key.startsWith(prefix) && !isCore) {
          problems.push(`${kind}s/${owner}/langs/${file}: key "${key}" lacks prefix "${prefix}"`);
        }
      }
    }
  }
  return problems;
}

for (const kind of ["theme", "plugin"]) {
  const problems = checkLangPacks(kind);
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
 */
const themeDirs = existsSync(join(ROOT, "themes"))
  ? readdirSync(join(ROOT, "themes")).filter((d) =>
      statSync(join(ROOT, "themes", d)).isDirectory()
    )
  : [];

const manifestProblems = [];
for (const name of themeDirs) {
  const dir = join(ROOT, "themes", name);
  const manifestPath = join(dir, "theme.json");
  if (!existsSync(manifestPath)) continue; // optional for fixtures

  let manifest;
  try {
    manifest = JSON.parse(read(manifestPath));
  } catch (e) {
    manifestProblems.push(`themes/${name}/theme.json: invalid JSON (${e.message})`);
    continue;
  }

  const templates = Array.isArray(manifest.templates) ? manifest.templates : [];
  const tableNames = new Set(
    (Array.isArray(manifest.tables) ? manifest.tables : []).map((t) => String(t?.name ?? ""))
  );

  // Declared template must exist, either flat or under templates/parts.
  //
  // A worker-runtime theme renders from its own code, so `templates[]` there is
  // a statement about *which kinds it handles*, not a file listing. Only a
  // declarative theme's template list is a file contract — checking a worker
  // theme against the filesystem would report failures it can never fix.
  const tplDir = join(dir, "templates");
  const isWorkerTheme = manifest.runtime === "worker";
  if (templates.length && existsSync(tplDir) && !isWorkerTheme) {
    const present = new Set();
    for (const f of walk(tplDir, [".html"])) {
      const base = f.slice(f.indexOf(`${sep}templates${sep}`) + `${sep}templates${sep}`.length);
      present.add(base.split(sep).join("/").replace(/\.html$/, ""));
    }
    for (const t of templates) {
      if (!present.has(t)) {
        manifestProblems.push(`themes/${name}: declares template "${t}" but ships no templates/${t}.html`);
      }
    }
  }

  // A route resolving against a table must declare that table.
  for (const r of Array.isArray(manifest.routes) ? manifest.routes : []) {
    const tbl = r?.resolve?.table;
    if (tbl && !tableNames.has(String(tbl))) {
      manifestProblems.push(
        `themes/${name}: route "${r.path}" resolves table "${tbl}" which is not declared in tables[]`
      );
    }
  }

  // A route's template must be declared. Same worker exemption as above: a
  // worker theme's route templates are names its code understands.
  if (!isWorkerTheme) {
    for (const r of Array.isArray(manifest.routes) ? manifest.routes : []) {
      if (r?.template && templates.length && !templates.includes(r.template)) {
        manifestProblems.push(
          `themes/${name}: route "${r.path}" uses template "${r.template}" not listed in templates[]`
        );
      }
    }
  }

  // translatable entries must name declared fields.
  for (const t of Array.isArray(manifest.tables) ? manifest.tables : []) {
    const fieldKeys = new Set(
      (Array.isArray(t?.fields) ? t.fields : []).map((f) => String(f?.key ?? ""))
    );
    for (const k of Array.isArray(t?.translatable) ? t.translatable : []) {
      if (!fieldKeys.has(String(k))) {
        manifestProblems.push(
          `themes/${name}: table "${t.name}" marks "${k}" translatable but has no such field`
        );
      }
    }
  }

  // Tables must not use reserved platform column names.
  const RESERVED = ["id", "site_id", "slug", "lang_group", "status", "created_at", "updated_at"];
  for (const t of Array.isArray(manifest.tables) ? manifest.tables : []) {
    for (const f of Array.isArray(t?.fields) ? t.fields : []) {
      if (RESERVED.includes(String(f?.key ?? ""))) {
        manifestProblems.push(
          `themes/${name}: table "${t.name}" field "${f.key}" collides with a reserved column`
        );
      }
    }
  }
}

check(
  "theme manifests are internally consistent",
  manifestProblems.length === 0,
  manifestProblems.join("\n       ")
);

// ---------------------------------------------------------------------------
section("Extension entry points exist");
// ---------------------------------------------------------------------------

/**
 * A manifest that points at a missing file fails at activation, in production,
 * with the site already switched over. Checking the file exists is cheap and
 * turns that into a caught mistake.
 */
const entryProblems = [];
for (const name of themeDirs) {
  const manifestPath = join(ROOT, "themes", name, "theme.json");
  if (!existsSync(manifestPath)) continue;
  let manifest;
  try {
    manifest = JSON.parse(read(manifestPath));
  } catch {
    continue; // already reported above
  }
  if (manifest.runtime === "worker") {
    const entry = String(manifest.entry ?? "worker.js");
    if (!existsSync(join(ROOT, "themes", name, entry))) {
      entryProblems.push(`themes/${name}: runtime=worker but ${entry} is missing`);
    }
  }
}

const pluginDirs = existsSync(join(ROOT, "plugins"))
  ? readdirSync(join(ROOT, "plugins")).filter((d) =>
      statSync(join(ROOT, "plugins", d)).isDirectory()
    )
  : [];
for (const name of pluginDirs) {
  const manifestPath = join(ROOT, "plugins", name, "plugin.json");
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
console.log(`\n${"=".repeat(64)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f.name}`);
  console.log(
    "\nThese are architecture rules, not style preferences. See docs/ARCHITECTURE.md §5 and §10."
  );
}
console.log(`${failed ? "1" : "0"} failure(s)`);
process.exit(failed ? 1 : 0);
