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
// Batch 16: the block attribute contract and its two consumers. The contract
// exists because the editor wrote `attrs.text` for every block while the
// renderer read a different attribute per type, so six of twelve blocks
// rendered empty at HTTP 200.
const BLOCKS = join(ROOT, "src/rendering/blocks.ts");
const FRONTEND = join(ROOT, "src/platform/frontend.ts");
const BLOCK_FIELDS = join(ROOT, "public/admin/js/block-fields.js");
const MEDIA_PICKER = join(ROOT, "public/admin/js/media-picker.js");
const MEDIA_SCREEN = join(ROOT, "public/admin/js/screens/media.js");
const CORE_PACK = join(ROOT, "src/platform/i18n/core-pack.ts");
const EDITOR_SCREEN = join(ROOT, "public/admin/js/screens/editor.js");
const API = join(ROOT, "src/api.ts");

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
  {
    // An icon name that is not in the table. `icons.js` falls back to the
    // `info` glyph, so the screen still renders and every other check in
    // `admin-spa.test.mjs` still passes — the button is simply wearing the
    // wrong picture. This is the "silent near-miss" shape: it was a real bug
    // in `account.js` (`icon("key-round")`, never defined) when the guard was
    // written, which is why the injection moves an *existing* name to a
    // slightly-wrong one rather than inventing a call site.
    label: "a screen asks for an icon name the icon table does not define",
    file: join(ROOT, "public/admin/js/screens/account.js"),
    before: ['icon("key-round")'],
    after: ['icon("key-round-not-a-real-icon")'],
    runs: [["tests/suites/admin-spa.test.mjs", 'every icon("...") name is defined in the icon table']],
  },
  {
    // The switch vocabulary is pinned to exactly one file because three readers
    // must agree on it (resolver, admin screen, `vars` name). A second copy is
    // how "saves fine, does nothing" gets in — the defect this repo has fixed
    // five times under the name "declared but never consumed".
    label: "the feature-switch vocabulary is declared a second time",
    file: join(ROOT, "src/extensions/contract/manifest.ts"),
    before: ['export const ALLOWED_ADMIN_SCREENS = ['],
    after: [
      'export const FEATURE_SWITCHES = [\n' +
        '  { key: "cache_mirror_kv", varName: "CFPRESS_CACHE_MIRROR_KV", defaultOn: true, label: "a rival copy" },\n' +
        '] as const;\n\n' +
        'export const ALLOWED_ADMIN_SCREENS = [',
    ],
    runs: [["tests/suites/architecture.test.mjs", "FEATURE_SWITCHES is defined in exactly one file"]],
  },
  {
    // `defaultOn` omitted is the quietest possible bug: `undefined` is falsy, so
    // the switch behaves as "off", which is usually correct — and the omission
    // is invisible until someone reads the definition expecting a stated choice.
    label: "a declared switch stops stating its default explicitly",
    file: join(ROOT, "src/shared/features.ts"),
    before: ['    varName: "CFPRESS_CACHE_MIRROR_KV",\n    defaultOn: false,'],
    after: ['    varName: "CFPRESS_CACHE_MIRROR_KV",'],
    runs: [["tests/suites/architecture.test.mjs", "every declared feature switch states its default explicitly"]],
  },
  {
    // A switch that defaults to on is a feature nobody asked for, shipping to
    // every free-plan deploy. The two current switches gate a paid binding and
    // a KV write amplifier, so "on by default" is wrong for both.
    label: "a switch defaults to on",
    file: join(ROOT, "src/shared/features.ts"),
    before: ['    defaultOn: false,\n    label: "Mirror the content-cache version into KV",'],
    after: ['    defaultOn: true,\n    label: "Mirror the content-cache version into KV",'],
    runs: [["tests/suites/architecture.test.mjs", "both switches default to off"]],
  },
  {
    // If the API ever persists a key that `FEATURE_SWITCHES` does not declare,
    // the operator gets a switch that saves successfully and is never read.
    // That is the "declared but never consumed" family — already fixed five
    // times in this repo — so the rejection has to be pinned, not just written.
    //
    // Note which assertion this pins. Neutralizing the guard makes the route
    // report 400 anyway (there is a defensive read after it), so "an unknown key
    // is a 400" stays green and *the persistence assertion is what flips*. That
    // was a genuine correction: the first version of this scenario pinned the
    // status code and reported a false "did not go red". The lesson is the one
    // in §12 — the guard to pin is the one that can actually observe the defect.
    label: "the features API accepts a switch key it does not declare",
    file: join(ROOT, "src/api.ts"),
    before: ['  if (!FEATURE_SWITCHES.some((s) => s.key === key)) {\n    return ok({ error: `unknown feature switch: ${key}` }, 400);\n  }'],
    after: ['  if (false) {\n    return ok({ error: `unknown feature switch: ${key}` }, 400);\n  }'],
    runs: [["tests/suites/features.test.mjs", "nothing was written for the unknown key"]],
  },
  {
    // Removing this line does not make the route public — `requireAdmin` sits
    // above it — but it does let *any signed-in user* change a switch that
    // turns on paid features. The anonymous assertions in the suite stay green
    // when this line goes, which is exactly why the suite also creates a
    // non-admin user; that assertion is what this scenario pins.
    label: "the features write route drops its settings.manage check",
    file: join(ROOT, "src/api.ts"),
    before: ['if (path === "features" && method === "POST") {\n    if (!(await requirePermission(env, user, "settings.manage"))) return ok({ error: "Forbidden" }, 403);'],
    after: ['if (path === "features" && method === "POST") {\n    if (false) return ok({ error: "Forbidden" }, 403);'],
    runs: [["tests/suites/features.test.mjs", "a signed-in user without settings.manage cannot write"]],
  },
  {
    // The `settings` row is the site layer of the precedence chain, and the
    // resolver reads it under one fixed key (`FEATURE_SETTINGS_KEY`). If a write
    // stored the switches under a different key, the row would be written and
    // never read — a silent no-op, the shape this repo keeps fixing.
    //
    // The anchor is the **INSERT** branch deliberately. The UPDATE branch needs
    // a pre-existing row, and a scenario that depends on which branch a suite
    // happens to reach is fragile — the first draft used the UPDATE path and
    // tripped a UNIQUE violation instead of the intended assertion, which read
    // as "no summary" and proved nothing. The INSERT branch is exercised by
    // section 3, which saves onto a clean table.
    label: "a saved switch is written under the wrong settings key",
    file: join(ROOT, "src/api.ts"),
    before: ['.bind(await randomId(), siteId, FEATURE_SETTINGS_KEY, next).run();'],
    after: ['.bind(await randomId(), siteId, FEATURE_SETTINGS_KEY + "-typo", next).run();'],
    runs: [["tests/suites/features.test.mjs", "the row is now the source"]],
  },
  {
    // The dashboard's stat cards must arrive as data (`cards` from the API,
    // translated server-side, plugin-extendable). A client-side `stat("Posts")`
    // is a copy that will not translate and will not see plugin cards.
    label: "a hard-coded stat card reappears in the dashboard screen",
    file: join(ROOT, "public/admin/js/screens/dashboard.js"),
    before: ["  const cards = (d.cards || [])"],
    after: ["  const cards = (d.cards || [])\n  const legacy = stat(\"Posts\", 0);"],
    runs: [["tests/suites/architecture.test.mjs", "the dashboard screen carries no hard-coded stat cards"]],
  },
  {
    // The settings auto-form must have a rendering branch for every type in
    // ALLOWED_FIELD_TYPES. Deleting a branch silently degrades that type to a
    // text input — a declared select loses its choices, a boolean becomes
    // free text — with nothing else failing.
    label: "a settings-form type branch is deleted",
    file: join(ROOT, "public/admin/js/screens/theme-menu.js"),
    before: ['    case "boolean":'],
    after: [''],
    runs: [["tests/suites/architecture.test.mjs", "every allowed field type has a rendering branch in the settings form"]],
  },
  {
    // The editor's insert palette must be delivered by `GET /api/v1/blocks`
    // from the renderer's `CORE_BLOCKS`. A block-name literal in the SPA is a
    // second list guaranteed to drift (the hand-written palette had already
    // lost gallery/button/columns while the renderer kept supporting them).
    label: "a block-name literal reappears in the admin SPA",
    file: join(ROOT, "public/admin/js/screens/editor.js"),
    before: ["  // Never re-list block types here."],
    after: ["  // Never re-list block types here.\n  const legacy = [\"core/paragraph\", \"Paragraph\"];"],
    runs: [["tests/suites/architecture.test.mjs", "the admin SPA carries no block-name literals (palette comes from CORE_BLOCKS)"]],
  },
  {
    // The renderer reads one attribute per block type. Reading a *different*
    // one than the contract declares is exactly the defect class this guard
    // exists for: the block still renders, just with nothing in it.
    label: "the renderer reads an attribute the contract does not declare",
    file: FRONTEND,
    before: ['case"core/image":return a.url?'],
    after: ['case"core/image":return a.src?'],
    runs: [["tests/suites/architecture.test.mjs", "the renderer reads exactly the attributes each block declares"]],
  },
  {
    // A block the renderer supports but the palette no longer offers is a
    // block nobody can insert — the other direction of the same drift.
    label: "a renderer case loses its block declaration",
    file: BLOCKS,
    before: ['{ key: "alt", type: "text", labelKey: "core.block.field.imageAlt", fallback: "Alt text" }'],
    after: ['{ key: "caption", type: "text", labelKey: "core.block.field.imageAlt", fallback: "Alt text" }'],
    runs: [["tests/suites/architecture.test.mjs", "the renderer reads exactly the attributes each block declares"]],
  },
  {
    // A declared type with no control branch degrades to a text input, which is
    // how a declared media field silently becomes a URL box.
    label: "an attribute type loses its control branch",
    file: BLOCK_FIELDS,
    before: ['    case "url":\n'],
    after: ['    case "link":\n'],
    runs: [["tests/suites/architecture.test.mjs", "every attribute type has a control branch"]],
  },
  {
    // The exported list is what a reader trusts; if it drops a type the switch
    // still handles, the two tables disagree and nothing else notices.
    label: "the control module's exported type list drifts from the contract",
    file: BLOCK_FIELDS,
    before: ['export const RENDERED_ATTR_TYPES = ["text", "textarea", "url", "media", "media-list"];'],
    after: ['export const RENDERED_ATTR_TYPES = ["text", "textarea", "url", "media-list"];'],
    runs: [["tests/suites/architecture.test.mjs", "the control module's type list matches the contract's closed set"]],
  },
  {
    // A media-list without its item keys renders a field with no inputs at all:
    // the control has no way to invent `url`/`alt`, so the shape belongs in the
    // declaration.
    label: "a media-list attribute stops declaring its item keys",
    file: BLOCKS,
    before: [', required: true, itemKeys: MEDIA_ITEM_KEYS }]'],
    after: [', required: true }]'],
    runs: [["tests/suites/architecture.test.mjs", "every media-list attribute declares its item keys"]],
  },
  {
    // "One control" is a claim about the codebase. A screen that grows its own
    // copy is how three answers to the same question appear — and the two that
    // had no answer at all (the media custom-field types) is how they started.
    label: "a screen grows its own media control",
    file: MEDIA_SCREEN,
    before: ['import { mediaItem, mediaUrl } from "../media-picker.js";'],
    after: ['import { mediaItem, mediaUrl } from "../media-picker.js";\nconst legacyControl = `<div data-media-field><button data-media-pick>Choose</button></div>`;'],
    runs: [["tests/suites/architecture.test.mjs", "exactly one module emits the media control wrapper"]],
  },
  {
    // The read path checks the key's tenant before serving (rule 60), so a URL
    // assembled by hand is a 404 waiting for a filename with a slash in it. The
    // media screen had three of them before the picker owned the URL.
    label: "a screen hand-builds a /media/ URL again",
    file: MEDIA_SCREEN,
    before: ['function formatBytes(n) {'],
    after: ['const handBuiltUrl = `/media/${encodeURIComponent("uploads/default/x.png")}`;\nfunction formatBytes(n) {'],
    runs: [["tests/suites/architecture.test.mjs", "exactly one module builds a /media/ URL"]],
  },
  {
    // The URL builder itself: a key is one path segment, so it has to be
    // percent-encoded. Un-encoded, a key containing `/` becomes several segments
    // and the read path decodes a different key than the one that was stored.
    label: "the media URL stops encoding the object key",
    file: MEDIA_PICKER,
    before: ['  return key ? `/media/${encodeURIComponent(key)}` : "";'],
    after: ['  return key ? `/media/${key}` : "";'],
    runs: [["tests/suites/media-picker.test.mjs", "a key becomes one encoded path segment"]],
  },
  {
    // `t()` falls back to the English literal, so a key that does not exist is
    // silent: the screen renders correct-looking English while everything around
    // it is in the user's language.
    label: "a screen asks for a dictionary key nobody declared",
    file: EDITOR_SCREEN,
    before: ['t("core.editor.back", "Back")'],
    after: ['t("core.editor.backTypo", "Back")'],
    runs: [["tests/suites/architecture.test.mjs", "every key the admin asks for is declared in both core packs"]],
  },
  {
    // A key added to one pack only is the same defect from the other side: the
    // language that lacks it silently shows English.
    label: "a dictionary key is added to one core pack only",
    file: CORE_PACK,
    before: ['  "core.editor.edit": "Edit",\n'],
    after: ['  "core.editor.edit": "Edit",\n  "core.editor.englishOnly": "EN only",\n'],
    runs: [["tests/suites/architecture.test.mjs", "no key is declared in one core pack but not the other"]],
  },
  {
    // The reverse direction, scoped to the editor's namespace: a string that was
    // written into the dictionary and then never shown.
    label: "an editor dictionary key loses its call site",
    file: EDITOR_SCREEN,
    before: ['t("core.editor.duplicate", "Duplicate")'],
    after: ['"Duplicate"'],
    runs: [["tests/suites/architecture.test.mjs", "every editor dictionary key has a call site"]],
  },
  {
    // The autosave interval used to be cleared in two of the editor's exit
    // paths, which is how navigation came to be the missing one: a hand-rolled
    // `clearInterval` is the second cleanup path reappearing.
    label: "a screen clears the autosave timer by hand again",
    file: EDITOR_SCREEN,
    before: ['  stopAutosave();\n  await api(scoped(contentPath(state.type) + "/" + state.editing.id), { method: "DELETE" });'],
    after: ['  clearInterval(state.autosaveTimer);\n  await api(scoped(contentPath(state.type) + "/" + state.editing.id), { method: "DELETE" });'],
    runs: [["tests/suites/architecture.test.mjs", "only the shared helper clears the autosave timer"]],
  },
  {
    // Uninstalling the theme that renders a live site takes the site down with
    // it, so the endpoint refuses with a 409 that names the site. Removing the
    // guard is how an operator discovers their front page is gone.
    label: "theme uninstall accepts a theme a site is still using",
    file: API,
    before: ['  if(sites.length) return ok({error:`still active on: ${sites.join(", ")}`},409);'],
    after: [''],
    runs: [["tests/suites/theme-integration.test.mjs", "uninstalling the active theme is refused"]],
  },
];

/** Every file any scenario may touch, hashed before and after. */
const WATCHED = [...new Set([SCHEMA, EVENTS, ARCH, SCOPE, MANIFEST, VALIDATION,
  join(ROOT, "src/shared/features.ts"),
  join(ROOT, "src/api.ts"),
  join(ROOT, "src/extensions/contract/hooks.ts"),
  join(ROOT, "AGENTS.md"),
  join(ROOT, "docs/guides/THEME-DEV.md"),
  join(ROOT, "public/admin/js/screens/account.js"),
  join(ROOT, "public/admin/js/screens/editor.js"),
  join(ROOT, "public/admin/js/screens/dashboard.js"),
  join(ROOT, "public/admin/js/screens/theme-menu.js"),
  BLOCKS, FRONTEND, BLOCK_FIELDS, MEDIA_PICKER, MEDIA_SCREEN, CORE_PACK, API])];

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
    //
    // ⚠️ **`import()` resolving is not the suite finishing.** This was the
    // second false-negative in this harness, and it was much harder to see than
    // the first. Every suite ends with `process.exit(0)`, which is stubbed to
    // `done` below — but the module body *also* completes while `main()` is
    // still awaiting its first `await`. So `.then(() => done(0))` is a **second,
    // premature** trigger: whichever fires first wins, and the worker is
    // terminated with only the output written so far.
    //
    // The effect is a suite that reports "no summary (aborted)" — read as "the
    // guard did not go red", the exact false negative this tool exists to rule
    // out. It only bites suites slow enough to lose the race (esbuild compile
    // time is the usual culprit), so it looks like a per-suite quirk rather
    // than a harness bug: `architecture` and `admin-spa` passed, `features` did
    // not, and the difference was milliseconds.
    //
    // The fix is to make the suite's own `process.exit` the *only* trigger. If
    // the module itself throws before ever calling it, `esbuild`-style failures
    // still need reporting — so the catch reports, but a clean resolve does not.
    const entry = `
      let out = "";
      process.stdout.write = (c) => { out += c; };
      process.stderr.write = (c) => { out += c; };
      let reported = false;
      const done = (code) => {
        if (reported) return;
        reported = true;
        parentPort.postMessage({ out, code: code == null ? 0 : code });
      };
      process.exit = done;
      import(${JSON.stringify(pathToFileURL(join(ROOT, relPath)).href)})
        .catch((e) => { out += "\\n[suite threw before process.exit] " + ((e && e.stack) || e) + "\\n"; done(1); });
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
const finalBlocks = await runSuite("tests/suites/editor-blocks.test.mjs");
const finalPicker = await runSuite("tests/suites/media-picker.test.mjs");
console.log(`post-restore: architecture ${final.passed}p/${final.failed}f, ` +
  `schema-scope ${finalScope.passed}p/${finalScope.failed}f, ` +
  `manifest ${finalManifest.passed}p/${finalManifest.failed}f, ` +
  `editor-blocks ${finalBlocks.passed}p/${finalBlocks.failed}f, ` +
  `media-picker ${finalPicker.passed}p/${finalPicker.failed}f`);
// A missing summary here means "I could not read the result", which is a
// failure — not an absence of failure.
for (const [label, res] of [["architecture", final], ["schema-scope", finalScope], ["manifest", finalManifest], ["editor-blocks", finalBlocks], ["media-picker", finalPicker]]) {
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
