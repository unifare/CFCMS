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
    entryPoints: [join(root, "src/extensions/security.ts")],
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
rejects(
  v,
  validTheme({
    tables: [
      { name: "product", fields: [{ key: "a", type: "text" }] },
      { name: "product", fields: [{ key: "b", type: "text" }] },
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
  validTheme({ tables: [{ name: "thing", fields: [{ key: "a", type: "text" }] }] }),
  "table without translatable / without admin screen"
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
