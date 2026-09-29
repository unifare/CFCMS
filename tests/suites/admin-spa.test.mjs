/**
 * Admin SPA tests — the machine enforcement for `public/admin/`.
 *
 * The admin SPA is split into modules that talk to each other through a small
 * number of explicit seams. Two things can break silently when that structure
 * drifts, and neither is caught by any other suite:
 *
 *   1. **The `window.*` contract.** Rendered markup calls handlers with inline
 *      `onclick="name(...)"`, which the browser resolves against `window`. A
 *      handler that is not published there produces no build error, no console
 *      error and no failed request — the button just does nothing. This is the
 *      "page looks fine but clicking does nothing" regression.
 *
 *   2. **The module graph.** A circular import between the shell and a screen
 *      still loads in some browsers and not others; an orphaned module (written
 *      but never imported) is simply dead code that looks alive.
 *
 * Usage: node tests/suites/admin-spa.test.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync, cpSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const ADMIN = join(ROOT, "public/admin");
const ENTRY = join(ADMIN, "admin.js");

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

function walk(dir, exts, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, exts, out);
    else if (exts.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

const read = (f) => readFileSync(f, "utf8");
const rel = (f) => relative(ROOT, f).split(sep).join("/");

/** Every import specifier in `src`, including bare `import "x"` side effects. */
function importSpecifiers(src) {
  const specs = [];
  // Strip block and line comments so prose examples do not register as imports.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const m of code.matchAll(/^\s*import\s+(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gm)) {
    specs.push(m[1]);
  }
  return specs;
}

const jsFiles = walk(ADMIN, [".js"]);
const byPath = new Map(jsFiles.map((f) => [resolve(f), f]));

// ---------------------------------------------------------------------------
section("Module graph is resolvable and acyclic");
// ---------------------------------------------------------------------------

/** Resolve a relative specifier the way a browser would, including the `.js`. */
function resolveSpecifier(fromFile, spec) {
  if (!spec.startsWith(".")) return null; // bare specifier — none exist today
  const abs = resolve(dirname(fromFile), spec);
  return byPath.has(abs) ? abs : undefined; // undefined = written but missing
}

const unresolved = [];
const graph = new Map();
for (const f of jsFiles) {
  const deps = [];
  for (const spec of importSpecifiers(read(f))) {
    const target = resolveSpecifier(f, spec);
    if (target === undefined) unresolved.push(`${rel(f)} -> ${spec}`);
    else if (target) deps.push(target);
  }
  graph.set(resolve(f), deps);
}

check(
  "every relative import resolves to a file that exists",
  unresolved.length === 0,
  unresolved.length ? `missing targets:\n       ${unresolved.join("\n       ")}` : ""
);

/** Depth-first cycle detection, reporting the actual cycle path. */
const WHITE = 0, GREY = 1, BLACK = 2;
const colour = new Map([...graph.keys()].map((k) => [k, WHITE]));
const cycles = [];
function visit(node, stack) {
  colour.set(node, GREY);
  for (const dep of graph.get(node) ?? []) {
    if (colour.get(dep) === GREY) {
      const at = stack.indexOf(dep);
      cycles.push([...stack.slice(at), dep].map(rel).join(" → "));
    } else if (colour.get(dep) === WHITE) {
      visit(dep, [...stack, dep]);
    }
  }
  colour.set(node, BLACK);
}
for (const node of graph.keys()) if (colour.get(node) === WHITE) visit(node, [node]);

check(
  "module graph has no import cycles",
  cycles.length === 0,
  cycles.length ? `cycles:\n       ${cycles.join("\n       ")}` : ""
);

/** Reachability from the entry — catches a module nobody imports (dead code). */
const reachable = new Set();
(function mark(node) {
  if (reachable.has(node)) return;
  reachable.add(node);
  for (const dep of graph.get(node) ?? []) mark(dep);
})(resolve(ENTRY));

const orphans = [...graph.keys()].filter((k) => !reachable.has(k)).map(rel);
check(
  "every admin module is reachable from admin.js",
  orphans.length === 0,
  orphans.length ? `orphans (written but never imported): ${orphans.join(", ")}` : ""
);

// ---------------------------------------------------------------------------
section("window.* handler contract");
// ---------------------------------------------------------------------------

/**
 * The names the markup actually calls. Only a bare identifier followed by `(`
 * counts — `onclick="this.querySelector('input').focus()"` is not a window
 * handler and must not be reported as a missing one.
 *
 * Comments are stripped first: the entry point documents the pattern with a
 * literal `onclick="name(...)"` example, which would otherwise be read as a
 * real call to a handler called `name`.
 */
const inlineCalls = new Set();
for (const f of walk(ADMIN, [".js", ".html"])) {
  const code = read(f)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  for (const m of code.matchAll(/onclick\s*=\s*["']([A-Za-z_$][\w$]*)\s*\(/g)) {
    inlineCalls.add(m[1]);
  }
}

/** Names published on `window`, from the entry map and any direct assignment. */
const published = new Set();
const entrySrc = read(ENTRY);
const mapBody = entrySrc.match(/const\s+WINDOW_HANDLERS\s*=\s*\{([\s\S]*?)\n\};/);
if (mapBody) {
  for (const line of mapBody[1].split("\n")) {
    const code = line.replace(/\/\/.*$/, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*(?:,|:|$)/g)) published.add(m[1]);
  }
}
for (const f of jsFiles) {
  const code = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const m of code.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=/g)) published.add(m[1]);
}
published.delete("");

check(
  "the entry declares a WINDOW_HANDLERS map",
  Boolean(mapBody),
  "admin.js must publish the window.* contract in one visible place"
);

/**
 * The pinned contract: these 18 handlers existed before the module split and
 * must keep existing. Removing one is the "button silently does nothing" bug;
 * this list is what makes that a test failure instead of a support ticket.
 */
const EXPECTED_HANDLERS = [
  "toggleMenu", "closeMenus", "toggleGroup", "toggleSidebar", "go", "switchSite",
  "newContent", "editContent", "addBlock", "saveContent", "showRevisions", "deleteContent",
  "installExtension", "pluginSettings", "doLogin", "logout", "setThemeForTest",
];
const missingHandlers = EXPECTED_HANDLERS.filter((n) => !published.has(n));
check(
  `all ${EXPECTED_HANDLERS.length} pre-split window handlers are still published`,
  missingHandlers.length === 0,
  missingHandlers.length ? `no longer published: ${missingHandlers.join(", ")}` : ""
);

const missingForMarkup = [...inlineCalls].filter((n) => !published.has(n));
check(
  "every handler called from inline markup is published on window",
  missingForMarkup.length === 0,
  missingForMarkup.length
    ? `markup calls these but nothing publishes them: ${missingForMarkup.join(", ")}`
    : ""
);

check(
  "inline markup calls at least one handler (the check is not vacuous)",
  inlineCalls.size > 0,
  "no onclick=\"name(\" found anywhere — the scan or the markup changed"
);

// ---------------------------------------------------------------------------
section("Entry point stays thin (ratchet)");
// ---------------------------------------------------------------------------

/**
 * The split is the whole point of this suite: `admin.js` was 1514 lines and
 * every screen lived in it. If a screen grows back into the entry, the module
 * structure is decorative. The threshold is deliberately generous — it catches
 * a screen being pasted back in, not normal wiring edits.
 */
const entryLines = entrySrc.split("\n").length;
check(
  "admin.js is wiring only (< 120 lines)",
  entryLines < 120,
  `admin.js is ${entryLines} lines — a screen has probably moved back into it`
);

const screenDefsInEntry = [...entrySrc.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(dashboard|contentList|editor|media|resources|urls|settings|seo|sites|users|search|menus|widgets|themes|plugins|themeMenuScreen)\b/gm)];
check(
  "admin.js defines no screens",
  screenDefsInEntry.length === 0,
  screenDefsInEntry.length ? `found: ${screenDefsInEntry.map((m) => m[1]).join(", ")}` : ""
);

const screenFiles = walk(join(ADMIN, "js/screens"), [".js"]);
check(
  "screens are split into one module per screen (>= 15 files)",
  screenFiles.length >= 15,
  `found ${screenFiles.length} files under js/screens/`
);

// ---------------------------------------------------------------------------
section("Entry point boots against a DOM stub");
// ---------------------------------------------------------------------------

/**
 * A real import, not a text scan. Node will not treat `public/admin/*.js` as
 * ESM without a `type: module` boundary, so the tree is copied to a temp dir
 * with one — which also keeps the check from depending on the repo's own
 * package.json.
 *
 * The stubs are deliberately minimal: enough for module bodies and the boot
 * sequence to run, so a top-level `ReferenceError` or a broken registration is
 * caught here rather than in a browser.
 */
function makeEl(tag = "div") {
  return {
    tagName: String(tag).toUpperCase(),
    hidden: false,
    style: {},
    dataset: {},
    children: [],
    innerHTML: "",
    textContent: "",
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    querySelector: () => makeEl("div"),
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    appendChild(node) { return node; },
    closest: () => null,
    focus() {},
  };
}

const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(String(e)));

let bootError = null;
let winStub = null;
let tmpDir = null;
let modules = null;
let contentEl = null;
try {
  tmpDir = mkdtempSync(join(tmpdir(), "cfpress-admin-"));
  cpSync(ADMIN, tmpDir, { recursive: true });
  writeFileSync(join(tmpDir, "package.json"), '{"type":"module"}\n');

  const appEl = makeEl("div");
  // Persistent, so a test can read back what a screen wrote into it.
  contentEl = makeEl("div");
  const store = new Map();
  winStub = { matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {}, removeEventListener() {}, scrollY: 0 };

  globalThis.window = winStub;
  globalThis.document = {
    documentElement: makeEl("html"),
    body: makeEl("body"),
    querySelector: (sel) => (sel === "#app" ? appEl : sel === "#content" ? contentEl : makeEl("div")),
    querySelectorAll: () => [],
    createElement: (t) => makeEl(t),
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
  };
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ user: null }) });
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  globalThis.location = { origin: "http://localhost" };
  globalThis.CSS = { escape: (s) => String(s) };

  await import(pathToFileURL(join(tmpDir, "admin.js")).href);
  // Let the boot IIFE settle so a rejection surfaces here.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

  modules = {
    state: await import(pathToFileURL(join(tmpDir, "js/state.js")).href),
    shell: await import(pathToFileURL(join(tmpDir, "js/shell.js")).href),
    screens: await import(pathToFileURL(join(tmpDir, "js/screens/index.js")).href),
  };
} catch (e) {
  bootError = e;
}

check(
  "the entry point imports and boots without throwing",
  bootError === null,
  bootError ? String(bootError && bootError.stack ? bootError.stack.split("\n").slice(0, 4).join("\n       ") : bootError) : ""
);

check(
  "booting raises no unhandled rejection",
  unhandled.length === 0,
  unhandled.join("\n       ")
);

if (winStub) {
  const missingAtRuntime = EXPECTED_HANDLERS.filter((n) => typeof winStub[n] !== "function");
  check(
    "all window handlers are actually callable after boot",
    missingAtRuntime.length === 0,
    missingAtRuntime.length ? `not a function on window: ${missingAtRuntime.join(", ")}` : ""
  );
}

// ---------------------------------------------------------------------------
section("Every screen renders against the stub");
// ---------------------------------------------------------------------------

/**
 * Importing a module only proves its exports exist. A typo *inside* a screen
 * body — a helper that was never imported, a renamed variable — survives the
 * import and only shows up when that screen is opened. So every registered
 * page is actually rendered here, through the real shell dispatch.
 *
 * `fetch` returns `{ ok: true, json: { items: [] } }`, which is the empty-state
 * shape every screen already handles, so a throw here means a genuine defect
 * rather than missing data.
 */
if (modules && !bootError) {
  const { state } = modules.state;
  const { render } = modules.shell;
  const { SCREENS } = modules.screens;

  state.user = { username: "admin", role: "admin" };
  state.sites = [{ id: "default", name: "Default Site", is_default: 1 }];
  state.site = "default";

  const pages = [
    ...Object.keys(SCREENS),
    "cpt:news",        // dynamic prefix → content list
    "menu:anything",   // dynamic prefix → theme menu screen
  ];

  const renderErrors = [];
  for (const page of pages) {
    state.page = page;
    state.editing = null;
    contentEl.innerHTML = "";
    try {
      await render();
    } catch (e) {
      renderErrors.push(`${page}: threw ${e.message}`);
      continue;
    }
    // The shell catches a screen's exception and swaps in an error panel, so
    // `render()` resolving is *not* proof the screen worked. Read what was
    // actually written instead — this is the difference between a check and a
    // decoration.
    if (contentEl.innerHTML.includes("Something went wrong")) {
      renderErrors.push(`${page}: rendered the error panel`);
    }
    if (!contentEl.innerHTML) {
      renderErrors.push(`${page}: rendered nothing`);
    }
  }

  check(
    `all ${pages.length} registered pages render real content`,
    renderErrors.length === 0,
    renderErrors.join("\n       ")
  );

  state.page = "dashboard";
  await render();
  const shellHtml = modules.state.app.innerHTML;
  check(
    "the shell renders the sidebar, header and content mount",
    shellHtml.includes('class="sidebar"') && shellHtml.includes('id="app-header"') && shellHtml.includes('id="content"'),
    "the rendered shell markup is missing one of sidebar / header / content"
  );
}

if (tmpDir) {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* temp dir — fine */ }
}

// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(64)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f.name}`);
  console.log(
    "\nThese guard the admin SPA's structure, not its styling. See docs/ARCHITECTURE.md §7.2."
  );
}
// One summary line only. The suite used to print `${failed ? "1" : "0"} failure(s)`
// *in addition* to the standard line — two summaries in two spellings, which is
// how a checker greps the wrong one and reads a crash as a pass (AGENTS.md
// "false green" type 6). The standard `${pass} passed, ${fail} failed` line is
// printed above and is the only one a script is allowed to parse.
process.exit(failed ? 1 : 0);
