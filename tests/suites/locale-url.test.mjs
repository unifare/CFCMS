/**
 * Locale URLs — the behaviour tests behind AGENTS.md rules 56-59.
 *
 * Migration 0016 made the URL segment per language:
 *
 *   posts.slug               the default-language slug and the row-wide fallback
 *   post_translations.slug   this locale's own segment; NULL = follow the main table
 *
 * A lookup that forgets the COALESCE compiles fine, serves the default
 * language perfectly, and 404s every language that named its own slug — the
 * exact "I only tested the default language" defect. These tests drive the
 * real compiled Worker over real HTTP, through both storage shapes:
 *
 *   - shared-row  : one posts row carrying an en and a zh translation
 *   - sibling-row : two posts rows sharing a lang_group (the translations endpoint)
 *
 * plus the three multilingual SEO surfaces that read the slugs: hreflang,
 * the per-locale feed, and the sitemap.
 *
 * Usage: node tests/suites/locale-url.test.mjs   (needs the local D1 migrated)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { zipSync, strToU8 } from "fflate";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
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

const THEME = "locurltheme";
const PREFIX = "locurl-";

// ---------------------------------------------------------------------------
// Harness (mirrors i18n.test.mjs)
// ---------------------------------------------------------------------------
async function compileWorker() {
  const esbuild = require("esbuild");
  const out = await esbuild.build({
    entryPoints: [join(root, "src/index.ts")],
    bundle: true, format: "esm", target: "es2022", write: false,
    platform: "neutral", external: ["cloudflare:workers"], logLevel: "silent",
  });
  const tmp = join(root, ".wrangler", "locale-url-bundle.mjs");
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
      store.set(key, { body });
      return { key };
    },
    async delete(key) { store.delete(key); },
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
  };
}

async function req(worker, env, path, init = {}, host = "localhost") {
  const request = new Request(`http://${host}${path}`, init);
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  return worker.fetch(request, env, ctx);
}

/**
 * The theme under test prints the two multilingual surfaces as DATA, so the
 * assertions read the platform's output rather than any styling:
 *
 *   single → one `<a class="alt">` per hreflang alternate
 *   index  → one `<a class="lnav">` per language-switcher entry
 */
function buildThemeZip() {
  const manifest = {
    name: THEME,
    title: "Locale URL theme",
    version: "1.0.0",
    templates: ["index", "page", "single", "archive", "404"],
    runtime: "declarative",
  };
  const tpl = (body) => strToU8(`<!doctype html><html><head><title>{{page.title}}</title></head><body>${body}</body></html>`);
  return zipSync({
    "theme.json": strToU8(JSON.stringify(manifest, null, 2)),
    "templates/index.html": tpl(`<h1>LOCURL-INDEX</h1><span id="langnav">{{#each lang_nav as l}}<a class="lnav{{#if l.current}} on{{/if}}" href="{{l.url}}">{{l.code}}</a>{{/each}}</span><span class="locale">{{locale}}</span>`),
    "templates/page.html": tpl(`<h1 class="page-title">{{page.title}}</h1>`),
    "templates/single.html": tpl(`<h1 class="single-title">{{post.title}}</h1><span id="alts">{{#each post.alternates as alt}}<a class="alt" data-locale="{{alt.locale}}"{{#if alt.default}} data-default="1"{{/if}} href="{{alt.url}}">{{alt.locale}}</a>{{/each}}</span>`),
    "templates/archive.html": tpl(`<h1>LOCURL-ARCHIVE</h1>`),
    "templates/404.html": tpl(`<h1>LOCURL-404</h1>`),
    "langs/en.json": strToU8(JSON.stringify({ [`theme.${THEME}.title`]: "URLs" })),
  });
}

// ---------------------------------------------------------------------------
async function main() {
  const d1Dir = join(root, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
  if (!existsSync(d1Dir)) {
    console.error("Local D1 not found. Run: npx wrangler d1 migrations apply cfpress --local");
    process.exit(2);
  }
  const files = readdirSync(d1Dir).filter((f) => f.endsWith(".sqlite"));
  const sqlite = new DatabaseSync(join(d1Dir, files[0]));
  const env = makeEnv(sqlite);
  const worker = (await compileWorker()).default;

  // -- idempotent cleanup (shared dev D1) ----------------------------------
  // Prefix-scoped to this suite's fixtures only. `theme.active`, the route
  // table and the menu registry are SITE-WIDE and the activation below rewrites
  // them clear-then-insert, so they are snapshotted and restored at the end.
  const previousActive = sqlite.prepare("SELECT value FROM settings WHERE site_id='default' AND key='theme.active'").get()?.value ?? null;
  const previousRoutes = sqlite.prepare("SELECT * FROM theme_routes WHERE site_id='default'").all();
  const previousMenus = sqlite.prepare("SELECT * FROM admin_menu_registry WHERE site_id IN ('default','*')").all();
  const previousSiteLocales = sqlite.prepare("SELECT * FROM site_locales WHERE site_id='default'").all();
  sqlite.exec(`DELETE FROM theme_table_defs WHERE owner_type='theme' AND owner_name='${THEME}'`);
  sqlite.exec(`DELETE FROM theme_installs WHERE name='${THEME}'`);
  sqlite.exec(`DELETE FROM extension_versions WHERE extension_name='${THEME}'`);
  // Leftover content is matched by the main slug OR any translation's
  // per-language slug — a row whose main slug was renamed (by a bug, or by an
  // editor) would otherwise survive every LIKE 'locurl-%' sweep and poison the
  // uniqueness assertions on the next run.
  sqlite.exec(`DELETE FROM post_meta WHERE post_id IN (SELECT id FROM posts WHERE slug LIKE '${PREFIX}%' OR id IN (SELECT post_id FROM post_translations WHERE slug LIKE '${PREFIX}%'))`);
  sqlite.exec(`DELETE FROM post_revisions WHERE post_id IN (SELECT id FROM posts WHERE slug LIKE '${PREFIX}%' OR id IN (SELECT post_id FROM post_translations WHERE slug LIKE '${PREFIX}%'))`);
  sqlite.exec(`DELETE FROM scheduled_posts WHERE post_id IN (SELECT id FROM posts WHERE slug LIKE '${PREFIX}%' OR id IN (SELECT post_id FROM post_translations WHERE slug LIKE '${PREFIX}%'))`);
  sqlite.exec(`DELETE FROM post_translations WHERE post_id IN (SELECT id FROM posts WHERE slug LIKE '${PREFIX}%' OR id IN (SELECT post_id FROM post_translations WHERE slug LIKE '${PREFIX}%'))`);
  sqlite.exec(`DELETE FROM posts WHERE slug LIKE '${PREFIX}%' OR id IN (SELECT post_id FROM post_translations WHERE slug LIKE '${PREFIX}%')`);

  console.log("\n0. Bootstrap, auth, multilingual site, test theme");
  const loginRes = await req(worker, env, "/api/v1/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "change-me-now" }),
  });
  const cookie = (loginRes.headers.getSetCookie?.() ?? [loginRes.headers.get("set-cookie")])[0].split(";")[0];
  const auth = { cookie, "Content-Type": "application/json" };
  check("login", loginRes.status, 200);

  const en = await (await req(worker, env, "/api/v1/i18n/locales", {
    method: "POST", headers: auth,
    body: JSON.stringify({ code: "zh-CN", name: "Simplified Chinese", native_name: "简体中文" }),
  })).json();
  check("zh-CN enabled", en.ok ?? en.locale, true);

  const form = new FormData();
  form.append("name", THEME);
  form.append("file", new Blob([buildThemeZip()], { type: "application/zip" }), `${THEME}.zip`);
  const up = await req(worker, env, "/api/v1/extensions/themes/upload", { method: "POST", headers: { cookie }, body: form });
  check("theme uploads", up.status, 201);
  const act = await (await req(worker, env, `/api/v1/extensions/themes/${THEME}/activate`, { method: "POST", headers: auth })).json();
  check("theme activates", act.ok, true);

  // -- 1. shared-row: one post, two translations, two slugs ----------------
  console.log("\n1. Shared-row per-language slugs");
  const created = await (await req(worker, env, "/api/v1/posts", {
    method: "POST", headers: auth,
    body: JSON.stringify({
      locale: "en", slug: `${PREFIX}hello`, title: "Hello (en)", status: "published",
      content: JSON.stringify([{ type: "core/paragraph", attrs: { text: "English body" } }]),
    }),
  })).json();
  const postId = created.id;
  checkTruthy("post created", Boolean(postId));

  const zhSaved = await (await req(worker, env, `/api/v1/posts/${postId}`, {
    method: "PUT", headers: auth,
    body: JSON.stringify({
      locale: "zh-CN", slug: `${PREFIX}ni-hao`, title: "你好（中文）", status: "published",
      content: JSON.stringify([{ type: "core/paragraph", attrs: { text: "中文正文" } }]),
    }),
  })).json();
  check("zh translation saved on the same row", zhSaved.id, postId);

  const enPage = await req(worker, env, `/en/blog/${PREFIX}hello`);
  check("default-language URL resolves", enPage.status, 200);
  checkTruthy("default-language URL carries the en title", (await enPage.text()).includes("Hello (en)"));

  const zhPage = await req(worker, env, `/zh-CN/blog/${PREFIX}ni-hao`);
  check("the language's own slug resolves", zhPage.status, 200);
  checkTruthy("it carries the zh title", (await zhPage.text()).includes("你好（中文）"));

  const zhOld = await req(worker, env, `/zh-CN/blog/${PREFIX}hello`);
  check("an explicit prefix whose slug belongs to another language 404s (no silent fallback)", zhOld.status, 404);
  const enNew = await req(worker, env, `/en/blog/${PREFIX}ni-hao`);
  check("the zh slug does not leak into en", enNew.status, 404);

  // -- 2. hreflang alternates on the single --------------------------------
  console.log("\n2. hreflang alternates");
  const zhHtml = await (await req(worker, env, `/zh-CN/blog/${PREFIX}ni-hao`)).text();
  const alts = [...zhHtml.matchAll(/<a class="alt" data-locale="([^"]+)"( data-default="1")? href="([^"]+)">/g)].map((m) => ({ locale: m[1], def: Boolean(m[2]), url: m[3] }));
  check(
    "alternates list both language versions with their own slugs",
    alts.map((a) => `${a.locale}:${a.url.replace("http://localhost", "")}`).sort(),
    [`en:/en/blog/${PREFIX}hello`, `zh-CN:/zh-CN/blog/${PREFIX}ni-hao`].sort()
  );
  checkTruthy("exactly one entry is marked x-default", alts.filter((a) => a.def).length === 1);
  check("x-default is the site default language", alts.find((a) => a.def)?.locale, "en");

  // -- 3. the language switcher (index scope) ------------------------------
  console.log("\n3. Language switcher");
  const homeHtml = await (await req(worker, env, "/en")).text();
  const lnav = [...homeHtml.matchAll(/<a class="lnav( on)?" href="([^"]+)">([^<]+)<\/a>/g)].map((m) => ({ code: m[3], url: m[2], on: Boolean(m[1]) }));
  check(
    "switcher offers every enabled locale at the same path",
    lnav.map((l) => `${l.code}:${l.url.replace("http://localhost", "")}${l.on ? "*" : ""}`).sort(),
    [`en:/en*`, `zh-CN:/zh-CN`].sort()
  );

  // -- 4. sibling-row: the translations endpoint ---------------------------
  console.log("\n4. Sibling-row version follows the source slug");
  const sib = await (await req(worker, env, "/api/v1/posts", {
    method: "POST", headers: auth,
    body: JSON.stringify({
      locale: "en", slug: `${PREFIX}sib`, title: "Sibling (en)", status: "published",
      content: JSON.stringify([{ type: "core/paragraph", attrs: { text: "sib" } }]),
    }),
  })).json();
  const sibZh = await (await req(worker, env, "/api/v1/i18n/translations", {
    method: "POST", headers: auth,
    body: JSON.stringify({ id: sib.id, locale: "zh-CN", mode: "blank" }),
  })).json();
  check("sibling version created", sibZh.locale, "zh-CN");
  check("sibling follows the source slug (slugs are per language)", sibZh.slug, `${PREFIX}sib`);
  // The translations endpoint creates siblings as drafts (an untranslated
  // version must never go live by accident), so publish it before probing URLs.
  const pub = await req(worker, env, `/api/v1/posts/${sibZh.id}`, {
    method: "PUT", headers: auth,
    body: JSON.stringify({ locale: "zh-CN", status: "published", title: "Sibling (zh)" }),
  });
  check("sibling publishes", pub.status, 200);
  const sibPage = await req(worker, env, `/zh-CN/blog/${PREFIX}sib`);
  check("the sibling resolves under its own locale", sibPage.status, 200);

  // -- 5. per-locale slug uniqueness ---------------------------------------
  console.log("\n5. Uniqueness is per language");
  const third = await (await req(worker, env, "/api/v1/posts", {
    method: "POST", headers: auth,
    body: JSON.stringify({
      locale: "en", slug: `${PREFIX}third`, title: "Third", status: "draft",
      content: "[]",
    }),
  })).json();
  const clashZh = await req(worker, env, `/api/v1/posts/${third.id}`, {
    method: "PUT", headers: auth,
    body: JSON.stringify({ locale: "zh-CN", slug: `${PREFIX}ni-hao`, title: "clash" }),
  });
  check("a slug taken by another post in the SAME language is refused", clashZh.status, 409);
  const clashEn = await req(worker, env, `/api/v1/posts/${third.id}`, {
    method: "PUT", headers: auth,
    body: JSON.stringify({ locale: "en", slug: `${PREFIX}hello`, title: "clash" }),
  });
  check("a slug taken in the default language is refused too", clashEn.status, 409);

  // -- 6. per-locale feeds and the sitemap ---------------------------------
  console.log("\n6. Feeds and sitemap read per-language slugs");
  const enFeed = await (await req(worker, env, "/en/feed.xml")).text();
  const zhFeed = await (await req(worker, env, "/zh-CN/feed.xml")).text();
  const bareFeed = await (await req(worker, env, "/feed.xml")).text();
  checkTruthy("the en feed carries the en slug", enFeed.includes(`/en/blog/${PREFIX}hello`));
  checkTruthy("the zh feed carries the zh slug", zhFeed.includes(`/zh-CN/blog/${PREFIX}ni-hao`));
  checkTruthy("the zh feed does not carry the en slug of the same piece", !zhFeed.includes(`/zh-CN/blog/${PREFIX}hello`));
  checkTruthy("the bare feed is the default language's", bareFeed.includes(`<language>en</language>`));

  const sitemap = await (await req(worker, env, "/sitemap.xml")).text();
  checkTruthy("sitemap lists the en URL", sitemap.includes(`/en/blog/${PREFIX}hello</loc>`));
  checkTruthy("sitemap lists the zh URL with its own slug", sitemap.includes(`/zh-CN/blog/${PREFIX}ni-hao</loc>`));
  checkTruthy("sitemap does not pair the zh locale with the en slug", !sitemap.includes(`/zh-CN/blog/${PREFIX}hello</loc>`));

  // -- restore --------------------------------------------------------------
  // Activating the test theme rewrote site-wide tables clear-then-insert; put
  // the snapshots back so sibling suites and the dev site see what they saw.
  sqlite.exec(`DELETE FROM post_meta WHERE post_id IN (SELECT id FROM posts WHERE slug LIKE '${PREFIX}%')`);
  sqlite.exec(`DELETE FROM post_revisions WHERE post_id IN (SELECT id FROM posts WHERE slug LIKE '${PREFIX}%')`);
  sqlite.exec(`DELETE FROM post_translations WHERE post_id IN (SELECT id FROM posts WHERE slug LIKE '${PREFIX}%')`);
  sqlite.exec(`DELETE FROM posts WHERE slug LIKE '${PREFIX}%'`);
  sqlite.exec("DELETE FROM theme_routes WHERE site_id='default'");
  for (const r of previousRoutes) {
    sqlite.prepare(`INSERT INTO theme_routes (${Object.keys(r).join(",")}) VALUES (${Object.keys(r).map(() => "?").join(",")})`).run(...Object.values(r));
  }
  sqlite.exec("DELETE FROM admin_menu_registry WHERE site_id IN ('default','*')");
  for (const r of previousMenus) {
    sqlite.prepare(`INSERT INTO admin_menu_registry (${Object.keys(r).join(",")}) VALUES (${Object.keys(r).map(() => "?").join(",")})`).run(...Object.values(r));
  }
  sqlite.exec("DELETE FROM site_locales WHERE site_id='default'");
  for (const r of previousSiteLocales) {
    sqlite.prepare(`INSERT INTO site_locales (${Object.keys(r).join(",")}) VALUES (${Object.keys(r).map(() => "?").join(",")})`).run(...Object.values(r));
  }
  if (previousActive !== null) {
    sqlite.prepare("INSERT INTO settings (id,site_id,key,value,autoload) VALUES ('setting-theme-active','default','theme.active',?,1) ON CONFLICT(site_id,key) DO UPDATE SET value=excluded.value").run(previousActive);
  } else {
    sqlite.exec("DELETE FROM settings WHERE site_id='default' AND key='theme.active'");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("\nSUITE ERROR:", (e && e.stack) || e);
  process.exit(1);
});
