/**
 * Admin API contract test (batch 4 follow-up).
 *
 * The admin SPA (`public/admin/admin.js`) is site-aware: it appends `?site=`
 * to every request, renders a nav entry per theme-declared CPT, and builds a
 * Custom-fields panel from `theme/fields`. Those are contracts — if the API
 * stops honouring them the UI silently breaks. This suite pins them down.
 *
 * Also covers the CPT CRUD endpoints the UI now calls (`/content/{type}`),
 * including custom-field round-tripping through `post_meta`.
 *
 * Usage: node tests/suites/admin-contract.test.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { zipSync, strToU8 } from "fflate";
import { assetsStub } from "../fixtures/_assets-stub.mjs";

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

async function compileWorker() {
  const esbuild = require("esbuild");
  const out = await esbuild.build({
    entryPoints: [join(root, "src/index.ts")],
    bundle: true, format: "esm", target: "es2022", write: false,
    platform: "neutral", external: ["cloudflare:workers"], logLevel: "silent",
  });
  const tmp = join(root, ".wrangler", "admin-bundle.mjs");
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, out.outputFiles[0].text);
  return import(pathToFileURL(tmp).href + "?t=" + Date.now());
}

function makeD1(sqlite) {
  return {
    prepare(sql) {
      const st = { sql, params: [] };
      const api = {
        bind(...a) { st.params = a; return api; },
        async first(c) { const r = sqlite.prepare(st.sql).get(...st.params); return c !== undefined && r ? r[c] : (r ?? null); },
        async all() { return { results: sqlite.prepare(st.sql).all(...st.params), success: true, meta: {} }; },
        async run() { const r = sqlite.prepare(st.sql).run(...st.params); return { success: true, meta: { changes: r.changes } }; },
      };
      return api;
    },
    async batch(s) { const o = []; for (const x of s) o.push(await x.run()); return o; },
    async exec(sql) { sqlite.exec(sql); return { success: true }; },
  };
}

function makeR2() {
  const store = new Map();
  return {
    async get(k) {
      if (!store.has(k)) return null;
      const e = store.get(k);
      return { async text() { return typeof e === "string" ? e : new TextDecoder().decode(e); }, body: e, httpEtag: '"x"', writeHttpMetadata() {} };
    },
    async put(k, v) {
      let b = v;
      if (v && typeof v.arrayBuffer === "function") b = new Uint8Array(await v.arrayBuffer());
      else if (v && typeof v.getReader === "function") {
        const ch = []; const rd = v.getReader();
        for (;;) { const { done, value } = await rd.read(); if (done) break; ch.push(value); }
        const t = ch.reduce((n, c) => n + c.length, 0); const m = new Uint8Array(t);
        let o = 0; for (const c of ch) { m.set(c, o); o += c.length; }
        b = m;
      }
      store.set(k, b);
      return { key: k };
    },
    async delete(k) { store.delete(k); },
    _dump: () => [...store.keys()],
  };
}

function makeEnv(sqlite) {
  const kv = new Map();
  return {
    DB: makeD1(sqlite), MEDIA: makeR2(),
    CACHE: { async get(k) { return kv.has(k) ? kv.get(k) : null; }, async put(k, v) { kv.set(k, v); }, async delete(k) { kv.delete(k); } },
    ASSETS: assetsStub(),
  };
}

async function req(worker, env, path, init = {}, host = "localhost") {
  return worker.fetch(new Request(`http://${host}${path}`, init), env, { waitUntil() {}, passThroughOnException() {} });
}

function buildTheme(name, cpt, opts = {}) {
  const manifest = {
    name, title: `${name} title`, version: "1.0.0",
    templates: ["index", "archive-"+cpt, "single-"+cpt],
    postTypes: [{
      name: cpt, label: cpt,
      labels: { singular: cpt, plural: cpt + "s" },
      supports: opts.supports ?? ["title", "editor"],
      hasArchive: true, rewrite: { slug: cpt + "s" },
    }],
    fields: opts.fields ?? [{ key: "sku", label: "SKU", type: "text", postTypes: [cpt] }],
    adminMenus: opts.adminMenus ?? [{ id: cpt + "s", label: cpt + "s", screen: "content-list", args: { type: cpt } }],
    settings: opts.settings ?? [{ key: "accent", label: "Accent", type: "color", default: "#f00" }, { key: "layout.mode", label: "Layout", type: "select", default: "wide", options: ["wide", "boxed"] }, { key: "showHero", label: "Show hero", type: "boolean", default: "true" }],
    runtime: "declarative",
  };
  const index = `<!doctype html><html><body>{{site.title}}</body></html>`;
  return zipSync({
    "theme.json": strToU8(JSON.stringify(manifest, null, 2)),
    "templates/index.html": strToU8(index),
    [`templates/archive-${cpt}.html`]: strToU8(`<html><body>ARCH-${cpt}</body></html>`),
    [`templates/single-${cpt}.html`]: strToU8(`<html><body>SINGLE-${cpt}:{{post.slug}}</body></html>`),
  });
}

async function main() {
  const d1Dir = join(root, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
  if (!existsSync(d1Dir)) { console.error("Local D1 not found."); process.exit(2); }
  const files = readdirSync(d1Dir).filter((f) => f.endsWith(".sqlite"));
  if (!files.length) { console.error("Local D1 sqlite not found."); process.exit(2); }
  const sqlite = new DatabaseSync(join(d1Dir, files[0]));
  const worker = (await compileWorker()).default;
  const env = makeEnv(sqlite);

  for (const sql of [
    "DELETE FROM post_meta WHERE post_id LIKE 'adm_%' OR post_id LIKE 'widget_%'",
    "DELETE FROM post_translations WHERE post_id LIKE 'adm_%' OR post_id LIKE 'widget_%'",
    "DELETE FROM posts WHERE id LIKE 'adm_%' OR id LIKE 'widget_%'",
    "DELETE FROM post_types WHERE declared_by_theme='admtheme'",
    "DELETE FROM field_defs WHERE declared_by_theme='admtheme'",
    "DELETE FROM admin_menu_registry WHERE owner_type='theme' AND owner_name='admtheme'",
    "DELETE FROM theme_setting_defs WHERE theme_name='admtheme'",
    "DELETE FROM theme_settings WHERE theme_name='admtheme'",
    "DELETE FROM theme_installs WHERE name='admtheme'",
    "DELETE FROM extension_versions WHERE extension_name='admtheme'",
    "DELETE FROM sites WHERE id='adm'",
    "DELETE FROM settings WHERE site_id='adm'",
    "DELETE FROM menus WHERE site_id='adm'",
  ]) { try { sqlite.exec(sql); } catch { /* ok */ } }

  console.log("0. auth");
  await req(worker, env, "/api/v1/health");
  await req(worker, env, "/api/v1/auth/me");
  const lr = await req(worker, env, "/api/v1/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "change-me-now" }),
  });
  const cookie = lr.headers.get("set-cookie")?.split(";")[0] ?? "";
  checkTruthy("logged in", cookie.startsWith("cfpress_session="));
  const auth = { Cookie: cookie };
  const json = { ...auth, "Content-Type": "application/json" };

  console.log("\n1. Theme install + activate on a new site");
  await req(worker, env, "/api/v1/sites", { method: "POST", headers: json, body: JSON.stringify({ id: "adm", name: "Admin Test" }) });
  const fd = new FormData();
  fd.append("file", new File([buildTheme("admtheme", "widget")], "admtheme.zip", { type: "application/zip" }));
  const up = await req(worker, env, "/api/v1/extensions/themes/upload", { method: "POST", headers: auth, body: fd });
  check("theme uploaded", up.status, 201);
  const act = await (await req(worker, env, "/api/v1/extensions/themes/admtheme/activate?site=adm", { method: "POST", headers: auth })).json();
  check("activated on adm", act.site, "adm");

  console.log("\n2. Contracts the admin sidebar depends on");
  // The sidebar builds one nav button per post type and one per admin menu.
  const pts = await (await req(worker, env, "/api/v1/theme/post-types?site=adm", { headers: auth })).json();
  check("post-types has name + label for nav", [pts.items[0].name, pts.items[0].label], ["widget", "widget"]);
  check("post-types has plural label for nav", pts.items[0].plural_label, "widgets");
  const menus = await (await req(worker, env, "/api/v1/theme/menus?site=adm", { headers: auth })).json();
  check("admin menus have label + screen + args", [menus.items[0].label, menus.items[0].screen, menus.items[0].args], ["widgets", "content-list", { type: "widget" }]);
  const fields = await (await req(worker, env, "/api/v1/theme/fields?site=adm", { headers: auth })).json();
  check("fields expose meta_key/type/label for the editor", [fields.items[0].meta_key, fields.items[0].field_type, fields.items[0].label], ["sku", "text", "SKU"]);
  check("fields carry post_types so the editor filters them", fields.items[0].post_types, ["widget"]);

  console.log("\n3. Themes endpoint contracts for the site switcher");
  const th = await (await req(worker, env, "/api/v1/extensions/themes?site=adm", { headers: auth })).json();
  check("themes reports the active theme for this site", th.active, "admtheme");
  checkTruthy("themes reports active_by_site for per-site badges", th.active_by_site && th.active_by_site.adm === "admtheme");
  check("admtheme marked active in items", th.items.find((x) => x.name === "admtheme").active, 1);
  // A theme used only by another site must not read as active here.
  const thDefault = await (await req(worker, env, "/api/v1/extensions/themes", { headers: auth })).json();
  check("admtheme not active on default site", thDefault.items.find((x) => x.name === "admtheme").active, 0);

  console.log("\n4. CPT CRUD via /content/{type} (what the editor calls)");
  const created = await (await req(worker, env, "/api/v1/content/widget?site=adm", {
    method: "POST", headers: json,
    body: JSON.stringify({ title: "First Widget", slug: "first-widget", status: "published", locale: "en", content: [], meta: { sku: "W-1" } }),
  })).json();
  checkTruthy("CPT post created", created.id);
  const postId = created.id;
  check("created on the right site", created.site, "adm");

  const list = await (await req(worker, env, "/api/v1/content/widget?site=adm", { headers: auth })).json();
  check("CPT list returns the post", list.items.map((x) => x.slug), ["first-widget"]);

  const one = await (await req(worker, env, `/api/v1/content/widget/${postId}?site=adm`, { headers: auth })).json();
  check("single read returns translations", one.items.length, 1);
  check("single read exposes custom field values", one.items[0].meta, { sku: "W-1" });

  const upd = await req(worker, env, `/api/v1/content/widget/${postId}?site=adm`, {
    method: "PUT", headers: json,
    body: JSON.stringify({ title: "Renamed Widget", slug: "first-widget", status: "published", locale: "en", content: [], meta: { sku: "W-2" } }),
  });
  check("CPT update ok", upd.status, 200);
  const afterUpd = await (await req(worker, env, `/api/v1/content/widget/${postId}?site=adm`, { headers: auth })).json();
  check("custom field updated", afterUpd.items[0].meta.sku, "W-2");

  console.log("\n5. Custom-field writes are whitelisted");
  // An undeclared meta key must be ignored, not written.
  await req(worker, env, `/api/v1/content/widget/${postId}?site=adm`, {
    method: "PUT", headers: json,
    body: JSON.stringify({ title: "T", slug: "first-widget", status: "published", locale: "en", content: [], meta: { sku: "W-3", NOT_DECLARED: "nope" } }),
  });
  const metaRows = sqlite.prepare("SELECT meta_key FROM post_meta WHERE post_id=?").all(postId).map((r) => r.meta_key);
  checkTruthy("declared field written", metaRows.includes("sku"));
  checkTruthy("undeclared field rejected", !metaRows.includes("NOT_DECLARED"));

  console.log("\n6. CPT front-end routes (on the site that declared them)");
  // Route the request to site `adm` by host so the CPT is in scope.
  await req(worker, env, "/api/v1/sites/adm", {
    method: "PUT", headers: json, body: JSON.stringify({ host: "adm.example.com" }),
  });
  const s = await req(worker, env, "/en/widgets/first-widget", {}, "adm.example.com");
  check("CPT single resolves", s.headers.get("X-CFPress-Template"), "single-widget");
  checkTruthy("CPT single body", (await s.text()).includes("SINGLE-widget:first-widget"));
  const a = await req(worker, env, "/en/widgets", {}, "adm.example.com");
  check("CPT archive resolves", a.headers.get("X-CFPress-Template"), "archive-widget");
  // The same URL on a site whose theme never declared `widget` must 404.
  const cross = await req(worker, env, "/en/widgets/first-widget", {}, "localhost");
  check("CPT route is invisible on other sites", cross.status, 404);

  console.log("\n7. Delete cleans up custom fields");
  const del = await req(worker, env, `/api/v1/content/widget/${postId}?site=adm`, { method: "DELETE", headers: auth });
  check("delete ok", del.status, 200);
  const orphans = sqlite.prepare("SELECT COUNT(*) AS n FROM post_meta WHERE post_id=?").get(postId);
  check("post_meta cleaned up on delete", orphans.n, 0);
  const gone = await (await req(worker, env, "/api/v1/content/widget?site=adm", { headers: auth })).json();
  check("post gone from list", gone.items.length, 0);

  console.log("\n8. Theme settings screen contract");
  const ts = await (await req(worker, env, "/api/v1/theme/admtheme/settings", { headers: auth })).json();
  check("theme settings exposes key/label/value", [ts.items[0].key, ts.items[0].label, ts.items[0].value], ["accent", "Accent", "#f00"]);
  // Declared `options` survive the install (migration 0017) and reach the form.
  const sel = ts.items.find((x) => x.key === "layout.mode");
  check("select options round-trip from the manifest", sel && sel.options, ["wide", "boxed"]);
  check("declared type reaches the form", sel && sel.type, "select");
  await req(worker, env, "/api/v1/theme/admtheme/settings", { method: "POST", headers: json, body: JSON.stringify({ key: "accent", value: "#00f" }) });
  const ts2 = await (await req(worker, env, "/api/v1/theme/admtheme/settings", { headers: auth })).json();
  check("theme setting saved", ts2.items[0].value, "#00f");

  console.log("\n9. Per-site media listing");
  const mDef = await (await req(worker, env, "/api/v1/media", { headers: auth })).json();
  const mAdm = await (await req(worker, env, "/api/v1/media?site=adm", { headers: auth })).json();
  check("media list echoes site", [mDef.site, mAdm.site], ["default", "adm"]);
  checkTruthy("media lists are independent", Array.isArray(mDef.items) && Array.isArray(mAdm.items));

  console.log("\n10. Editor block palette is the renderer's set, translated");
  const blocksEn = await (await req(worker, env, "/api/v1/blocks?locale=en", { headers: auth })).json();
  checkTruthy("palette covers every renderable block type", blocksEn.items.length >= 12);
  check(
    "each entry carries type/label/category",
    [typeof blocksEn.items[0].type, typeof blocksEn.items[0].label, typeof blocksEn.items[0].category],
    ["string", "string", "string"]
  );
  check(
    "the types are exactly the renderer's set (no drift)",
    blocksEn.items.map((b) => b.type).join(","),
    ["core/paragraph","core/heading","core/list","core/quote","core/code","core/image","core/gallery","core/button","core/separator","core/html","core/group","core/columns"].join(",")
  );
  check("english label", blocksEn.items.find((b) => b.type === "core/paragraph").label, "Paragraph");
  // The palette ships the **attribute contract**, not just the block list.
  // Before it did, the editor wrote `attrs.text` for every type and six of the
  // twelve blocks rendered empty at HTTP 200 — see `editor-blocks.test.mjs`,
  // which walks the whole chain. These assertions pin the wire shape the
  // editor's controls are built from.
  check(
    "every palette entry ships its attribute list",
    blocksEn.items.every((b) => Array.isArray(b.attrs)),
    true
  );
  const img = blocksEn.items.find((b) => b.type === "core/image");
  check(
    "the image ships url + alt, url required",
    img.attrs.map((a) => [a.key, a.type, a.required === true]),
    [["url", "media", true], ["alt", "text", false]]
  );
  check("the image's labels are translated for the locale", [img.attrs[0].label, img.attrs[1].label], ["Image", "Alt text"]);
  check("a separator declares no attributes", blocksEn.items.find((b) => b.type === "core/separator").attrs, []);
  check(
    "the nesting blocks are marked as containers with no attributes",
    blocksEn.items.filter((b) => b.children).map((b) => [b.type, b.attrs.length]),
    [["core/group", 0], ["core/columns", 0]]
  );
  // A media-list's item shape travels with the attribute, so the editor's
  // repeatable row does not hardcode the item keys a second time.
  check(
    "the gallery ships the item keys of its media-list attribute",
    blocksEn.items.find((b) => b.type === "core/gallery").attrs[0].itemKeys,
    ["url", "alt"]
  );
  const blocksZh = await (await req(worker, env, "/api/v1/blocks?locale=zh-CN", { headers: auth })).json();
  check("labels follow the requested UI locale", blocksZh.items.find((b) => b.type === "core/paragraph").label, "段落");
  check(
    "attribute labels follow it too",
    blocksZh.items.find((b) => b.type === "core/image").attrs[0].label,
    "图片"
  );
  // Without an explicit locale the palette follows the admin's own ui_lang —
  // this suite's shared dev database has it as zh-CN, so the fallback must
  // agree with that rather than with any assumed language.
  const blocksAuto = await (await req(worker, env, "/api/v1/blocks?locale=xx-XX", { headers: auth })).json();
  const blocksPlain = await (await req(worker, env, "/api/v1/blocks", { headers: auth })).json();
  check("an unknown locale falls back to the admin's own ui_lang",
    blocksAuto.items.find((b) => b.type === "core/paragraph").label,
    blocksPlain.items.find((b) => b.type === "core/paragraph").label);

  console.log("\n11. Dashboard stat cards arrive as data");
  const dash = await (await req(worker, env, "/api/v1/dashboard", { headers: auth })).json();
  check(
    "cards carry the platform stat set",
    dash.cards.map((c) => c.key),
    ["posts", "pages", "media", "drafts"]
  );
  checkTruthy("card values are numbers", dash.cards.every((c) => typeof c.value === "number"));
  checkTruthy("card labels are delivered (translated server-side)", dash.cards.every((c) => typeof c.label === "string" && c.label.length > 0));
  checkTruthy("recent content is present as an array", Array.isArray(dash.recent));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log("Failed: " + failures.join(", "));
  sqlite.close();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Harness error:", (e && e.message) || e);
  console.error(String((e && e.stack) || "").split("\n").slice(0, 8).join("\n"));
  process.exit(2);
});
