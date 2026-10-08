/**
 * The Journal theme, validated end to end — `content/themes/journal/`.
 *
 * ## Why this suite exists
 *
 * A theme's templates are the one part of this repository that **cannot fail
 * loudly**. A missing `{{/section}}`, a helper written as `{{truncate x 20}}`,
 * a `{{post.html}}` where `{{{post.html}}}` was meant — none of these throw
 * where a developer would see it. The engine degrades to an unstyled shell, or
 * escapes the article into visible `<p>` tags, and the manifest validator and
 * the architecture test both pass. Only rendering the real templates through
 * the real engine catches them.
 *
 * So this suite renders every declared template with a realistic scope, plus
 * the scopes a live site reaches that a happy path never does (no posts, no
 * menu, no description, an object that failed to load), and asserts the
 * invariants that hold for all of them.
 *
 * ## What is deliberately NOT here
 *
 * Upload → activate → serve. That chain needs a real Worker and a real D1 and
 * is covered by `theme-integration.test.mjs`. What is unique to this theme —
 * that its declaration, its templates and its palette agree with each other
 * and with the platform — is what is asserted below.
 *
 * Usage: node tests/suites/theme-journal.test.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { langPackProblems, themeManifestProblems } from "../fixtures/_extension-rules.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const require = createRequire(pathToFileURL(join(root, "package.json")).href);

let pass = 0;
let fail = 0;
const failures = [];
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL ${name}\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`);
  }
}
function section(t) {
  console.log(`\n${t}`);
}

async function bundle(entry, outName) {
  const esbuild = require("esbuild");
  const out = await esbuild.build({
    entryPoints: [join(root, entry)],
    bundle: true,
    format: "esm",
    target: "es2022",
    write: false,
    platform: "neutral",
    logLevel: "silent",
  });
  const dir = join(root, ".wrangler");
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, outName);
  writeFileSync(tmp, out.outputFiles[0].text);
  return import(pathToFileURL(tmp).href + "?t=" + Date.now());
}

const THEME = "journal";
const themeDir = join(root, "content", "themes", THEME);
const read = (p) => readFileSync(join(themeDir, p), "utf8");

async function main() {
  const { validateManifest } = await bundle("src/extensions/contract/validation.ts", "journal-validation.mjs");
  const { renderTemplateSource } = await bundle("src/rendering/template-engine.ts", "journal-engine.mjs");

  // -- 1. the install boundary --------------------------------------------
  section("1. The install boundary accepts it");
  const manifest = JSON.parse(read("theme.json"));
  let error = null;
  try {
    const v = validateManifest(manifest, "theme");
    check("the validator normalises the manifest", v.name, THEME);
  } catch (e) {
    error = e.message;
  }
  check("validateManifest does not throw", error, null);

  const manifestProblems = themeManifestProblems(root).filter((p) => p.includes(`/${THEME}`));
  check("every declared template is shipped", manifestProblems, []);
  const langProblems = langPackProblems(root).filter((p) => p.includes(`/themes/${THEME}/`));
  check("language packs are namespaced", langProblems, []);

  // -- 2. the palette ------------------------------------------------------
  section("2. The palette is defined for both themes");
  const styles = read("templates/parts/styles.html");
  check("light tokens are on :root", /:root\s*\{[^}]*--bg:/.test(styles), true);
  check("dark tokens are defined", /\[data-theme="dark"\]\s*\{[^}]*--bg:/.test(styles), true);
  // Every *colour* token the light palette defines must be redefined for dark,
  // or a dark reader gets a `var()` that resolves to nothing and an invisible
  // element. Non-colour tokens (fonts, radius, measure) are deliberately
  // shared, so comparing the whole token list would be the wrong assertion.
  const colorTokens = (block) =>
    [...block.matchAll(/(--[a-z0-9-]+)\s*:\s*(oklch\([^;]*\))/g)].map((m) => m[1]).sort();
  const rootBlock = styles.slice(styles.indexOf(":root"), styles.indexOf('[data-theme="dark"]'));
  const darkBlock = styles.slice(styles.indexOf('[data-theme="dark"]'), styles.indexOf("*,*::before"));
  check("the light palette defines colours", colorTokens(rootBlock).length > 5, true);
  check("every light colour is redefined for dark", colorTokens(rootBlock).filter((t) => !colorTokens(darkBlock).includes(t)), []);
  check("dark defines no colour the light palette lacks", colorTokens(darkBlock).filter((t) => !colorTokens(rootBlock).includes(t)), []);

  // -- 3. every template renders through the real engine -------------------
  section("3. Every declared template renders through the real template engine");
  const loadTemplate = async (name) => {
    for (const p of [join(themeDir, "templates", `${name}.html`), join(themeDir, "templates", "parts", `${name}.html`)]) {
      if (existsSync(p)) return readFileSync(p, "utf8");
    }
    return null;
  };
  const render = async (file, scope) =>
    renderTemplateSource(readFileSync(join(themeDir, "templates", file), "utf8"), scope, { loadTemplate });

  const post = {
    id: "post_1",
    slug: "hello-world",
    title: "Hello World",
    excerpt: "A publishing platform built to end the negotiation with its own framework.",
    html: "<p>First paragraph.</p><h2>A heading</h2><blockquote>Quoted.</blockquote><pre><code>const x = 1;</code></pre>",
    reading_time: "3 min read",
    date_display: "Oct 8, 2026",
    created_at: 1791433031,
  };
  const listItem = {
    slug: "hello-world",
    title: "Hello World",
    excerpt: post.excerpt,
    url: "/en/blog/hello-world",
    created_at: 1791433031,
    date_display: "Oct 8, 2026",
  };
  const base = (over = {}) => ({
    site: { title: "Journal Site", description: "Notes on building things.", robots: "index,follow", locale: "en" },
    page: { title: "Home", description: "Notes on building things.", path: "/en", kind: "home", document_title: "Journal Site" },
    locale: "en",
    locales: [{ code: "en", name: "English", is_default: true }],
    theme: { name: THEME, title: "Journal", version: "1.0.0" },
    menu: { primary: [], primary_html: "" },
    post: null,
    ...over,
  });

  const kinds = [
    ["home.html", base({ posts: [listItem] })],
    ["index.html", base({ posts: [listItem] })],
    ["archive.html", base({ posts: [listItem] })],
    ["single.html", base({ post, page: { title: post.title, kind: "single", document_title: "Hello World | Journal Site" } })],
    ["page.html", base({ post: { ...post, reading_time: "", date_display: "" } })],
    ["404.html", base({ page: { title: "Not Found", kind: "404", document_title: "Not Found | Journal Site" } })],
  ];
  for (const [file, scope] of kinds) {
    const html = await render(file, scope);
    const problems = [];
    if (!html.includes("<html")) problems.push("shell did not render (an unclosed section?)");
    if (html.includes("{{")) problems.push("unresolved template syntax leaked");
    if (html.includes("undefined")) problems.push("output contains undefined");
    if (!html.includes("Journal Site")) problems.push("site title missing");
    if (!html.includes("theme-toggle")) problems.push("theme toggle missing");
    check(`${file} renders clean`, problems, []);
  }

  // -- 4. the article is not escaped ---------------------------------------
  section("4. Rendered article HTML is not escaped");
  const single = await render("single.html", base({ post }));
  check("prose markup survives", single.includes("<blockquote>Quoted.</blockquote>"), true);
  check("code block survives", single.includes("<pre><code>const x = 1;</code></pre>"), true);
  check("no escaped paragraph tags", single.includes("&lt;p&gt;"), false);
  check("the date is printed", single.includes("Oct 8, 2026"), true);
  check("reading time is printed", single.includes("3 min read"), true);

  // -- 5. listings link and date -------------------------------------------
  section("5. Listings carry links and dates");
  const home = await render("home.html", base({ posts: [listItem] }));
  check("the post is linked", home.includes('href="/en/blog/hello-world"'), true);
  check("the title is printed", home.includes("Hello World"), true);
  check("the date is printed", home.includes("Oct 8, 2026"), true);

  // -- 6. the empty and degraded scopes ------------------------------------
  section("6. Empty and degraded scopes still render");
  const empties = [
    ["home.html", base({ posts: [] })],
    ["index.html", base({ posts: [] })],
    ["archive.html", base({ posts: [] })],
    ["home.html", base({ posts: [], site: { title: "Bare", description: "", robots: "", locale: "en" } })],
    ["single.html", base({ post: null })],
    ["page.html", base({ post: null })],
    ["home.html", base({ posts: [listItem], menu: { primary: [], primary_html: "" } })],
    ["single.html", base({ post: { ...post, html: "", excerpt: "", date_display: "", reading_time: "" } })],
  ];
  for (const [file, scope] of empties) {
    const html = await render(file, scope);
    const problems = [];
    if (!html.includes("<html")) problems.push("shell did not render");
    if (html.includes("{{")) problems.push("unresolved template syntax leaked");
    if (html.includes("undefined")) problems.push("output contains undefined");
    check(`${file} renders clean when empty/degraded`, problems, []);
  }
  check("an empty list says so", (await render("home.html", base({ posts: [] }))).includes("Nothing published yet"), true);

  // -- 7. the Chinese path --------------------------------------------------
  section("7. The Chinese locale renders Chinese chrome");
  const zh = base({
    locale: "zh-CN",
    site: { title: "日志", description: "记录构建过程。", robots: "", locale: "zh-CN" },
    posts: [listItem],
  });
  const zhHome = await render("home.html", zh);
  check("the section heading is translated", zhHome.includes("最新文章"), true);
  check("the read link is translated", zhHome.includes("阅读全文"), true);
  check("no English fallback leaked", zhHome.includes("Latest writing"), false);
  const zhEmpty = await render("home.html", { ...zh, posts: [] });
  check("the empty state is translated", zhEmpty.includes("还没有发布任何内容"), true);

  // -- 8. no-flash bootstrap ------------------------------------------------
  section("8. The palette is resolved before first paint");
  const layout = read("templates/parts/layout.html");
  const scriptAt = layout.indexOf("journal-theme");
  const styleAt = layout.indexOf("parts/styles");
  check("the bootstrap reads localStorage", scriptAt > -1, true);
  check("it runs before the stylesheet", scriptAt > -1 && styleAt > -1 && scriptAt < styleAt, true);
  check("it sets colorScheme for native controls", layout.includes("colorScheme"), true);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) {
    console.log("failures:\n  " + failures.join("\n  "));
    process.exit(1);
  }
}

main().catch((e) => {
  console.log(`\n0 passed, 1 failed`);
  console.log(`(aborted) ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
