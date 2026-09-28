/**
 * End-to-end integration test for the theme system.
 *
 * Runs the REAL Worker source (compiled from TypeScript) against the REAL
 * local D1 database and a real R2 replacement, driving the full chain:
 *
 *   upload theme ZIP -> validate manifest -> activate -> apply capabilities
 *     -> resolve template (hierarchy) -> render (engine) -> HTTP response
 *
 * Usage: node tests/theme-integration.test.mjs
 * Requires: `wrangler d1 migrations apply cfpress --local` to have been run.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { zipSync, strToU8 } from "fflate";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const require = createRequire(pathToFileURL(join(root, "package.json")));

let pass = 0, fail = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else {
    fail++; failures.push(name);
    console.log(`  FAIL ${name}\n       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`);
  }
}
function checkTruthy(name, v) {
  if (v) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name} (got ${JSON.stringify(v)})`); }
}

// ---------------------------------------------------------------------------
// Compile the Worker sources into one ESM bundle
// ---------------------------------------------------------------------------
async function compileWorker() {
  const esbuild = require("esbuild");
  const out = await esbuild.build({
    entryPoints: [join(root, "src/index.ts")],
    bundle: true,
    format: "esm",
    target: "es2022",
    write: false,
    platform: "neutral",
    external: ["cloudflare:workers"],
    logLevel: "silent",
  });
  const code = out.outputFiles[0].text;
  const tmp = join(root, ".wrangler", "test-bundle.mjs");
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, code);
  return import(pathToFileURL(tmp).href + "?t=" + Date.now());
}

// ---------------------------------------------------------------------------
// A D1-shaped adapter over node:sqlite
// ---------------------------------------------------------------------------
function makeD1(sqlite) {
  return {
    prepare(sql) {
      const stmt = { sql, params: [] };
      const api = {
        bind(...args) { stmt.params = args; return api; },
        async first(col) {
          const row = sqlite.prepare(stmt.sql).get(...stmt.params);
          if (col !== undefined && row) return row[col];
          return row ?? null;
        },
        async all() {
          const rows = sqlite.prepare(stmt.sql).all(...stmt.params);
          return { results: rows, success: true, meta: {} };
        },
        async run() {
          const r = sqlite.prepare(stmt.sql).run(...stmt.params);
          return { success: true, meta: { changes: r.changes, last_row_id: r.lastInsertRowid } };
        },
      };
      return api;
    },
    async batch(stmts) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
    async exec(sql) { sqlite.exec(sql); return { success: true }; },
  };
}

// ---------------------------------------------------------------------------
// A minimal in-memory R2
// ---------------------------------------------------------------------------
function makeR2() {
  const store = new Map();
  return {
    async get(key) {
      if (!store.has(key)) return null;
      const entry = store.get(key);
      return {
        async text() { return typeof entry.body === "string" ? entry.body : new TextDecoder().decode(entry.body); },
        body: entry.body,
        httpEtag: '"test"',
        writeHttpMetadata() {},
      };
    },
    async put(key, value, opts) {
      let body = value;
      if (value && typeof value.arrayBuffer === "function") body = new Uint8Array(await value.arrayBuffer());
      else if (value && typeof value.getReader === "function") {
        const chunks = [];
        const reader = value.getReader();
        for (;;) { const { done, value: v } = await reader.read(); if (done) break; chunks.push(v); }
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const merged = new Uint8Array(total);
        let off = 0; for (const c of chunks) { merged.set(c, off); off += c.length; }
        body = merged;
      }
      store.set(key, { body, opts });
      return { key };
    },
    async delete(key) { store.delete(key); },
    _dump: () => [...store.keys()],
  };
}

// ---------------------------------------------------------------------------
// Server harness
// ---------------------------------------------------------------------------
function makeEnv(sqlite) {
  return {
    DB: makeD1(sqlite),
    MEDIA: makeR2(),
    CACHE: (() => {
      const m = new Map();
      return { async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); } };
    })(),
    ASSETS: { async fetch() { return new Response("asset", { status: 200 }); } },
  };
}

async function req(worker, env, path, init) {
  const request = new Request("http://localhost" + path, init);
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  return worker.fetch(request, env, ctx);
}

// ---------------------------------------------------------------------------
// Theme package builder
// ---------------------------------------------------------------------------
function buildThemeZip(name) {
  const manifest = {
    name,
    title: "Real Estate",
    version: "1.0.0",
    supports: ["blocks", "menus"],
    templates: ["base", "index", "archive-property", "single-property", "404"],
    parts: ["header", "footer"],
    postTypes: [{
      name: "property", label: "Property",
      labels: { singular: "Property", plural: "Properties" },
      supports: ["title", "editor"], hasArchive: true, rewrite: { slug: "properties" },
    }],
    taxonomies: [{ name: "city", label: "City", postTypes: ["property"], hierarchical: true }],
    fields: [
      { key: "price", label: "Price", type: "number", postTypes: ["property"], required: true },
      { key: "area", label: "Area", type: "number", postTypes: ["property"] },
    ],
    routes: [
      { path: "/properties", template: "archive-property", query: { type: "property", limit: 12 } },
      { path: "/properties/:slug", template: "single-property", resolve: { type: "property", by: "slug" } },
    ],
    adminMenus: [
      { id: "properties", label: "Properties", screen: "content-list", args: { type: "property" } },
      { id: "theme-options", label: "Theme Options", screen: "theme-settings" },
    ],
    // Block names are plain identifiers, not namespaced paths: the platform
    // reserves `core/` for its own built-ins (`src/rendering/blocks.ts`), and a
    // declared block becomes a row keyed by `name` alone. A slash here is
    // rejected by the manifest validator before install.
    blocks: [{ name: "property-card", title: "Property Card", template: "parts/card" }],
    settings: [
      { key: "accent", label: "Accent colour", type: "color", default: "#0b5fff" },
      { key: "currency", label: "Currency", type: "text", default: "¥" },
    ],
    capabilities: ["content.read", "content.write", "routes.register"],
    runtime: "declarative",
  };

  const base = `<!doctype html><html lang="{{site.locale}}"><head><meta charset="utf-8"><title>{{page.title}} | {{site.title}}</title></head><body><header>CFPRESS-THEME-ACTIVE</header><main>{{@section "content"}}</main><footer>end</footer></body></html>`;

  // Demonstrates: inheritance, loops, conditionals, custom fields, helpers.
  const archive = `{{@extends "base"}}{{@section "content"}}
<h1>Properties</h1>
{{#if properties}}
<ul class="listing">
{{#each properties as p}}
  <li data-slug="{{p.slug}}">
    <a href="/{{locale}}/properties/{{p.slug}}">{{p.title}}</a>
    {{#if p.meta.price}}<span class="price">{{number(p.meta.price)}}</span>{{/if}}
    {{#if p.meta.area}}<span class="area">{{p.meta.area}} m2</span>{{/if}}
  </li>
{{/each}}
</ul>
{{else}}
<p class="empty">No properties found.</p>
{{/if}}
<p class="count">Total: {{len(properties)}}</p>
{{/section}}`;

  const single = `{{@extends "base"}}{{@section "content"}}
{{#if post}}
<article data-slug="{{post.slug}}">
  <h1>{{post.title}}</h1>
  {{#if post.meta.price}}<p class="price">{{number(post.meta.price)}}</p>{{/if}}
  <div class="body">{{{post.html}}}</div>
</article>
{{else}}
<h1>Property not found</h1>
{{/if}}
{{/section}}`;

  const notFound = `<!doctype html><html><head><title>Not Found</title></head><body><h1>404 — custom template</h1></body></html>`;

  const index = `{{@extends "base"}}{{@section "content"}}
<h1>Welcome</h1>
{{#each posts as post}}<article><a href="{{post.url}}">{{post.title}}</a></article>{{/each}}
{{/section}}`;

  const files = {
    "theme.json": strToU8(JSON.stringify(manifest, null, 2)),
    "templates/base.html": strToU8(base),
    "templates/index.html": strToU8(index),
    "templates/archive-property.html": strToU8(archive),
    "templates/single-property.html": strToU8(single),
    "templates/404.html": strToU8(notFound),
  };
  return zipSync(files);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const dbFile = join(root, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
  // Wrangler stores local D1 in a sqlite file inside that directory.
  let sqlitePath = null;
  if (existsSync(dbFile)) {
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(dbFile).filter((f) => f.endsWith(".sqlite"));
    if (files.length) sqlitePath = join(dbFile, files[0]);
  }
  if (!sqlitePath) {
    console.error("Local D1 database not found. Run: npx wrangler d1 migrations apply cfpress --local");
    process.exit(2);
  }
  console.log(`Using local D1: ${sqlitePath}\n`);

  const sqlite = new DatabaseSync(sqlitePath);
  const worker = (await compileWorker()).default;
  const env = makeEnv(sqlite);

  // Make the run idempotent: clear anything a previous run left behind.
  for (const sql of [
    "DELETE FROM post_meta WHERE post_id='prop_1'",
    "DELETE FROM post_translations WHERE post_id='prop_1'",
    "DELETE FROM posts WHERE id='prop_1'",
    "DELETE FROM theme_installs WHERE name='realestate'",
    "DELETE FROM extension_versions WHERE extension_name='realestate'",
    "DELETE FROM post_types WHERE declared_by_theme='realestate'",
    "DELETE FROM taxonomies WHERE declared_by_theme='realestate'",
    "DELETE FROM field_defs WHERE declared_by_theme='realestate'",
    "DELETE FROM theme_routes WHERE declared_by_theme='realestate'",
    "DELETE FROM theme_admin_menus WHERE declared_by_theme='realestate'",
    "DELETE FROM theme_blocks WHERE declared_by_theme='realestate'",
  ]) {
    try { sqlite.exec(sql); } catch { /* table may not exist yet */ }
  }

  // -- 1. bootstrap + login ------------------------------------------------
  console.log("1. Admin bootstrap & auth");
  await req(worker, env, "/api/v1/health");
  await req(worker, env, "/api/v1/auth/me"); // triggers bootstrapAdmin

  const loginRes = await req(worker, env, "/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "change-me-now" }),
  });
  const loginBody = await loginRes.json();
  checkTruthy("admin can log in", loginBody.user);
  const cookie = loginRes.headers.get("set-cookie")?.split(";")[0] ?? "";
  checkTruthy("session cookie issued", cookie.startsWith("cfpress_session="));

  const authHeaders = { Cookie: cookie };

  // -- 2. install the theme ------------------------------------------------
  console.log("\n2. Theme install (ZIP upload)");
  const zip = buildThemeZip("realestate");
  const fd = new FormData();
  fd.append("file", new File([zip], "realestate.zip", { type: "application/zip" }));
  const upRes = await req(worker, env, "/api/v1/extensions/themes/upload", {
    method: "POST", headers: authHeaders, body: fd,
  });
  const upBody = await upRes.json();
  if (upRes.status !== 201) console.log("       upload response:", JSON.stringify(upBody));
  check("upload accepted", upRes.status, 201);
  check("theme name parsed", upBody.name, "realestate");
  checkTruthy("files stored", upBody.files >= 5);

  // Verify R2 actually holds the unpacked templates.
  const r2Keys = env.MEDIA._dump();
  checkTruthy("base.html stored in R2", r2Keys.some((k) => k.endsWith("templates/base.html")));
  checkTruthy("archive-property.html stored", r2Keys.some((k) => k.endsWith("templates/archive-property.html")));

  // -- 3. activate: capabilities materialise -------------------------------
  console.log("\n3. Theme activation -> business capabilities applied");
  const actRes = await req(worker, env, "/api/v1/extensions/themes/realestate/activate", {
    method: "POST", headers: authHeaders,
  });
  const actBody = await actRes.json();
  check("activation ok", actBody.ok, true);
  check("post types applied", actBody.applied.postTypes, 1);
  check("taxonomies applied", actBody.applied.taxonomies, 1);
  check("fields applied", actBody.applied.fields, 2);
  check("routes applied", actBody.applied.routes, 2);
  check("admin menus applied", actBody.applied.adminMenus, 2);
  check("blocks applied", actBody.applied.blocks, 1);
  check("settings applied", actBody.applied.settings, 2);

  const ptRes = await req(worker, env, "/api/v1/theme/post-types", { headers: authHeaders });
  const ptBody = await ptRes.json();
  check("CPT readable via API", ptBody.items.map((x) => x.name), ["property"]);
  check("CPT rewrite slug", ptBody.items[0].rewrite_slug, "properties");
  check("CPT supports parsed", ptBody.items[0].supports, ["title", "editor"]);

  const menuRes = await req(worker, env, "/api/v1/theme/menus", { headers: authHeaders });
  const menuBody = await menuRes.json();
  check("admin menus readable", menuBody.items.map((x) => x.menu_id).sort(), ["properties", "theme-options"]);
  check("admin menu args parsed", menuBody.items.find((x) => x.menu_id === "properties").args, { type: "property" });

  // -- 4. create CPT content + custom fields -------------------------------
  console.log("\n4. Custom post type content + custom fields");
  const nowSecs = Math.floor(Date.now() / 1000);
  env.DB.prepare("INSERT INTO posts(id,site_id,author_id,type,slug,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .bind("prop_1", "default", "user_admin", "property", "sea-view-villa", "published", nowSecs, nowSecs).run();
  env.DB.prepare("INSERT INTO post_translations(id,post_id,locale,title,excerpt,content,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .bind("pt_1", "prop_1", "en", "Sea View Villa", "A lovely villa", JSON.stringify([{ type: "core/paragraph", attrs: { text: "Three bedrooms by the sea." } }]), nowSecs, nowSecs).run();
  await env.DB.prepare("INSERT INTO post_meta(post_id,meta_key,meta_value,updated_at) VALUES(?,?,?,?)")
    .bind("prop_1", "price", "4800000", nowSecs).run();
  await env.DB.prepare("INSERT INTO post_meta(post_id,meta_key,meta_value,updated_at) VALUES(?,?,?,?)")
    .bind("prop_1", "area", "186", nowSecs).run();

  // -- 5. template hierarchy + rendering -----------------------------------
  console.log("\n5. Template hierarchy resolution & rendering");

  // Home -> index.html
  const homeRes = await req(worker, env, "/en");
  const homeHtml = await homeRes.text();
  check("home uses theme (not fallback)", homeRes.headers.get("X-CFPress-Template"), "index");
  checkTruthy("home rendered theme header", homeHtml.includes("CFPRESS-THEME-ACTIVE"));

  // 404 -> 404.html
  const nfRes = await req(worker, env, "/en/does-not-exist");
  const nfHtml = await nfRes.text();
  check("404 status", nfRes.status, 404);
  check("404 uses custom template", nfRes.headers.get("X-CFPress-Template"), "404");
  checkTruthy("404 content", nfHtml.includes("404 — custom template"));

  // -- 5b. locale-prefix routing -------------------------------------------
  // Regression: the front-end router used to require a 2-letter first segment
  // and hand everything else to the asset layer. That made the site's own root
  // URL (`/`) unreachable — it was served by a leftover static placeholder
  // instead of the theme, which looks exactly like "the theme is broken".
  // A path without a locale must resolve against the site's default locale.
  console.log("\n5b. Locale-prefix routing (prefixed and unprefixed)");

  // Root path must reach the theme, not the asset layer.
  const rootRes = await req(worker, env, "/");
  check("unprefixed / renders a theme template", rootRes.headers.get("X-CFPress-Template"), "index");
  checkTruthy(
    "unprefixed / is not the static placeholder",
    !(await rootRes.text()).includes("Open Admin")
  );

  // The same routes must resolve identically with and without the prefix.
  for (const [bare, prefixed] of [
    ["/does-not-exist", "/en/does-not-exist"],
  ]) {
    const a = await req(worker, env, bare);
    const b = await req(worker, env, prefixed);
    check(`unprefixed ${bare} matches prefixed`, a.headers.get("X-CFPress-Template"), b.headers.get("X-CFPress-Template"));
    check(`unprefixed ${bare} status matches`, a.status, b.status);
  }

  // A non-locale first segment must NOT be swallowed as a locale. `/admin` is
  // the admin SPA: it belongs to the asset layer, and must never be rendered
  // through the theme (which is what happened when the locale parser was the
  // only thing standing between the SPA and the theme router).
  const adminRes = await req(worker, env, "/admin/admin.css");
  checkTruthy(
    "admin assets are not rendered by the theme",
    adminRes.headers.get("X-CFPress-Template") === null
  );

  // -- 6. engine features inside a real rendered page ----------------------
  console.log("\n6. Engine features in production rendering");
  // Drive the real uploaded R2 templates through the real engine with a
  // realistic scope, so loops / custom fields / helpers are all exercised.
  const { renderTemplateSource } = await importEngine();
  const archiveSrc = await (await env.MEDIA.get("extensions/themes/realestate/1.0.0/files/templates/archive-property.html")).text();
  const loaded = {
    base: await (await env.MEDIA.get("extensions/themes/realestate/1.0.0/files/templates/base.html")).text(),
  };
  const scope = {
    site: { title: "CFPress", locale: "en" },
    page: { title: "Properties" },
    locale: "en",
    properties: [
      { slug: "sea-view-villa", title: "Sea View Villa", meta: { price: "4800000", area: "186" } },
      { slug: "city-loft", title: "City Loft", meta: { price: "2200000", area: "94" } },
    ],
  };
  const archiveHtml = await renderTemplateSource(archiveSrc, scope, {
    loadTemplate: async (n) => loaded[n] ?? null,
  });
  checkTruthy("archive renders inherited layout", archiveHtml.includes("CFPRESS-THEME-ACTIVE"));
  checkTruthy("archive loops both properties", archiveHtml.includes("Sea View Villa") && archiveHtml.includes("City Loft"));
  checkTruthy("archive formats number helper", archiveHtml.includes("4,800,000"));
  checkTruthy("archive renders area field", archiveHtml.includes("186 m2"));
  checkTruthy("archive renders count helper", archiveHtml.includes("Total: 2"));

  // Empty-state branch
  const emptyHtml = await renderTemplateSource(archiveSrc, { ...scope, properties: [] }, {
    loadTemplate: async (n) => loaded[n] ?? null,
  });
  checkTruthy("archive empty branch", emptyHtml.includes("No properties found."));
  checkTruthy("archive empty count is zero", emptyHtml.includes("Total: 0"));

  // Single template with custom fields
  const singleSrc = await (await env.MEDIA.get("extensions/themes/realestate/1.0.0/files/templates/single-property.html")).text();
  const singleHtml = await renderTemplateSource(singleSrc, {
    site: { title: "CFPress", locale: "en" },
    locale: "en",
    post: { slug: "sea-view-villa", title: "Sea View Villa", meta: { price: "4800000" }, html: "<p>Three bedrooms by the sea.</p>" },
  }, { loadTemplate: async (n) => loaded[n] ?? null });
  checkTruthy("single renders post title", singleHtml.includes("Sea View Villa"));
  checkTruthy("single formats price", singleHtml.includes("4,800,000"));
  checkTruthy("single outputs raw html block", singleHtml.includes("<p>Three bedrooms by the sea.</p>"));

  // -- 7. theme switching preserves data -----------------------------------
  console.log("\n7. Theme switch preserves business data");
  await req(worker, env, "/api/v1/extensions/themes/default/activate", { method: "POST", headers: authHeaders });
  const ptAfter = await (await req(worker, env, "/api/v1/theme/post-types", { headers: authHeaders })).json();
  check("CPT hidden after switch", ptAfter.items.length, 0);

  const propRow = await env.DB.prepare("SELECT id FROM posts WHERE id='prop_1'").first();
  checkTruthy("property content preserved (not deleted)", propRow);

  const metaRow = await env.DB.prepare("SELECT meta_value FROM post_meta WHERE post_id='prop_1' AND meta_key='price'").first();
  check("custom field value preserved", metaRow?.meta_value, "4800000");

  // Switch back -> declarations return
  const back = await (await req(worker, env, "/api/v1/extensions/themes/realestate/activate", { method: "POST", headers: authHeaders })).json();
  check("capabilities restored on re-activate", back.applied.postTypes, 1);
  const ptBack = await (await req(worker, env, "/api/v1/theme/post-types", { headers: authHeaders })).json();
  check("CPT visible again", ptBack.items.length, 1);

  // -- 8. missing theme.active setting must not degrade to __fallback__ -----
  // Regression: `activeTheme` used to fall back to the literal string
  // "default" when a site had no `theme.active` row. Because the bundled
  // "default" theme has no R2 files, every page then rendered the bare
  // __fallback__ shell — indistinguishable from a broken theme package.
  // A missing setting must resolve to a theme that is actually installed.
  console.log("\n8. Absent theme.active resolves to a renderable theme");
  const keepSetting = await env.DB.prepare(
    "SELECT value FROM settings WHERE site_id='default' AND key='theme.active'"
  ).first();
  await env.DB.prepare(
    "DELETE FROM settings WHERE site_id='default' AND key='theme.active'"
  ).run();

  const noSettingRes = await req(worker, env, "/en", { headers: authHeaders });
  const noSettingTpl = noSettingRes.headers.get("X-CFPress-Template");
  checkTruthy(
    "no theme.active setting still renders a real template",
    noSettingTpl && noSettingTpl !== "__fallback__" && noSettingTpl !== "__none__"
  );

  // Restore whatever the database had before this check ran.
  if (keepSetting?.value) {
    await env.DB.prepare(
      "INSERT INTO settings(id,site_id,key,value,autoload) VALUES(?,?,?,?,1) " +
      "ON CONFLICT(site_id,key) DO UPDATE SET value=excluded.value"
    ).bind("theme-active-default", "default", "theme.active", String(keepSetting.value)).run();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log("Failed: " + failures.join(", "));
  sqlite.close();
  process.exit(fail === 0 ? 0 : 1);
}

async function importEngine() {
  const esbuild = require("esbuild");
  const src = readFileSync(join(root, "src/rendering/template-engine.ts"), "utf8");
  const out = esbuild.transformSync(src, { loader: "ts", format: "esm", target: "es2022" });
  const tmp = join(root, ".wrangler", "engine.mjs");
  writeFileSync(tmp, out.code);
  return import(pathToFileURL(tmp).href + "?t=" + Date.now());
}

main().catch((e) => {
  const stack = String((e && e.stack) || "").split("\n").slice(0, 8).join("\n");
  console.error("Harness error:", (e && e.message) || e);
  console.error(stack);
  process.exit(2);
});
