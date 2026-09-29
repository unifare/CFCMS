/**
 * Render every Aurora template through the real engine with a realistic scope.
 *
 * The point is to catch template *syntax* and helper-misuse errors locally,
 * before they turn into a silent fall-back to the minimal shell on a live
 * deploy. A theme that throws renders as a blank page, so this is the cheapest
 * possible guard.
 */
import { readFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const require = createRequire(import.meta.url);

// The engine is TypeScript with no build step; Node's built-in type stripping
// rejects parameter properties (`constructor(private x: T)`), so transpile with
// esbuild the same way the other harnesses do.
async function loadEngine() {
  const src = readFileSync(join(root, "src/rendering/template-engine.ts"), "utf8");
  let esbuild;
  try { esbuild = require("esbuild"); } catch { esbuild = null; }
  if (esbuild) {
    const out = esbuild.transformSync(src, { loader: "ts", format: "esm", target: "es2022" });
    return import("data:text/javascript;base64," + Buffer.from(out.code).toString("base64"));
  }
  const ts = require("typescript");
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return import("data:text/javascript;base64," + Buffer.from(out.outputText).toString("base64"));
}

const { renderTemplateSource } = await loadEngine();

const DIR = join(root, "themes/aurora/templates");
const PARTS = join(DIR, "parts");

const cache = new Map();
const loadTemplate = (name) => {
  if (cache.has(name)) return cache.get(name);
  for (const p of [join(DIR, name + ".html"), join(DIR, name), join(PARTS, basename(name) + ".html")]) {
    try { const s = readFileSync(p, "utf8"); cache.set(name, s); return s; } catch { /* keep looking */ }
  }
  cache.set(name, null);
  return null;
};

const post = (slug, title, excerpt, created) => ({
  id: "post_" + slug, slug, type: "post", status: "published",
  created_at: created, updated_at: created,
  locale: "en", title, excerpt,
  content: JSON.stringify([
    { type: "core/paragraph", attrs: { text: "Opening paragraph so the drop cap has something to bite on. " + "The quick brown fox jumps over the lazy dog. ".repeat(20) } },
    { type: "core/heading", attrs: { text: "A section heading" } },
    { type: "core/paragraph", attrs: { text: "Body copy under the first heading." } },
    { type: "core/quote", attrs: { text: "A pull quote worth remembering." } },
    { type: "core/heading", attrs: { text: "A second heading" } },
    { type: "core/list", attrs: { text: "First item\nSecond item\nThird item" } },
    { type: "core/code", attrs: { text: "const x = 1;" } },
  ]),
  meta: {},
  html: `<p>Opening paragraph so the drop cap has something to bite on. ${"The quick brown fox jumps over the lazy dog. ".repeat(20)}</p><h2>A section heading</h2><p>Body copy under the first heading.</p><blockquote>A pull quote worth remembering.</blockquote><h2>A second heading</h2><ul><li>First item</li><li>Second item</li></ul><pre><code>const x = 1;</code></pre>`,
  url: `/en/blog/${slug}`,
});

const posts = [
  post("hello-world", "Hello World", "My first post on this site.", 1750000000),
  post("second-post", "Second Post", "Testing the archive layout with a longer summary that should be truncated by the template helper.", 1751000000),
  post("l3-widget", "L3 Widget", "Built by a worker theme, rendered declaratively here.", 1752000000),
];

const base = {
  site: { title: "My Shop", description: "Cloudflare-native publishing platform", robots: "index,follow", locale: "en" },
  page: { title: "Hello World", description: "My first post", path: "/en/blog/hello-world", kind: "single" },
  locale: "en",
  locales: [{ code: "en", name: "English", is_default: 1 }],
  menu: {
    primary: [{ title: "About", url: "/en/about", target: null }, { title: "Shop Nav", url: "/shop-nav", target: null }],
    primary_html: '<a href="/en/about">About</a>',
  },
  theme: { name: "aurora", version: "1.0.0", title: "Aurora" },
  posts,
};

const cases = [
  ["index.html", { ...base, page: { ...base.page, title: "My Shop", kind: "home", path: "/en" } }],
  ["home.html", { ...base, page: { ...base.page, title: "My Shop", kind: "home", path: "/en" } }],
  ["single.html", { ...base, post: posts[0] }],
  ["page.html", { ...base, post: { ...posts[0], type: "page" }, page: { ...base.page, kind: "page", title: "About" } }],
  ["archive.html", { ...base, page: { ...base.page, title: "Archive", kind: "archive", path: "/en/blog" } }],
  ["category.html", { ...base, page: { ...base.page, title: "Category", kind: "category" } }],
  ["tag.html", { ...base, page: { ...base.page, title: "Tag", kind: "tag" } }],
  ["search.html", { ...base, page: { ...base.page, title: "Search", kind: "search" } }],
  ["404.html", { ...base, page: { ...base.page, title: "Not found", kind: "404" } }],
];

// Edge cases that a live site will hit but a happy-path fixture will not.
const empties = [
  ["index.html (no posts)", "index.html", { ...base, posts: [], page: { ...base.page, kind: "home" } }],
  ["archive.html (no posts)", "archive.html", { ...base, posts: [], page: { ...base.page, kind: "archive" } }],
  ["single.html (no body)", "single.html", { ...base, post: { ...posts[0], html: "", content: "" } }],
  ["index.html (no menu)", "index.html", { ...base, menu: { primary: [], primary_html: "" } }],
  ["index.html (no description)", "index.html", { ...base, site: { title: "S", description: "", robots: "", locale: "en" } }],
];

const runQuery = async (params) => {
  const want = Number(params.limit ?? 10);
  return posts.filter((p) => p.slug !== "hello-world").slice(0, want);
};

const opts = { loadTemplate, runQuery, maxDepth: 12 };

let failed = 0;
let passed = 0;
async function check(label, file, scope) {
  const src = readFileSync(join(DIR, file), "utf8");
  try {
    const html = await renderTemplateSource(src, scope, opts);
    const issues = [];
    if (!html.includes("<html")) issues.push("missing <html> shell (layout slot did not fill)");
    if (!html.includes("Aurora") && !html.includes("My Shop")) issues.push("brand not rendered");
    if (html.includes("{{")) issues.push("unrendered template syntax left in output");
    if (html.includes("undefined")) issues.push("output contains the string 'undefined'");
    if (issues.length) {
      failed++;
      console.log(`  FAIL ${label}`);
      for (const i of issues) console.log(`         - ${i}`);
    } else {
      passed++;
      console.log(`  ok   ${label}  (${html.length} bytes)`);
    }
  } catch (e) {
    failed++;
    console.log(`  FAIL ${label}\n         - threw: ${e.message}`);
  }
}

console.log("Aurora templates — happy path");
for (const [file, scope] of cases) await check(file, file, scope);

console.log("\nAurora templates — edge cases");
for (const [label, file, scope] of empties) await check(label, file, scope);

// Same summary shape as every other suite: a reader (or a script) must be able
// to tell "green" from "crashed" without knowing this file's private wording.
// This suite used to print only `N failure(s)`, so a checker grepping for the
// standard line saw nothing and could not distinguish a pass from an abort.
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
