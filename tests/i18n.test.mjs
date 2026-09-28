/**
 * Multi-language contract test — the eight assertions of ARCHITECTURE.md §5.4①.
 *
 *   - a monolingual site gets **no** `_i18n` table
 *   - enabling a second language creates it
 *   - single-language reads ignore the `locale` argument
 *   - a missing translation falls back to the site default (never empty, never an error)
 *   - an explicitly prefixed `/en/x` that does not exist returns 404, with no fallback
 *   - an unprefixed `/x` that does not exist tries the site's other languages
 *   - a non-translatable field (`price`) is identical in every language
 *   - a translatable field (`name`) differs per language
 *
 * The last two are the point of the whole design: they prove the
 * `translatable` split actually decides which data is language-dependent. A
 * `price` that differs per language is a shop that charges 20% less in English.
 *
 * Usage: node tests/i18n.test.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
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

const THEME = "eshoptheme";
const MAIN_TABLE = `theme_${THEME}_product`;
const I18N_TABLE = `${MAIN_TABLE}_i18n`;

// ---------------------------------------------------------------------------
// Harness (mirrors multisite.test.mjs)
// ---------------------------------------------------------------------------
async function compileWorker() {
  const esbuild = require("esbuild");
  const out = await esbuild.build({
    entryPoints: [join(root, "src/index.ts")],
    bundle: true, format: "esm", target: "es2022", write: false,
    platform: "neutral", external: ["cloudflare:workers"], logLevel: "silent",
  });
  const tmp = join(root, ".wrangler", "i18n-bundle.mjs");
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, out.outputFiles[0].text);
  return import(pathToFileURL(tmp).href + "?t=" + Date.now());
}

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
    async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; },
    async exec(sql) { sqlite.exec(sql); return { success: true }; },
  };
}

function makeR2() {
  const store = new Map();
  return {
    async get(key) {
      if (!store.has(key)) return null;
      const entry = store.get(key);
      return {
        async text() { return typeof entry.body === "string" ? entry.body : new TextDecoder().decode(entry.body); },
        body: entry.body, httpEtag: '"test"', writeHttpMetadata() {},
      };
    },
    async put(key, value) {
      let body = value;
      if (value && typeof value.arrayBuffer === "function") body = new Uint8Array(await value.arrayBuffer());
      else if (value && typeof value.getReader === "function") {
        const chunks = []; const reader = value.getReader();
        for (;;) { const { done, value: v } = await reader.read(); if (done) break; chunks.push(v); }
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const merged = new Uint8Array(total); let off = 0;
        for (const c of chunks) { merged.set(c, off); off += c.length; }
        body = merged;
      }
      store.set(key, { body });
      return { key };
    },
    async delete(key) { store.delete(key); },
    _dump: () => [...store.keys()],
  };
}

function makeEnv(sqlite) {
  const kv = new Map();
  return {
    DB: makeD1(sqlite),
    MEDIA: makeR2(),
    CACHE: {
      async get(k) { return kv.has(k) ? kv.get(k) : null; },
      async put(k, v) { kv.set(k, v); },
      async delete(k) { kv.delete(k); },
    },
    ASSETS: { async fetch() { return new Response("asset", { status: 200 }); } },
    _kv: kv,
  };
}

async function req(worker, env, path, init = {}, host = "localhost") {
  const request = new Request(`http://${host}${path}`, init);
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  return worker.fetch(request, env, ctx);
}

/**
 * A theme that declares one business table with both kinds of field.
 *
 * `price` and `sku` are language-independent; `name` and `description` are
 * translatable. That split is the thing under test.
 */
function buildEshopZip() {
  const manifest = {
    name: THEME,
    title: "EShop theme",
    version: "1.0.0",
    templates: ["index", "page", "single", "archive", "404"],
    tables: [
      {
        name: "product",
        label: "Product",
        translatable: ["name", "description"],
        fields: [
          { key: "price", type: "number", label: "Price" },
          { key: "sku", type: "text", label: "SKU" },
          { key: "name", type: "text", label: "Name" },
          { key: "description", type: "longtext", label: "Description" },
        ],
      },
    ],
    runtime: "declarative",
  };
  const tpl = (body) => strToU8(`<!doctype html><html><head><title>{{page.title}}</title></head><body>${body}</body></html>`);
  return zipSync({
    "theme.json": strToU8(JSON.stringify(manifest, null, 2)),
    "templates/index.html": tpl(`<h1>ESHOP-INDEX</h1><span class="locale">{{locale}}</span>`),
    "templates/page.html": tpl(`<h1 class="page-title">{{page.title}}</h1><span class="locale">{{locale}}</span>`),
    "templates/single.html": tpl(`<h1 class="single-title">{{post.title}}</h1>`),
    "templates/archive.html": tpl(`<h1>ESHOP-ARCHIVE</h1>`),
    "templates/404.html": tpl(`<h1>ESHOP-404</h1><span class="locale">{{locale}}</span>`),
    "langs/en.json": strToU8(JSON.stringify({ "theme.eshoptheme.title": "Shop" })),
    "langs/zh-CN.json": strToU8(JSON.stringify({ "theme.eshoptheme.title": "商店" })),
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const d1Dir = join(root, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
  if (!existsSync(d1Dir)) {
    console.error("Local D1 not found. Run: npx wrangler d1 migrations apply cfpress --local");
    process.exit(2);
  }
  const files = readdirSync(d1Dir).filter((f) => f.endsWith(".sqlite"));
  if (!files.length) {
    console.error("Local D1 sqlite file not found.");
    process.exit(2);
  }
  const sqlite = new DatabaseSync(join(d1Dir, files[0]));
  const env = makeEnv(sqlite);
  const worker = (await compileWorker()).default;

  const tableNames = () =>
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);

  // -- idempotent cleanup -------------------------------------------------
  // Runs before anything else and covers every id prefix this suite can leave
  // behind, including the generated tables themselves — a leftover `_i18n`
  // table would make the "monolingual creates no _i18n table" assertion pass
  // for the wrong reason on the next run.
  const previousActive = sqlite.prepare("SELECT value FROM settings WHERE site_id='default' AND key='theme.active'").get()?.value ?? null;
  sqlite.exec(`DROP TABLE IF EXISTS ${I18N_TABLE}`);
  sqlite.exec(`DROP TABLE IF EXISTS ${MAIN_TABLE}`);
  sqlite.exec(`DELETE FROM theme_table_defs WHERE theme_name='${THEME}'`);
  sqlite.exec(`DELETE FROM theme_installs WHERE name='${THEME}'`);
  sqlite.exec(`DELETE FROM extension_versions WHERE extension_name='${THEME}'`);
  sqlite.exec("DELETE FROM post_meta WHERE post_id IN (SELECT id FROM posts WHERE slug LIKE 'i18n-%')");
  sqlite.exec("DELETE FROM post_revisions WHERE post_id IN (SELECT id FROM posts WHERE slug LIKE 'i18n-%')");
  sqlite.exec("DELETE FROM post_translations WHERE post_id IN (SELECT id FROM posts WHERE slug LIKE 'i18n-%')");
  sqlite.exec("DELETE FROM posts WHERE slug LIKE 'i18n-%'");
  sqlite.exec("DELETE FROM scheduled_posts WHERE post_id NOT IN (SELECT id FROM posts)");
  sqlite.exec("DELETE FROM site_locales WHERE code='zh-CN'");
  sqlite.exec("DELETE FROM i18n_overrides WHERE site_id='default' AND key LIKE 'core.%'");
  sqlite.exec("DELETE FROM locales WHERE code='zh-CN'");
  sqlite.exec("DELETE FROM settings WHERE site_id='default' AND key='i18n.defaultLocale'");

  console.log("\n0. Admin bootstrap & auth");
  const loginRes = await req(worker, env, "/api/v1/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "change-me-now" }),
  });
  const cookie = (loginRes.headers.getSetCookie?.() ?? [loginRes.headers.get("set-cookie")])[0].split(";")[0];
  const auth = { cookie, "Content-Type": "application/json" };
  check("login", loginRes.status, 200);

  // -- 1. L0: a fresh site is monolingual ---------------------------------
  console.log("\n1. L0 — site switch");
  const before = await (await req(worker, env, "/api/v1/i18n/locales", { headers: auth })).json();
  check("default locale is the site's own", before.default, "en");
  check("one language enabled", before.enabled.length, 1);
  check("not multilingual", before.multilingual, false);
  checkTruthy("core packs are offered for the interface", before.core_locales.includes("zh-CN"));

  // -- 2. install + activate a theme that declares a business table --------
  console.log("\n2. Theme-owned table, monolingual");
  const form = new FormData();
  form.append("name", THEME);
  form.append("file", new Blob([buildEshopZip()], { type: "application/zip" }), `${THEME}.zip`);
  const up = await req(worker, env, "/api/v1/extensions/themes/upload", { method: "POST", headers: { cookie }, body: form });
  check("theme uploads", up.status, 201);
  const act = await (await req(worker, env, `/api/v1/extensions/themes/${THEME}/activate`, { method: "POST", headers: auth })).json();
  check("theme activates", act.ok, true);
  check("declared table was generated", act.applied?.tables, 1);

  const names1 = tableNames();
  checkTruthy("main table exists", names1.includes(MAIN_TABLE));
  // ← the load-bearing assertion of the whole "platform switch" requirement
  check("no _i18n table while monolingual", names1.includes(I18N_TABLE), false);

  const tt1 = await (await req(worker, env, "/api/v1/theme-tables", { headers: auth })).json();
  check("table is registered", tt1.items.map((d) => d.logical_name), ["product"]);
  check("registered without a translation table", tt1.items[0].i18n_table, null);

  // Single-language write and read.
  const saved1 = await (await req(worker, env, "/api/v1/theme-tables/product", {
    method: "POST", headers: auth,
    body: JSON.stringify({ slug: "solo", price: 99, sku: "SOLO-1", name: "Solo", description: "Only one language" }),
  })).json();
  check("single-language save", saved1.ok, true);
  check("value stored", saved1.row.name, "Solo");
  const read1 = await (await req(worker, env, "/api/v1/theme-tables/product/solo?locale=zh-CN", { headers: auth })).json();
  // `zh-CN` is not even enabled yet; a single-language read ignores `locale`
  // entirely rather than returning nothing.
  check("single-language read ignores locale", read1.row.name, "Solo");
  check("non-translatable field round-trips", read1.row.price, 99);

  // -- 3. enabling a second language creates the translation table --------
  console.log("\n3. Enabling a second language");
  const en = await (await req(worker, env, "/api/v1/i18n/locales", {
    method: "POST", headers: auth,
    body: JSON.stringify({ code: "zh-CN", name: "Simplified Chinese", native_name: "简体中文" }),
  })).json();
  check("locale enabled", en.ok, true);
  check("the switch created the translation table", en.created_i18n_tables, [I18N_TABLE]);
  checkTruthy("translation table now exists", tableNames().includes(I18N_TABLE));

  const after = await (await req(worker, env, "/api/v1/i18n/locales", { headers: auth })).json();
  check("site is multilingual now", after.multilingual, true);
  check("default unchanged by the new language", after.default, "en");
  check("both languages listed", after.enabled, ["en", "zh-CN"]);

  // -- 4. translatable vs non-translatable -------------------------------
  console.log("\n4. translatable decides what is language-dependent");
  await req(worker, env, "/api/v1/theme-tables/product?locale=en", {
    method: "POST", headers: auth,
    body: JSON.stringify({ slug: "iphone-15", price: 299, sku: "IP15", name: "iPhone 15", description: "A phone" }),
  });
  await req(worker, env, "/api/v1/theme-tables/product?locale=zh-CN", {
    method: "POST", headers: auth,
    body: JSON.stringify({ slug: "iphone-15", price: 299, sku: "IP15", name: "iPhone 15（中文）", description: "一部手机" }),
  });

  const enRow = await (await req(worker, env, "/api/v1/theme-tables/product/iphone-15?locale=en", { headers: auth })).json();
  const zhRow = await (await req(worker, env, "/api/v1/theme-tables/product/iphone-15?locale=zh-CN", { headers: auth })).json();

  check("same row, not two products", enRow.row.id, zhRow.row.id);
  // ← the two assertions this whole design exists for
  check("price is identical in both languages", zhRow.row.price, enRow.row.price);
  check("price is the declared value", enRow.row.price, 299);
  check("name differs per language", zhRow.row.name, "iPhone 15（中文）");
  check("english name is its own", enRow.row.name, "iPhone 15");
  check("description differs per language", zhRow.row.description, "一部手机");
  check("sku (non-translatable) is shared", zhRow.row.sku, enRow.row.sku);

  // -- 5. fallback: missing translation → site default, never empty -------
  console.log("\n5. Missing translation falls back");
  await req(worker, env, "/api/v1/theme-tables/product?locale=en", {
    method: "POST", headers: auth,
    body: JSON.stringify({ slug: "only-english", price: 10, name: "English only" }),
  });
  const fb = await (await req(worker, env, "/api/v1/theme-tables/product/only-english?locale=zh-CN", { headers: auth })).json();
  check("falls back to the site default language", fb.row.name, "English only");
  checkTruthy("row is not empty", !!fb.row.id);
  const listZh = await (await req(worker, env, "/api/v1/theme-tables/product?locale=zh-CN", { headers: auth })).json();
  check("listing does not error on untranslated rows", listZh.items.length, 3);

  // -- 6. URL semantics: explicit prefix 404s, unprefixed falls through ----
  console.log("\n6. URL semantics");
  await req(worker, env, "/api/v1/pages", {
    method: "POST", headers: auth,
    body: JSON.stringify({ slug: "i18n-zh-only", title: "只有中文", locale: "zh-CN", status: "published", content: "[]" }),
  });
  const zhPage = await req(worker, env, "/zh-CN/i18n-zh-only");
  check("explicit zh-CN finds the page", zhPage.status, 200);
  const enPage = await req(worker, env, "/en/i18n-zh-only");
  check("explicit /en/ misses → 404, no fallback", enPage.status, 404);
  const barePage = await req(worker, env, "/i18n-zh-only");
  check("unprefixed path falls through to another language", barePage.status, 200);

  // -- 7. UI language is independent of content language -------------------
  console.log("\n7. Interface language ≠ content language");
  const off = await (await req(worker, env, "/api/v1/i18n/locales/zh-CN", { method: "DELETE", headers: auth })).json();
  check("zh-CN disabled for the site", off.enabled, ["en"]);
  const afterOff = await (await req(worker, env, "/api/v1/i18n/locales", { headers: auth })).json();
  check("site is monolingual again", afterOff.multilingual, false);
  check("translation table is kept, not dropped", tableNames().includes(I18N_TABLE), true);

  // The site serves English only, yet its owner may still want a Chinese admin.
  const uiSet = await (await req(worker, env, "/api/v1/i18n/ui-locale", {
    method: "POST", headers: auth, body: JSON.stringify({ locale: "zh-CN" }),
  })).json();
  check("admin interface language accepts a language the site does not serve", uiSet.locale, "zh-CN");
  const uiGet = await (await req(worker, env, "/api/v1/i18n/ui-locale", { headers: auth })).json();
  check("preference persists", uiGet.locale, "zh-CN");
  check("and is reported as a personal preference", uiGet.user_preference, "zh-CN");
  const badUi = await (await req(worker, env, "/api/v1/i18n/ui-locale", {
    method: "POST", headers: auth, body: JSON.stringify({ locale: "xx-YY" }),
  })).json();
  checkTruthy("a language with no pack is refused", badUi.error);

  // -- 8. L2 dictionary stack --------------------------------------------
  console.log("\n8. L2 dictionary layers");
  const zhMsgs = await (await req(worker, env, "/api/v1/i18n/messages?locale=zh-CN", { headers: auth })).json();
  check("core pack translates", zhMsgs.messages["core.nav.dashboard"], "仪表盘");
  check("theme pack is layered on top", zhMsgs.messages["theme.eshoptheme.title"], "商店");
  const enMsgs = await (await req(worker, env, "/api/v1/i18n/messages?locale=en", { headers: auth })).json();
  check("english core pack", enMsgs.messages["core.nav.dashboard"], "Dashboard");
  check("english theme pack", enMsgs.messages["theme.eshoptheme.title"], "Shop");

  await req(worker, env, "/api/v1/i18n/overrides", {
    method: "POST", headers: auth,
    body: JSON.stringify({ locale: "en", key: "core.action.save", value: "Save it now" }),
  });
  const overridden = await (await req(worker, env, "/api/v1/i18n/messages?locale=en", { headers: auth })).json();
  check("DB override wins over the core pack", overridden.messages["core.action.save"], "Save it now");
  const unnamespaced = await (await req(worker, env, "/api/v1/i18n/overrides", {
    method: "POST", headers: auth,
    body: JSON.stringify({ locale: "en", key: "nav.home", value: "Home" }),
  })).json();
  checkTruthy("an unnamespaced override key is refused", unnamespaced.error);

  // -- 9. translation groups (L1) ----------------------------------------
  console.log("\n9. Content translation groups");
  // Re-enable zh-CN so the group can hold both versions.
  await req(worker, env, "/api/v1/i18n/locales", {
    method: "POST", headers: auth, body: JSON.stringify({ code: "zh-CN", name: "Simplified Chinese", native_name: "简体中文" }),
  });
  const srcId = String(sqlite.prepare("SELECT id FROM posts WHERE slug='i18n-zh-only' AND site_id='default'").get().id);
  const group0 = await (await req(worker, env, "/api/v1/i18n/translations?id=" + encodeURIComponent(srcId), { headers: auth })).json();
  // One entry per *enabled locale*, not per existing row: the editor's language
  // bar has to offer the versions that do not exist yet — that is the `＋`.
  check("one entry per enabled locale", group0.versions.map((v) => v.locale).sort(), ["en", "zh-CN"]);
  check("the zh-CN version exists", group0.versions.find((v) => v.locale === "zh-CN").exists, true);
  check("the en version does not exist yet", group0.versions.find((v) => v.locale === "en").exists, false);

  const made = await (await req(worker, env, "/api/v1/i18n/translations", {
    method: "POST", headers: auth,
    body: JSON.stringify({ id: srcId, locale: "en", mode: "copy" }),
  })).json();
  check("translation created", made.locale, "en");
  checkTruthy("new post got its own id", made.id !== srcId);
  const dup = await (await req(worker, env, "/api/v1/i18n/translations", {
    method: "POST", headers: auth,
    body: JSON.stringify({ id: srcId, locale: "en", mode: "blank" }),
  })).json();
  checkTruthy("creating the same locale twice is refused", dup.error);

  const group1 = await (await req(worker, env, "/api/v1/i18n/translations?id=" + encodeURIComponent(srcId), { headers: auth })).json();
  check("both versions now exist", group1.versions.filter((v) => v.exists).map((v) => v.locale).sort(), ["en", "zh-CN"]);
  check("they share one group", group1.group, group0.group);
  check("copied translation starts as a draft", group1.versions.find((v) => v.locale === "en").status, "draft");
  checkTruthy("copied translation took a free slug", group1.versions.find((v) => v.locale === "en").slug !== "i18n-zh-only");

  // -- 9b. a self-naming group survives a NULL lang_group -----------------
  // `lang_group` is nullable. A row that has none identifies its group by its
  // own id — and *both* sides of the lookup have to use that same rule. Matching
  // `lang_group = ?` on its own excluded the very row whose id named the group,
  // so the group looked empty: the editor reported the language as missing and
  // offered to create a duplicate of a version that already existed. Any row
  // written before the migration, or by an import that omits the column, lands
  // exactly here.
  console.log("\n9b. A row with no lang_group is still in its own group");
  const soloTs = Math.floor(Date.now() / 1000);
  const soloId = `i18n-solo-${soloTs}`;
  const anyUser = String(sqlite.prepare("SELECT id FROM site_users LIMIT 1").get()?.id ?? "u1");
  sqlite
    .prepare("INSERT INTO posts(id,site_id,author_id,type,slug,status,lang_group,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(soloId, "default", anyUser, "post", "i18n-solo", "draft", null, soloTs, soloTs);
  sqlite
    .prepare("INSERT INTO post_translations(id,post_id,locale,title,excerpt,content,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(`pt-${soloId}`, soloId, "zh-CN", "Solo", "", "[]", soloTs, soloTs);

  const solo = await (await req(worker, env, "/api/v1/i18n/translations?id=" + encodeURIComponent(soloId), { headers: auth })).json();
  check("a row with no lang_group names its own group", solo.group, soloId);
  const selfEntry = (solo.versions ?? []).find((v) => v.locale === "zh-CN");
  check("that row is found inside its own group", selfEntry?.exists, true);
  check("its own id comes back as the version's post", selfEntry?.post_id, soloId);
  const dupSelf = await (await req(worker, env, "/api/v1/i18n/translations", {
    method: "POST", headers: auth,
    body: JSON.stringify({ id: soloId, locale: "zh-CN", mode: "blank" }),
  })).json();
  checkTruthy("a second zh-CN version of it is refused", dupSelf.error);

  // -- restore ------------------------------------------------------------
  // Leave the default site's theme as this suite found it, so the suite is
  // order-independent with respect to the rest of the chain.
  sqlite.exec("DELETE FROM site_locales WHERE code='zh-CN'");
  sqlite.exec("DELETE FROM locales WHERE code='zh-CN'");
  sqlite.exec("DELETE FROM i18n_overrides WHERE site_id='default' AND key='core.action.save'");
  if (previousActive) {
    sqlite.prepare("INSERT INTO settings(id,site_id,key,value,autoload) VALUES(?,?,?,?,1) ON CONFLICT(site_id,key) DO UPDATE SET value=excluded.value")
      .run("setting-theme-active", "default", "theme.active", previousActive);
  }

  console.log(`\n${"=".repeat(64)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (fail) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log(`${fail ? 1 : 0} failure(s)`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
