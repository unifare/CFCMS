/**
 * The `eshop` sample theme, validated end to end — `themes/eshop/`.
 *
 * ## Why this suite exists
 *
 * `eshop` is the **living document** of what a theme may declare: theme-owned
 * tables, a generated admin screen, declarative front-end routes with
 * `resolve.table` / `query.as`, and a bilingual catalogue. Documentation drifts;
 * a theme that the real validator, the real architecture rules and the real
 * template engine all accept does not.
 *
 * It is also the only place the *combination* is exercised. `scaffold.test.mjs`
 * proves the generator emits a valid skeleton — a skeleton declares no tables
 * and no routes, because it has no business logic. `theme-integration.test.mjs`
 * proves the machinery works on an inline fixture. Neither would notice if
 * `resolve.table` and `translatable` stopped fitting together, or if the
 * product templates assumed a field the declaration no longer carries.
 *
 * ## What is deliberately NOT here
 *
 * Upload → activate → query the database. That chain needs a real Worker and a
 * real D1, and it is already covered end to end by `theme-integration.test.mjs`
 * on a fixture of the same shape. What is unique to `eshop` — *its declaration
 * and its templates agree with each other and with the platform* — is what is
 * asserted below.
 *
 * Usage: node tests/theme-eshop.test.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { langPackProblems, themeManifestProblems } from "./_extension-rules.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
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
    console.log(`  FAIL ${name}\n       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`);
  }
}
function checkTruthy(name, v) {
  if (v) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name} (got ${JSON.stringify(v)})`); }
}
function section(t) { console.log(`\n${t}`); }

/**
 * A crashed harness must still print a summary.
 *
 * Without this, a template that throws during section 5 aborts `main()` before
 * the `N passed, M failed` line, and the *only* signal left is a stack trace.
 * A reader (or a script) that greps for the summary then finds nothing and
 * concludes the suite is fine — which is exactly how this suite's own section
 * check was once mistaken for a pass while it was red. A run must never be
 * silently summary-less: absence of a summary is a failure, stated as one.
 */
function summary(note) {
  const suffix = note ? ` (${note})` : "";
  console.log(`\n${pass} passed, ${fail} failed${suffix}`);
  if (failures.length) console.log("Failed: " + failures.join(", "));
}

/**
 * Bundle a real source module. Node's built-in type stripping rejects some TS
 * the engine uses, and this environment cannot spawn a build, so esbuild is
 * invoked in-process — the same approach the other harnesses take.
 */
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

const THEME = "eshop";
const themeDir = join(root, "themes", THEME);

async function main() {
  const { validateManifest } = await bundle("src/extensions/contract/validation.ts", "eshop-validation.mjs");
  const { renderTemplateSource } = await bundle("src/rendering/template-engine.ts", "eshop-engine.mjs");

  // -- 1. install boundary -------------------------------------------------
  section("1. The install boundary accepts it");
  const manifest = JSON.parse(readFileSync(join(themeDir, "theme.json"), "utf8"));
  let error = null;
  try {
    const v = validateManifest(manifest, "theme");
    check("the validator normalises the manifest", v.name, THEME);
  } catch (e) {
    error = e?.message || String(e);
  }
  check("validateManifest accepts the theme", error, null);

  // -- 2. the declaration is the point of this theme -----------------------
  section("2. It declares what makes it interesting");
  check("declares a theme-owned table", manifest.tables.map((t) => t.name), ["product"]);
  check(
    "only the text-bearing fields are translatable",
    manifest.tables[0].translatable,
    ["name", "blurb"]
  );
  check(
    "price and stock are not translatable",
    manifest.tables[0].translatable.some((k) => ["price", "stock", "in_stock", "released_on"].includes(k)),
    false
  );
  check(
    "both halves of the table are declared (table + the menu that opens it)",
    manifest.adminMenus.some((m) => m.screen === "table-list" && m.args?.table === "product"),
    true
  );
  check(
    "the menu's table is a declared table",
    manifest.adminMenus
      .filter((m) => m.args?.table)
      .every((m) => manifest.tables.some((t) => t.name === m.args.table)),
    true
  );
  // A one-object route miss must be a 404, which only works if routing knows
  // which rows are single objects — that is what `resolve.by` says.
  const shopItem = manifest.routes.find((r) => r.path === "/shop/:slug");
  check("the item route resolves the table by slug", shopItem.resolve, { table: "product", by: "slug" });
  check("the item route names a template", shopItem.template, "single-product");
  check("the listing route names its scope", manifest.routes.find((r) => r.path === "/shop").query.as, "products");
  // The front page IS the shop: the theme claims "/" and the router honours it.
  // Only a *declared* root route takes the home page away from the blog
  // fallback, so the declaration is the whole contract — assert every half.
  const homeRoute = manifest.routes.find((r) => r.path === "/");
  checkTruthy("the front page is claimed by a route", !!homeRoute);
  check("the front-page route reads the product table", homeRoute && homeRoute.resolve, { table: "product" });
  check("the front-page route renders the product archive", homeRoute && homeRoute.template, "archive-product");
  check("the front-page route names its scope", homeRoute && homeRoute.query.as, "products");
  check("lanes are declared", manifest.locales, ["en", "zh-CN"]);

  // -- 3. the real architecture rules -------------------------------------
  section("3. The real architecture rules accept it");
  // Same functions `architecture.test.mjs` calls, not a copy — see
  // `_extension-rules.mjs` for why a copy would be the wrong answer.
  check("theme manifest rules report nothing", themeManifestProblems(root), []);
  check("language-pack rules report nothing", langPackProblems(root), []);

  // -- 4. declarations match the filesystem -------------------------------
  section("4. Every declared template and part ships a file");
  check(
    "every declared template exists",
    manifest.templates.filter((t) => !existsSync(join(themeDir, "templates", `${t}.html`))),
    []
  );
  check(
    "every declared part exists",
    manifest.parts.filter((p) => !existsSync(join(themeDir, "templates", "parts", `${p}.html`))),
    []
  );
  // `langs/<locale>.json` for each declared locale — the rules in section 3
  // check the *keys*; this checks the files are there at all, so the prefix
  // rule cannot be satisfied by an empty directory.
  check(
    "every declared locale ships a pack",
    manifest.locales.filter((l) => !existsSync(join(themeDir, "langs", `${l}.json`))),
    []
  );

  // Every child must close every section it opens. The engine tells a section
  // definition from a layout slot by scanning ahead for `{{/section}}`, so an
  // unclosed section in a child reads as a slot and renders an empty <main>
  // with HTTP 200 and no error. The engine now rejects it too, but asserting it
  // here says *which file* and needs no rendering to fail.
  const unclosed = [];
  for (const t of manifest.templates) {
    const src = readFileSync(join(themeDir, "templates", `${t}.html`), "utf8");
    const opens = (src.match(/\{\{@section\s/g) ?? []).length;
    const closes = (src.match(/\{\{\/section\}\}/g) ?? []).length;
    if (opens !== closes) unclosed.push(`${t}.html: ${opens} open, ${closes} closed`);
  }
  check("every child closes every section it opens", unclosed, []);

  const refs = [];
  for (const rel of ["parts/layout.html", ...manifest.templates.map((t) => `${t}.html`)]) {
    const src = readFileSync(join(themeDir, "templates", rel), "utf8");
    for (const m of src.matchAll(/\{\{@(?:include|extends)\s+"([^"]+)"\s*\}\}/g)) refs.push(m[1]);
  }
  check(
    "every @include/@extends target exists",
    [...new Set(refs)].filter(
      (n) => !existsSync(join(themeDir, "templates", `${n}.html`)) && !existsSync(join(themeDir, "templates", "parts", `${n}.html`))
    ),
    []
  );

  // -- 5. every template renders through the real engine -------------------
  section("5. Every template renders through the real template engine");
  const loadTemplate = async (name) => {
    for (const p of [
      join(themeDir, "templates", `${name}.html`),
      join(themeDir, "templates", "parts", `${name}.html`),
    ]) {
      if (existsSync(p)) return readFileSync(p, "utf8");
    }
    return null;
  };
  const render = async (file, scope) =>
    renderTemplateSource(readFileSync(join(themeDir, "templates", file), "utf8"), scope, { loadTemplate });

  const base = {
    site: { title: "Northgoods", description: "Small-batch goods.", robots: "", locale: "en" },
    page: { title: "Shop", description: "", path: "/shop", kind: "archive", document_title: "Shop | Northgoods" },
    locale: "en",
    locales: [{ code: "en", name: "English", is_default: true }],
    theme: { name: THEME, title: "E-Shop", version: "1.0.0" },
    menu: { primary: [{ title: "Shop", url: "/en/shop", target: null }], primary_html: "" },
  };
  // A row shaped the way `tableList` returns one: platform columns plus the
  // declared fields. If the templates ever read a field the declaration does
  // not carry, the rendered output loses it and an assertion below turns red.
  const product = {
    id: "ttr_1", slug: "oak-desk", site_id: "default", lang_group: "ttr_1", status: "published",
    created_at: 1750000000, updated_at: 1750000000,
    name: "Oak Desk", blurb: "Solid white oak, hand-finished.", price: 1200, stock: 4,
    in_stock: 1, released_on: "2025-03-01",
  };

  const archive = await render("archive-product.html", { ...base, products: [product] });
  checkTruthy("archive inherits the layout", archive.includes('class="brand"'));
  checkTruthy("archive renders the product name", archive.includes("Oak Desk"));
  // The item link must come from the route's own path. Hard-coding `/blog/`
  // sent every product link to a 404 and returned 200 while doing it.
  checkTruthy("archive links to the route's own path", archive.includes('href="/en/shop/oak-desk"'));
  checkTruthy("archive links are not hard-coded to /blog/", !archive.includes("/blog/"));
  checkTruthy("the number helper formats the price", archive.includes("1,200"));
  checkTruthy("the truthy branch of in_stock renders", archive.includes("In stock"));
  checkTruthy("no template syntax leaked into the output", !archive.includes("{{"));

  const archiveEmpty = await render("archive-product.html", { ...base, products: [] });
  checkTruthy("the empty archive takes the empty branch", archiveEmpty.includes("No products yet"));

  const single = await render("single-product.html", { ...base, page: { ...base.page, title: "Shop" }, post: product });
  checkTruthy("single renders the name", single.includes("Oak Desk"));
  checkTruthy("single renders the price", single.includes("1,200"));
  checkTruthy("single shows the stock count", single.includes(">4<"));
  checkTruthy("single shows the release date", single.includes("2025-03-01"));
  checkTruthy("single links back to the shop route", single.includes('href="/en/shop"'));

  const soldOut = await render("single-product.html", { ...base, post: { ...product, in_stock: 0 } });
  checkTruthy("the sold-out branch renders", soldOut.includes("Currently sold out"));
  checkTruthy("sold out does not offer the buy button", !soldOut.includes(">Buy<"));

  // A one-object miss must render the not-found branch — not the listing.
  const miss = await render("single-product.html", { ...base, post: null });
  checkTruthy("a missing product renders the not-found branch", miss.includes("could not be found"));

  const home = await render("index.html", {
    ...base,
    posts: [{ slug: "hello", title: "Hello", excerpt: "First.", created_at: 1750000000, url: "/en/journal/hello" }],
  });
  checkTruthy("index renders the post list", home.includes("Hello"));
  // `@first` is bound to the iteration scope, not the item; getting it wrong
  // means the branch silently never renders.
  checkTruthy("index honours @first in the iteration scope", home.includes("Latest"));
  checkTruthy("index did not take the empty branch", !home.includes("Nothing published yet"));

  const homeEmpty = await render("index.html", { ...base, posts: [] });
  checkTruthy("index takes the empty branch with no posts", homeEmpty.includes("Nothing published yet"));

  // Triple braces: the engine escapes by default and the body lives on the item.
  const page = await render("page.html", { ...base, post: { html: "<p>Hi</p>" } });
  checkTruthy("page emits the body unescaped", page.includes("<p>Hi</p>"));

  const notFound = await render("404.html", { ...base });
  checkTruthy("404 renders", notFound.includes("Page not found"));
  checkTruthy("404 links back to the locale root", notFound.includes('href="/en"'));

  summary();
  return fail === 0 ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error("Harness error:", (e && e.message) || e);
  console.error(String((e && e.stack) || "").split("\n").slice(0, 8).join("\n"));
  // Record it as a failure so the summary is both present and truthful.
  fail++;
  failures.push(`harness threw: ${(e && e.message) || e}`);
  summary("aborted");
  code = 2;
}
process.exit(code);
