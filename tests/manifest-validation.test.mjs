/**
 * Manifest validation contract test — defence line 2 from docs/ARCHITECTURE.md §5.3.
 *
 * ## Why this suite exists
 *
 * `validateManifest` is the only thing standing between a third-party extension
 * zip and the database. The architecture test guards *the themes that ship in
 * this repo*; it cannot guard what a user uploads. So the validation logic needs
 * its own tests, and they need to assert **rejection**, not just acceptance.
 *
 * The rule the doc states is absolute:
 *
 *   "校验失败必须让安装失败，不能警告后继续。一个装不上的主题胜过半个能跑的主题。"
 *   (A theme that refuses to install beats a theme that half-works.)
 *
 * So every case below injects exactly one defect into an otherwise valid
 * manifest and asserts that validation throws. A validator that accepts a bad
 * manifest is worse than no validator, because the install then proceeds and
 * the failure surfaces much later, pointing at the wrong file.
 *
 * Usage: node tests/manifest-validation.test.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const require = createRequire(pathToFileURL(join(root, "package.json")));

let pass = 0,
  fail = 0;
const failures = [];

function ok(name) {
  pass++;
  console.log(`  ok   ${name}`);
}
function bad(name, detail) {
  fail++;
  failures.push(name);
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
}

/** Bundle the real source so the test drives shipped code, not a copy. */
async function loadSecurity() {
  const esbuild = require("esbuild");
  const out = await esbuild.build({
    entryPoints: [join(root, "src/extensions/contract/validation.ts")],
    bundle: true,
    format: "esm",
    target: "es2022",
    write: false,
    platform: "neutral",
    logLevel: "silent",
  });
  const dir = join(root, ".wrangler");
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, "security-bundle.mjs");
  writeFileSync(tmp, out.outputFiles[0].text);
  return import(pathToFileURL(tmp).href + "?t=" + Date.now());
}

/** A minimal manifest that passes. Every rejection case mutates a copy of it. */
function validTheme(overrides = {}) {
  return {
    name: "demo",
    title: "Demo",
    version: "1.0.0",
    runtime: "declarative",
    templates: ["index", "single"],
    ...overrides,
  };
}

/**
 * Assert that `manifest` is rejected, and (importantly) report what happened.
 *
 * A rejection must be a thrown Error. Returning `{ok:false}` or logging would
 * let the caller continue, which is precisely what the doc forbids.
 */
function rejects(v, manifest, label, type = "theme") {
  let threw = false;
  let message = "";
  try {
    v.validateManifest(manifest, type);
  } catch (e) {
    threw = true;
    message = String(e?.message || e);
  }
  if (threw) ok(`${label}  →  rejected: "${message}"`);
  else bad(label, "validator ACCEPTED an invalid manifest (should have thrown)");
}

function accepts(v, manifest, label, type = "theme") {
  try {
    v.validateManifest(manifest, type);
    ok(label);
  } catch (e) {
    bad(label, `validator REJECTED a valid manifest: ${e?.message || e}`);
  }
}

const v = await loadSecurity();

// ---------------------------------------------------------------------------
console.log("1. Baseline: a valid manifest is accepted");
// ---------------------------------------------------------------------------
accepts(v, validTheme(), "minimal declarative theme");
accepts(
  v,
  validTheme({
    tables: [
      {
        name: "product",
        fields: [
          { key: "name", type: "text" },
          { key: "price", type: "number" },
          { key: "note", type: "longtext" },
          { key: "active", type: "boolean" },
        ],
        translatable: ["name", "note"],
      },
    ],
    locales: ["en", "zh-CN"],
    adminMenus: [{ id: "products", screen: "content-list", args: { type: "product" } }],
  }),
  "theme with tables + locales + adminMenus"
);
accepts(v, { name: "seo", version: "0.1.0", permissions: ["content.read"] }, "minimal plugin", "plugin");

// ---------------------------------------------------------------------------
console.log("\n2. Rejected: bad table / field declarations  (§5.3)");
// ---------------------------------------------------------------------------
rejects(
  v,
  validTheme({ tables: [{ name: "Bad-Name", fields: [{ key: "a", type: "text" }] }] }),
  "table name with capitals and a dash"
);
rejects(
  v,
  validTheme({ tables: [{ name: "product", fields: [{ key: "site_id", type: "text" }] }] }),
  "field collides with reserved column `site_id`  ← would break multi-site isolation"
);
rejects(
  v,
  validTheme({ tables: [{ name: "product", fields: [{ key: "slug", type: "text" }] }] }),
  "field collides with reserved column `slug`"
);
rejects(
  v,
  validTheme({
    tables: [
      {
        name: "product",
        fields: [
          { key: "name", type: "text" },
          { key: "name", type: "number" },
        ],
      },
    ],
  }),
  "duplicate field key within one table"
);
rejects(
  v,
  validTheme({ tables: [{ name: "product", fields: [{ key: "sku", type: "reference" }] }] }),
  "unsupported field type `reference`  ← §9 decision 2: basic types only"
);
rejects(
  v,
  validTheme({
    tables: [{ name: "product", fields: [{ key: "name", type: "text" }], translatable: ["title"] }],
  }),
  "translatable names a field that does not exist"
);
// Multi-language capability is mandatory, in both directions (§10 rule 41).
// These two pin the *rejection* side: a rule only ever demonstrated by
// conforming examples is a rule nobody has seen work.
rejects(
  v,
  validTheme({
    tables: [{ name: "product", fields: [{ key: "name", type: "text" }] }],
  }),
  "prose field missing from translatable  ← every readable value carries a language"
);
rejects(
  v,
  validTheme({
    tables: [{
      name: "product",
      fields: [{ key: "name", type: "text" }, { key: "price", type: "number" }],
      translatable: ["name", "price"],
    }],
  }),
  "language-neutral field wrongly declared translatable  ← numbers are formatted, not translated"
);
rejects(
  v,
  validTheme({
    tables: [
      { name: "product", fields: [{ key: "a", type: "text" }], translatable: ["a"] },
      { name: "product", fields: [{ key: "b", type: "text" }], translatable: ["b"] },
    ],
  }),
  "duplicate table name"
);

// ---------------------------------------------------------------------------
console.log("\n3. Rejected: route / menu consistency  (§5.3)");
// ---------------------------------------------------------------------------
rejects(
  v,
  validTheme({ routes: [{ path: "/p/:slug", template: "single", resolve: { table: "ghost" } }] }),
  "route resolves an undeclared table"
);
rejects(
  v,
  validTheme({ routes: [{ path: "p/:slug", template: "single" }] }),
  "route path does not start with /"
);
rejects(
  v,
  validTheme({
    routes: [
      { path: "/p/:slug", template: "single" },
      { path: "/p/:slug", template: "single" },
    ],
  }),
  "duplicate route path"
);

// -- a route's `resolve` / `template` / `query.as` must mean something -------
//
// These three were validated more loosely than they were used: `resolve.table`
// was checked at install and never read, `routes[].template` was checked
// against `templates[]` by the architecture test and never selected a template,
// and the query result was bound to a hard-coded `posts` no matter what the
// route said. Every one of those produced the same symptom — a page that
// renders, returns 200, and shows the wrong content — so each hole gets a case
// here, and each has a live assertion in `theme-integration.test.mjs`.
rejects(
  v,
  validTheme({ routes: [{ path: "/p", template: "../escape" }] }),
  "route template name can leave the theme package"
);
rejects(
  v,
  validTheme({ routes: [{ path: "/p", template: "single", resolve: {} }] }),
  "resolve declares neither type nor table  ← the router would read nothing"
);
rejects(
  v,
  validTheme({
    tables: [{ name: "product", fields: [{ key: "name", type: "text" }] }],
    routes: [{ path: "/p", template: "single", resolve: { type: "product", table: "product" } }],
  }),
  "resolve declares both type and table  ← only one can decide what the route reads"
);
rejects(
  v,
  validTheme({ routes: [{ path: "/p", template: "single", resolve: { type: "Not An Identifier" } }] }),
  "resolve.type is not an identifier"
);
rejects(
  v,
  validTheme({ routes: [{ path: "/p/:slug", template: "single", resolve: { type: "post", by: "ID" } }] }),
  "resolve.by has a silent fallback to slug"
);
rejects(
  v,
  validTheme({ routes: [{ path: "/p", template: "single", query: { type: "post", as: "my-list" } }] }),
  "query.as is not a name the expression parser can tokenise"
);
rejects(
  v,
  validTheme({ routes: [{ path: "/p", template: "single", query: ["type"] }] }),
  "query is an array, not an object"
);
accepts(
  v,
  validTheme({ routes: [{ path: "/p", template: "single", query: { type: "post", as: "properties" } }] }),
  "query.as naming a real scope variable"
);
accepts(
  v,
  validTheme({
    tables: [{ name: "product", fields: [{ key: "name", type: "text" }], translatable: ["name"] }],
    routes: [{ path: "/p/:slug", template: "single", resolve: { table: "product", by: "slug" } }],
  }),
  "route resolving a declared table by slug"
);
rejects(
  v,
  validTheme({ adminMenus: [{ id: "x", screen: "not-a-screen" }] }),
  "unsupported admin screen"
);
rejects(
  v,
  validTheme({ adminMenus: [{ id: "x", screen: "content-list", capability: "make.coffee" }] }),
  "admin menu declares an unknown capability"
);
rejects(
  v,
  validTheme({ adminMenus: [{ id: "x", screen: "content-list", args: "nope" }] }),
  "admin menu args is not an object"
);

// -- batch 3: the generated-table screens and per-screen args schema --------
//
// `table-list` / `table-edit` are the two screens that let a theme show its own
// table without writing admin code. A menu that names no table, or names one
// the manifest never declared, renders an empty page in production — the
// manifest is the only place that mistake is cheap to catch.
rejects(
  v,
  validTheme({
    tables: [{ name: "product", fields: [{ key: "name", type: "text" }] }],
    adminMenus: [{ id: "products", screen: "table-list" }],
  }),
  "table-list menu without args.table"
);
rejects(
  v,
  validTheme({ adminMenus: [{ id: "products", screen: "table-list", args: { table: "product" } }] }),
  "table-list menu naming a table that is not declared"
);
rejects(
  v,
  validTheme({ adminMenus: [{ id: "products", screen: "table-edit", args: { table: "product" } }] }),
  "table-edit menu naming a table that is not declared"
);
rejects(
  v,
  validTheme({
    adminMenus: [
      { id: "same", screen: "content-list", args: { type: "posts" } },
      { id: "same", screen: "theme-settings" },
    ],
  }),
  "duplicate admin menu id  ← both rows would claim the same page key"
);
rejects(
  v,
  validTheme({ adminMenus: [{ id: "shop/settings", screen: "theme-settings" }] }),
  "admin menu id is not an identifier  ← it becomes the SPA page key"
);
rejects(
  v,
  validTheme({ adminMenus: [{ id: "orders", screen: "custom" }] }),
  "custom screen without args.view"
);
rejects(
  v,
  validTheme({ adminMenus: [{ id: "orders", screen: "custom", args: { view: "../../etc/passwd" } }] }),
  "custom screen whose view escapes the package"
);

// ---------------------------------------------------------------------------
console.log("\n4. Rejected: locales / settings / runtime  (§5.3)");
// ---------------------------------------------------------------------------
rejects(v, validTheme({ locales: ["english"] }), "locale code is not BCP-47 shaped");
rejects(v, validTheme({ locales: ["en_US"] }), "locale code uses an underscore");
rejects(
  v,
  validTheme({ settings: [{ key: "Shop Currency", type: "text" }] }),
  "setting key is not dotted-identifier shaped"
);
rejects(
  v,
  validTheme({ settings: [{ key: "shop.currency", type: "text", options: "usd" }] }),
  "setting options is not an array"
);
rejects(
  v,
  validTheme({ settings: [{ key: "shop.currency", type: "text", default: { a: 1 } }] }),
  "setting default is not a scalar"
);
rejects(v, validTheme({ runtime: "wasm" }), "unsupported runtime");
rejects(
  v,
  validTheme({ runtime: "worker" }),
  'runtime "worker" without an entry file'
);

// ---------------------------------------------------------------------------
console.log("\n5. Plugin-specific rules");
// ---------------------------------------------------------------------------
rejects(v, { name: "seo", version: "0.1.0", permissions: "content.read" }, "permissions is not an array", "plugin");
rejects(
  v,
  { name: "seo", version: "0.1.0", permissions: ["teleport"] },
  "unknown capability in permissions",
  "plugin"
);
rejects(v, { name: "Bad Name", version: "0.1.0" }, "extension name has a space", "plugin");
rejects(v, { name: "seo", version: "1.0" }, "version is not semver", "plugin");
rejects(v, "not an object", "manifest is not an object", "plugin");

// A plugin's `adminMenus` used to be accepted and never read — installed, no
// menu, nothing to explain the gap. It is validated now, and the two rules that
// genuinely differ from a theme's are pinned here.
rejects(
  v,
  { name: "seo", version: "0.1.0", adminMenus: [{ id: "x", screen: "not-a-screen" }] },
  "plugin admin menu with an unsupported screen",
  "plugin"
);
rejects(
  v,
  { name: "seo", version: "0.1.0", adminMenus: [{ id: "x", screen: "table-list", args: { table: "product" } }] },
  "plugin admin menu using a table screen  ← plugin-owned tables are not materialised",
  "plugin"
);
rejects(
  v,
  { name: "seo", version: "0.1.0", tables: [{ name: "product", fields: [{ key: "name", type: "text" }] }] },
  "plugin declaring tables[]  ← refused, not silently ignored",
  "plugin"
);

// ---------------------------------------------------------------------------
console.log("\n6. Tolerance: optional surface must not over-reject");
// ---------------------------------------------------------------------------
// These guard against a validator that becomes so strict a legitimate theme
// cannot install. Each is a shape real themes rely on.
accepts(
  v,
  validTheme({ templates: ["404", "parts/card", "single-post.v2"] }),
  "numeric / nested / dotted template names are allowed"
);
accepts(v, validTheme({ locales: [] }), "empty locales array");
accepts(v, validTheme({ runtime: "worker", entry: "worker.js" }), "worker runtime with entry");
accepts(
  v,
  validTheme({ tables: [{ name: "thing", fields: [{ key: "a", type: "text" }], translatable: ["a"] }] }),
  "table without an admin screen is allowed"
);
// A prose field must be translatable, so a table carrying one always declares
// `translatable` now. Completion matters too: the two field-type categories
// must partition, so this fixture pairs a prose field with a neutral one and
// marks exactly the prose field.
accepts(
  v,
  validTheme({
    tables: [{
      name: "thing",
      fields: [{ key: "a", type: "text" }, { key: "n", type: "number" }],
      translatable: ["a"],
    }],
  }),
  "language-neutral fields sit alongside prose without being translatable"
);
// The positive side of the batch-3 rules: every new screen must be reachable by
// a manifest that gets it right, or the rules above would just be a wall.
accepts(
  v,
  validTheme({
    tables: [{ name: "product", fields: [{ key: "name", type: "text" }], translatable: ["name"] }],
    adminMenus: [
      { id: "products", screen: "table-list", args: { table: "product" } },
      { id: "product-form", screen: "table-edit", args: { table: "product" } },
      { id: "orders", screen: "custom", args: { view: "admin/orders.html" } },
    ],
  }),
  "theme using table-list / table-edit / custom with correct args"
);
accepts(
  v,
  { name: "seo", version: "0.1.0", permissions: ["settings.read"], adminMenus: [{ id: "seo-settings", screen: "plugin-settings" }] },
  "plugin declaring its own settings menu",
  "plugin"
);
// A one-character table name is *supposed* to be rejected (TABLE_NAME_RE needs
// ≥2 chars). Pinning that here keeps the boundary explicit, so a future
// loosening of the regex has to be a deliberate act rather than an accident.
rejects(
  v,
  validTheme({ tables: [{ name: "t", fields: [{ key: "a", type: "text" }] }] }),
  "one-character table name"
);

// ---------------------------------------------------------------------------
console.log("\n11. Inline language packs (ARCHITECTURE.md §2.4 layers ②/③)");
// ---------------------------------------------------------------------------
// A plugin declares its UI strings in `plugin.json` instead of shipping a
// `langs/` directory, because a plugin package is stored as a zip and never
// unpacked. The namespace rule is the same one the architecture test applies to
// a theme's `langs/*.json` — and it has to be enforced here too, because the
// architecture test can only see the extensions that ship in this repo.
accepts(
  v,
  validTheme({ langs: { en: { "theme.demo.hero": "Hello" }, "zh-CN": { "theme.demo.hero": "你好" } } }),
  "theme with a correctly namespaced inline pack"
);
accepts(
  v,
  validTheme({ langs: { en: { "core.action.save": "Save it" } } }),
  "an inline pack may override a core string"
);
rejects(
  v,
  validTheme({ langs: { en: { "nav.home": "Home" } } }),
  "inline pack key without any namespace"
);
rejects(
  v,
  validTheme({ langs: { en: { "theme.other.hero": "Hello" } } }),
  "inline pack key namespaced to a different extension"
);
rejects(
  v,
  validTheme({ langs: { en: { "theme.demo.hero": 42 } } }),
  "inline pack value that is not a string"
);
rejects(
  v,
  validTheme({ langs: { "not a locale": { "theme.demo.hero": "Hello" } } }),
  "inline pack under a malformed locale code"
);
rejects(v, validTheme({ langs: ["en"] }), "langs declared as an array");

const validPlugin = (overrides = {}) => ({
  name: "seo",
  title: "SEO",
  version: "1.0.0",
  hooks: ["beforeRender"],
  ...overrides,
});
accepts(
  v,
  validPlugin({ langs: { en: { "plugin.seo.meta.title": "Meta title" } } }),
  "plugin with a correctly namespaced inline pack",
  "plugin"
);
rejects(
  v,
  validPlugin({ langs: { en: { "theme.seo.meta.title": "Meta title" } } }),
  "plugin inline pack using the theme prefix",
  "plugin"
);

// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(64)}`);
console.log(`${pass} passed, ${fail} failed`);
if (fail) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  console.log('\nSee docs/ARCHITECTURE.md §5.3 — validation failure must block install.');
}
console.log(`${fail ? "1" : "0"} failure(s)`);
process.exit(fail ? 1 : 0);
