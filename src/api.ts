import { Env } from "./shared/types";
import { bootstrapAdmin, currentUser, login, logout, requireAdmin, setUserUiLang } from "./platform/auth";
import { activity, jsonBody, now, ok } from "./shared/repo";
import { randomId } from "./shared/crypto";
import { CORE_BLOCKS } from "./rendering/blocks";
import { installedPlugins, installedThemes, seedBundledExtensions, capabilityList, bootPluginRuntime, applyFilters, doAction, resetPluginRuntime, pluginRuntimeStatus } from "./extensions/plugin/runtime";
import { unzipSync } from "fflate";
import { validateManifest } from "./extensions/contract/validation";
import { CAPABILITIES } from "./extensions/contract/capabilities";
import { safeZipPath, sha256 } from "./extensions/security";
import { createRevision, autosave } from "./platform/revisions";
import { requirePermission, can } from "./platform/permissions";
import { bumpContentCache } from "./shared/cache";
import { listAdminMenuGroups } from "./platform/admin-menus";
import { clearPluginMenus } from "./extensions/plugin/menus";
import { createSite, updateSite, deleteSite, listSites, DEFAULT_SITE_ID } from "./platform/sites";
import { invalidateThemeWorker } from "./extensions/theme/runtime-worker";
import {
  applyThemeCapabilities,
  clearThemeCapabilities,
  listPostTypes,
  listTaxonomies,
  listRoutes,
  listThemeAdminMenus,
  listThemeBlocks,
  listFieldDefs,
  themeSettings,
} from "./extensions/theme/capabilities";
import {
  availableUiLocales,
  corePackLocales,
  disableSiteLocale,
  enableSiteLocale,
  isLocaleCode,
  loadUiPacks,
  mergePacks,
  platformLocales,
  resolveUiLocale,
  setSiteDefaultLocale,
  siteDefaultLocale,
  siteLocaleCodes,
  siteLocaleRows,
  siteLocales,
  upsertPlatformLocale,
} from "./platform/i18n";
import { activeTheme } from "./extensions/theme/runtime-declarative";
import {
  listThemeTableDefs,
  refreshThemeTableI18n,
  syncThemeTables,
} from "./extensions/theme/tables";
import { tableBySlug, tableDelete, tableList, tableSave, resolveTableForSite } from "./extensions/theme/table-facade";

/**
 * Which site does this admin request target? Explicit `?site=` wins; otherwise
 * the default site. The admin UI passes it so one install can manage many
 * sites from the same backend.
 */
function requestSiteId(url: URL): string {
  const s = String(url.searchParams.get("site") ?? "").trim();
  return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(s) ? s : DEFAULT_SITE_ID;
}

/**
 * How a post identifies its translation group.
 *
 * A row's group is its `lang_group` when that is set, and otherwise its own id —
 * that is how content created before it had any translations names itself.
 *
 * The SQL mirror of `groupOf()` is `GROUP_SQL`, and the two must stay in step.
 * Matching `p.lang_group = ?` on the SQL side instead *excludes* the very row
 * whose id named the group (its `lang_group` is NULL), so that row vanished from
 * its own translation group: the editor reported the language as missing and
 * offered to create a duplicate of a version that already existed.
 */
const GROUP_SQL = "COALESCE(NULLIF(TRIM(p.lang_group), ''), p.id)";
function groupOf(row: any): string {
  const g = String(row?.lang_group ?? "").trim();
  return g || String(row?.id ?? "");
}

/**
 * Every language version of one piece of content, keyed by `lang_group`.
 *
 * Returns one entry per *enabled site locale*, not per existing row, because
 * the editor's language bar has to show the versions that do **not** exist yet
 * (that is what the `＋` button is for).
 */
async function translationGroup(env: Env, siteId: string, postId: string) {
  const source = await env.DB.prepare(
    "SELECT id, type, lang_group, site_id FROM posts WHERE id=? AND site_id=? LIMIT 1"
  )
    .bind(postId, siteId)
    .first<any>();
  if (!source) return null;
  const group = groupOf(source);
  const rows = await env.DB.prepare(
    `SELECT p.id, p.slug, p.status, p.updated_at, t.locale, t.title
       FROM posts p LEFT JOIN post_translations t ON t.post_id = p.id
      WHERE p.site_id = ? AND ${GROUP_SQL} = ?
      ORDER BY t.locale`
  )
    .bind(siteId, group)
    .all();
  const existing = ((rows.results as any[]) ?? []);
  const codes = await siteLocaleCodes(env, siteId);
  const byLocale = new Map<string, any>();
  for (const r of existing) {
    if (r.locale) byLocale.set(String(r.locale), r);
  }
  const versions = codes.map((code) => {
    const hit = byLocale.get(code);
    return {
      locale: code,
      exists: !!hit,
      post_id: hit?.id ?? null,
      slug: hit?.slug ?? null,
      title: hit?.title ?? null,
      status: hit?.status ?? null,
    };
  });
  // A translation in a locale the site no longer serves still exists in the
  // database. Surface it rather than hiding it — the content is real.
  for (const r of existing) {
    const code = String(r.locale ?? "");
    if (!code || codes.includes(code)) continue;
    versions.push({
      locale: code,
      exists: true,
      post_id: r.id,
      slug: r.slug,
      title: r.title,
      status: r.status,
    });
  }
  return { group, type: String(source.type), source_id: String(source.id), versions };
}

/** A slug that is free for this site+type, derived from `base`. */
async function freeSlug(env: Env, siteId: string, type: string, base: string): Promise<string> {
  const clean = String(base || "untitled").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "untitled";
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? clean : `${clean}-${i + 1}`;
    const hit = await env.DB.prepare(
      "SELECT id FROM posts WHERE site_id=? AND type=? AND slug=? LIMIT 1"
    )
      .bind(siteId, type, candidate)
      .first<any>();
    if (!hit) return candidate;
  }
  return `${clean}-${await randomId()}`;
}

async function listPosts(env: Env, url: URL, kind: string, siteId: string) {
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? "20")));
  const offset = (page - 1) * limit;
  const q = url.searchParams.get("q") ?? "";
  const locale = String(url.searchParams.get("locale") ?? "").trim();
  // A post has one row per locale, so joining translations without pinning a
  // locale would return the same post several times. Pin to the requested
  // locale, or fall back to a deterministic "first" translation.
  const localeClause = locale ? "t.locale = ?" : "t.locale = (SELECT MIN(locale) FROM post_translations WHERE post_id = p.id)";
  const rows = await env.DB.prepare(`
    SELECT p.id, p.slug, p.status, p.type, p.author_id, p.created_at, p.updated_at,
           t.locale, t.title, t.excerpt, t.content
    FROM posts p LEFT JOIN post_translations t ON t.post_id = p.id AND ${localeClause}
    WHERE p.site_id = ? AND p.type = ? AND (t.title LIKE ? OR p.slug LIKE ?)
    ORDER BY p.updated_at DESC LIMIT ? OFFSET ?
  `).bind(...(locale ? [siteId, kind, locale] : [siteId, kind]), `%${q}%`, `%${q}%`, limit, offset).all();
  return ok({ items: rows.results, page, limit, site: siteId });
}

async function savePost(
  env: Env,
  userId: string,
  id: string | null,
  body: any,
  kind: "post" | "page" | string,
  siteId: string
) {
  await bootPluginRuntime(env);
  // Give plugins a chance to normalise the payload before anything is written.
  // A plugin may return a replacement body; a throw or a non-object result
  // leaves the original payload intact.
  try {
    const filtered = await applyFilters("beforeSavePost", { env, siteId }, body);
    if (filtered && typeof filtered === "object" && !Array.isArray(filtered)) body = filtered;
  } catch {
    /* plugin failure must not block a content save */
  }
  const entityId = id ?? `${kind}_${await randomId()}`;
  const slug = String(body.slug ?? "").trim() || entityId;
  const status = String(body.status ?? "draft");
  const publishAt = body.publish_at ? Number(body.publish_at) : null;
  // The locale to write. Falling back to a literal `"en"` was wrong for the
  // same reason `siteId = "default"` was: on a site whose default language is
  // `zh-CN`, a client that omits `locale` would silently author an English
  // translation. The fallback belongs to the site, so it is looked up.
  const locale = String(body.locale ?? "").trim() || (await siteDefaultLocale(env, siteId));
  const title = String(body.title ?? "");
  const excerpt = String(body.excerpt ?? "");
  const content = typeof body.content === "string" ? body.content : JSON.stringify(body.content ?? []);
  const isCreate = !id;
  if (!id) {
    // `lang_group` ties the language versions of one piece of content together.
    // A new post starts as its own group of one; a translation added later
    // adopts the existing group (see the i18n/translations endpoint).
    const langGroup = String(body.lang_group ?? "").trim() || entityId;
    await env.DB.prepare("INSERT INTO posts (id, site_id, author_id, type, slug, status, lang_group, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(entityId, siteId, userId, kind, slug, status, langGroup, now(), now()).run();
  } else {
    const old = await env.DB.prepare("SELECT * FROM post_translations WHERE post_id=? AND locale=? LIMIT 1").bind(entityId,locale).first<any>();
    if(old) await createRevision(env,entityId,userId,locale,String(old.title||""),String(old.excerpt||""),String(old.content||""));
    await env.DB.prepare("UPDATE posts SET slug = ?, status = ?, updated_at = ? WHERE id = ?").bind(slug, status, now(), entityId).run();
  }
  const existing = await env.DB.prepare("SELECT id FROM post_translations WHERE post_id = ? AND locale = ? LIMIT 1").bind(entityId, locale).first<any>();
  if (existing) {
    await env.DB.prepare("UPDATE post_translations SET title=?, excerpt=?, content=?, updated_at=? WHERE id=?").bind(title, excerpt, content, now(), existing.id).run();
  } else {
    await env.DB.prepare("INSERT INTO post_translations (id, post_id, locale, title, excerpt, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(await randomId(), entityId, locale, title, excerpt, content, now(), now()).run();
  }
  if(publishAt && status === "scheduled") {
    await env.DB.prepare("INSERT INTO scheduled_posts(post_id,publish_at,processed_at) VALUES(?,?,NULL) ON CONFLICT(post_id) DO UPDATE SET publish_at=excluded.publish_at,processed_at=NULL").bind(entityId,publishAt).run();
  } else {
    await env.DB.prepare("DELETE FROM scheduled_posts WHERE post_id=?").bind(entityId).run();
  }
  // Custom fields: persist any theme-declared meta sent alongside the post.
  if (body.meta && typeof body.meta === "object" && !Array.isArray(body.meta)) {
    for (const [k, v] of Object.entries(body.meta as Record<string, unknown>)) {
      const key = String(k);
      if (!/^[a-z0-9_][a-z0-9_-]{0,63}$/i.test(key)) continue;
      if (!(await fieldExists(env, key, siteId))) continue;
      await env.DB.prepare(
        "INSERT INTO post_meta(post_id,meta_key,meta_value,updated_at) VALUES(?,?,?,?) ON CONFLICT(post_id,meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=excluded.updated_at"
      )
        .bind(entityId, key, v === null || v === undefined ? null : String(v), now())
        .run()
        .catch(() => {});
    }
  }
  await bumpContentCache(env, siteId);
  await activity(env, userId, isCreate ? "create" : "update", kind, entityId, { locale, title, status, siteId });
  // Notify plugins after the write has landed so they can index/notify.
  try {
    await doAction("afterSavePost", { env, siteId }, { id: entityId, type: kind, slug, locale, title, status, siteId, created: isCreate });
  } catch {
    /* never surface a plugin failure to the editor */
  }
  return ok({ id: entityId, site: siteId });
}

/** Is this meta key declared by the active theme for this site? */
async function fieldExists(env: Env, key: string, siteId: string): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      "SELECT id FROM field_defs WHERE site_id=? AND meta_key=? LIMIT 1"
    )
      .bind(siteId, key)
      .first<any>();
    return !!row;
  } catch {
    return false;
  }
}

/** Look up a theme-declared post type that is currently active for a site. */
async function findActivePostType(env: Env, name: string, siteId: string) {
  try {
    return await env.DB.prepare(
      "SELECT * FROM post_types WHERE site_id=? AND name=? AND active=1 LIMIT 1"
    )
      .bind(siteId, name)
      .first<any>();
  } catch {
    return null;
  }
}

/** All custom-field values stored against a post. */
async function postMeta(env: Env, postId: string): Promise<Record<string, string>> {
  try {
    const r = await env.DB.prepare("SELECT meta_key, meta_value FROM post_meta WHERE post_id=?")
      .bind(postId)
      .all();
    return Object.fromEntries(((r.results as any[]) ?? []).map((m) => [m.meta_key, m.meta_value]));
  } catch {
    return {};
  }
}

async function uploadExtension(env:Env,userId:string,request:Request,type:"plugin"|"theme"){
  const form=await request.formData();
  const file=form.get("file");
  if(!(file instanceof File))return ok({error:"file required"},400);
  if(file.size>10*1024*1024)return ok({error:"extension package max size is 10MB"},413);
  let files:Record<string,Uint8Array>;
  try{files=unzipSync(new Uint8Array(await file.arrayBuffer())) as Record<string,Uint8Array>}catch{return ok({error:"invalid ZIP package"},400)}
  const entries=Object.entries(files);
  if(entries.length===0||entries.length>100)return ok({error:"invalid package file count"},400);
  let total=0;for(const [name,bytes] of entries){if(!safeZipPath(name))return ok({error:`unsafe path: ${name}`},400);total+=bytes.byteLength;if(total>20*1024*1024)return ok({error:"uncompressed package exceeds 20MB"},413)}
  const manifestEntry=entries.find(([n])=>n.split("/").at(-1)===(type==="plugin"?"plugin.json":"theme.json"));
  if(!manifestEntry)return ok({error:`${type}.json not found`},400);
  let manifest:any;try{manifest=JSON.parse(new TextDecoder().decode(manifestEntry[1]))}catch{return ok({error:"invalid manifest JSON"},400)}
  let meta:any;try{meta=validateManifest(manifest,type)}catch(e:any){return ok({error:e?.message||"invalid manifest"},400)}
  const checksum=await sha256(await file.arrayBuffer());
  const packageKey=`extensions/${type}s/${meta.name}/${meta.version}/${checksum}.zip`;
  await env.MEDIA.put(packageKey,file.stream(),{httpMetadata:{contentType:"application/zip",cacheControl:"private, max-age=0"},customMetadata:{type,name:meta.name,version:meta.version}});
  if(type==="theme") {
    for(const [entry,bytes] of entries) {
      if(entry.endsWith("/") || entry.length>200) continue;
      const normalized=entry.replace(/^\.\//,"");
      const key=`extensions/themes/${meta.name}/${meta.version}/files/${normalized}`;
      const contentType=normalized.endsWith(".html")?"text/html;charset=UTF-8":normalized.endsWith(".css")?"text/css;charset=UTF-8":normalized.endsWith(".json")?"application/json":normalized.endsWith(".js")?"text/javascript;charset=UTF-8":"application/octet-stream";
      await env.MEDIA.put(key,bytes,{httpMetadata:{contentType,cacheControl:"public,max-age=300"}});
    }
  }
  const nowTs=now();
  await env.DB.prepare("INSERT OR IGNORE INTO extension_versions(id,extension_type,extension_name,version,package_key,checksum,manifest,installed_at) VALUES(?,?,?,?,?,?,?,?)")
    .bind(await randomId(),type,meta.name,meta.version,packageKey,checksum,JSON.stringify(manifest),nowTs).run();
  if(type==="plugin"){
    await env.DB.prepare(`INSERT INTO plugin_installs(id,name,title,version,enabled,manifest,installed_at,updated_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET title=excluded.title,version=excluded.version,manifest=excluded.manifest,updated_at=excluded.updated_at`)
      .bind(`plugin_${meta.name}`,meta.name,meta.title,meta.version,0,JSON.stringify(manifest),nowTs,nowTs).run();
  }else{
    // Installing a theme must never change what any site is currently using.
    // `active` here only records that the package is installed and usable.
    await env.DB.prepare(`INSERT INTO theme_installs(id,name,title,version,active,manifest,installed_at,updated_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET title=excluded.title,version=excluded.version,manifest=excluded.manifest,updated_at=excluded.updated_at`)
      .bind(`theme_${meta.name}`,meta.name,meta.title,meta.version,0,JSON.stringify(manifest),nowTs,nowTs).run();
  }
  const perms=Array.isArray(manifest.permissions)?manifest.permissions:[];
  for(const cap of perms.filter((x:string)=>(CAPABILITIES as readonly string[]).includes(x))) await env.DB.prepare("INSERT OR REPLACE INTO extension_capabilities(extension_type,extension_name,capability,enabled) VALUES(?,?,?,1)").bind(type,meta.name,cap).run();
  if(type==="plugin" && Array.isArray(manifest.settings)) {
    for(const def of manifest.settings) {
      if(!def?.key) continue;
      await env.DB.prepare("INSERT OR REPLACE INTO plugin_setting_defs(plugin_name,key,label,type,default_value) VALUES(?,?,?,?,?)").bind(meta.name,String(def.key),String(def.label||def.key),String(def.type||"text"),String(def.default??"")).run();
    }
  }
  await activity(env,userId,"install",type,meta.name,{version:meta.version,checksum});
  return ok({ok:true,type,name:meta.name,title:meta.title,version:meta.version,checksum,files:entries.length},201);
}

async function pluginSettings(env:Env,name:string){
  const defs=await env.DB.prepare("SELECT * FROM plugin_setting_defs WHERE plugin_name=? ORDER BY key").bind(name).all();
  const vals=await env.DB.prepare("SELECT key,value FROM plugin_settings WHERE plugin_id=(SELECT id FROM plugin_installs WHERE name=? LIMIT 1)").bind(name).all();
  const map=Object.fromEntries((vals.results as any[]).map(x=>[x.key,x.value]));
  return ok({items:(defs.results as any[]).map(x=>({...x,value:map[x.key]??x.default_value??""}))});
}
async function savePluginSetting(env:Env,userId:string,name:string,b:any){
  const row=await env.DB.prepare("SELECT id FROM plugin_installs WHERE name=? LIMIT 1").bind(name).first<any>();
  if(!row)return ok({error:"plugin not found"},404);
  const allowed=await env.DB.prepare("SELECT key FROM plugin_setting_defs WHERE plugin_name=? AND key=?").bind(name,String(b.key||"")).first<any>();
  if(!allowed)return ok({error:"setting not declared"},400);
  await env.DB.prepare("INSERT INTO plugin_settings(plugin_id,key,value) VALUES(?,?,?) ON CONFLICT(plugin_id,key) DO UPDATE SET value=excluded.value").bind(row.id,String(b.key),String(b.value??"")).run();
  await activity(env,userId,"update","plugin_setting",name,{key:b.key});
  return ok({ok:true});
}

async function deletePost(env: Env, userId: string, id: string, siteId: string) {
  await bootPluginRuntime(env);
  // Let plugins purge their own derived data (indexes, caches) first.
  try {
    await doAction("beforeDeletePost", { env, siteId }, { id, siteId });
  } catch {
    /* a plugin failure must not prevent the delete */
  }
  await env.DB.prepare("DELETE FROM post_translations WHERE post_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM post_meta WHERE post_id = ?").bind(id).run().catch(() => {});
  await env.DB.prepare("DELETE FROM term_relationships WHERE post_id = ?").bind(id).run().catch(() => {});
  await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();
  await bumpContentCache(env, siteId);
  await activity(env, userId, "delete", "post", id, { siteId });
  return ok({ ok: true });
}

async function genericTable(env: Env, table: string, url: URL, siteId: string) {
  const allowed = new Set(["locales", "redirects", "rewrites", "plugins", "themes", "menus", "menu_items"]);
  if (!allowed.has(table)) return ok({ error: "Unsupported resource" }, 404);
  // Tables that carry site_id are filtered; global registries (plugins/themes)
  // are not, because an extension install is shared by every site.
  const scoped = new Set(["menus", "menu_items"]);
  const sql = scoped.has(table)
    ? `SELECT * FROM ${table} WHERE site_id=? ORDER BY rowid DESC LIMIT 500`
    : `SELECT * FROM ${table} ORDER BY rowid DESC LIMIT 500`;
  const rows = scoped.has(table)
    ? await env.DB.prepare(sql).bind(siteId).all()
    : await env.DB.prepare(sql).all();
  return ok({ items: rows.results, site: siteId });
}

async function settings(env: Env, siteId: string) {
  const rows = await env.DB.prepare("SELECT key, value, autoload FROM settings WHERE site_id=? ORDER BY key").bind(siteId).all();
  return ok({ items: rows.results, site: siteId });
}

async function saveSetting(env: Env, userId: string, body: any, siteId: string) {
  const key = String(body.key ?? "");
  if (!key) return ok({ error: "key required" }, 400);
  const value = String(body.value ?? "");
  const existing = await env.DB.prepare("SELECT id FROM settings WHERE site_id=? AND key=?").bind(siteId, key).first<any>();
  if (existing) {
    await env.DB.prepare("UPDATE settings SET value=? WHERE id=?").bind(value, existing.id).run();
  } else {
    await env.DB.prepare("INSERT INTO settings (id, site_id, key, value, autoload) VALUES (?, ?, ?, ?, 1)")
      .bind(await randomId(), siteId, key, value).run();
  }
  await activity(env, userId, "update", "setting", key, { siteId });
  return ok({ ok: true });
}

async function mediaList(env: Env, siteId: string) {
  const rows = await env.DB.prepare("SELECT * FROM media_files WHERE site_id=? ORDER BY created_at DESC LIMIT 200").bind(siteId).all();
  return ok({ items: rows.results, site: siteId });
}

async function mediaUpload(env: Env, userId: string, request: Request, siteId: string) {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return ok({ error: "file required" }, 400);
  if (file.size > 25 * 1024 * 1024) return ok({ error: "max file size is 25MB" }, 413);
  const id = await randomId();
  const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const key = `uploads/${siteId}/${new Date().toISOString().slice(0,10)}/${id}-${safe}`;
  await env.MEDIA.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || "application/octet-stream", cacheControl: "public, max-age=31536000, immutable" }
  });
  await env.DB.prepare(
    "INSERT INTO media_files (id, site_id, object_key, filename, mime_type, size, alt_text, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, siteId, key, file.name, file.type || "application/octet-stream", file.size, String(form.get("alt") ?? ""), String(form.get("title") ?? file.name), now()).run();
  await activity(env, userId, "upload", "media", id, { filename: file.name, size: file.size, siteId });
  return ok({ id, url: `/media/${encodeURIComponent(key)}`, site: siteId }, 201);
}

export async function handleApi(env: Env, request: Request): Promise<Response> {
  await bootstrapAdmin(env);
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/v1\/?/, "");
  const method = request.method;

  if (path === "health" && method === "GET") return ok({ ok: true, version: "0.7.0" });
  if (path === "auth/login" && method === "POST") {
    const body = await jsonBody(request);
    return login(env, String(body.username ?? ""), String(body.password ?? ""));
  }
  if (path === "auth/logout" && method === "POST") return logout(env, request);
  if (path === "auth/me" && method === "GET") {
    const user = await currentUser(env, request);
    return user ? ok({ user }) : ok({ user: null }, 401);
  }

  const auth = await requireAdmin(env, request);
  if (auth instanceof Response) return auth;
  const user = auth;
  const siteId = requestSiteId(url);
  if((path === "posts" || path === "pages" || /^posts\//.test(path) || /^pages\//.test(path)) && method !== "GET") {
    if(!(await requirePermission(env,user,"content.write"))) return ok({error:"Forbidden"},403);
  }
  if(path === "media" && method === "POST" && !(await requirePermission(env,user,"media.write"))) return ok({error:"Forbidden"},403);

  // Sites registry (multi-site)
  if (path === "sites" && method === "GET") {
    const items = await listSites(env);
    return ok({ items });
  }
  if (path === "sites" && method === "POST") {
    if(!(await requirePermission(env,user,"settings.manage"))) return ok({error:"Forbidden"},403);
    const b = await jsonBody(request);
    const r = await createSite(env, { id: b.id, name: String(b.name ?? ""), host: b.host ?? null, pathPrefix: b.path_prefix ?? b.pathPrefix ?? null });
    if ("error" in r) return ok({ error: r.error }, 400);
    await activity(env, user.id, "create", "site", r.id, { name: b.name });
    return ok({ id: r.id }, 201);
  }
  const siteMatch = path.match(/^sites\/([^/]+)$/);
  if (siteMatch) {
    if (method === "PUT" || method === "PATCH") {
      if(!(await requirePermission(env,user,"settings.manage"))) return ok({error:"Forbidden"},403);
      const b = await jsonBody(request);
      const r = await updateSite(env, siteMatch[1], { name: b.name, host: b.host, pathPrefix: b.path_prefix ?? b.pathPrefix, status: b.status });
      if ("error" in r) return ok({ error: r.error }, 404);
      await activity(env, user.id, "update", "site", siteMatch[1]);
      return ok({ ok: true });
    }
    if (method === "DELETE") {
      if(!(await requirePermission(env,user,"settings.manage"))) return ok({error:"Forbidden"},403);
      const r = await deleteSite(env, siteMatch[1]);
      if ("error" in r) return ok({ error: r.error }, 400);
      await activity(env, user.id, "delete", "site", siteMatch[1]);
      return ok({ ok: true });
    }
  }

  // -- Languages: L0 site switch + L2 dictionary (ARCHITECTURE.md §2.2/§2.4) --
  //
  // L0 and L2 are separate concerns and are kept as separate endpoints on
  // purpose. `i18n/locales` is what the *site* serves to visitors;
  // `i18n/dictionary` is what the platform knows; `i18n/ui-locale` is what one
  // admin wants to read. Collapsing them is how "content language" and "UI
  // language" get welded together, which §2.4 forbids.
  if (path === "i18n/locales" && method === "GET") {
    const [rows, enabled, dictionary, uiLocales] = await Promise.all([
      siteLocaleRows(env, siteId),
      siteLocales(env, siteId),
      platformLocales(env),
      availableUiLocales(env, siteId),
    ]);
    return ok({
      site: siteId,
      items: rows,
      enabled: enabled.map((l) => l.code),
      default: await siteDefaultLocale(env, siteId),
      multilingual: enabled.length >= 2,
      dictionary,
      ui_locales: uiLocales,
      core_locales: corePackLocales(),
    });
  }
  if (path === "i18n/locales" && method === "POST") {
    if (!(await requirePermission(env, user, "settings.manage"))) return ok({ error: "Forbidden" }, 403);
    const b = await jsonBody(request);
    const code = String(b.code ?? "").trim();
    if (!isLocaleCode(code)) return ok({ error: `invalid locale code: ${code}` }, 400);
    // Enabling a language nobody has a name for would leave the switcher blank,
    // so the dictionary entry is created from the same request.
    if (b.name) {
      await upsertPlatformLocale(env, {
        code,
        name: String(b.name),
        native_name: b.native_name ? String(b.native_name) : String(b.name),
        direction: b.direction === "rtl" ? "rtl" : "ltr",
        enabled: 1,
      });
    }
    await enableSiteLocale(env, siteId, code, { isDefault: b.is_default === true });
    // A second language is exactly the event that makes theme `_i18n` tables
    // exist (§2.5.3). Nothing else has to remember to do this.
    const created = await refreshThemeTableI18n(env, siteId);
    await activity(env, user.id, "enable", "locale", code, { site: siteId, i18nTables: created });
    return ok({ ok: true, code, created_i18n_tables: created }, 201);
  }
  const localeMatch = path.match(/^i18n\/locales\/([A-Za-z0-9-]{2,10})$/);
  if (localeMatch) {
    if (!(await requirePermission(env, user, "settings.manage"))) return ok({ error: "Forbidden" }, 403);
    const code = localeMatch[1];
    if (method === "PATCH" || method === "PUT") {
      const b = await jsonBody(request);
      if (b.is_default === true) await setSiteDefaultLocale(env, siteId, code);
      await activity(env, user.id, "update", "locale", code, { site: siteId });
      return ok({ ok: true, default: await siteDefaultLocale(env, siteId) });
    }
    if (method === "DELETE") {
      try {
        await disableSiteLocale(env, siteId, code);
      } catch (e: any) {
        return ok({ error: e?.message || "cannot disable locale" }, 400);
      }
      await activity(env, user.id, "disable", "locale", code, { site: siteId });
      return ok({ ok: true, enabled: await siteLocaleCodes(env, siteId) });
    }
  }
  if (path === "i18n/dictionary" && method === "GET") {
    return ok({ items: await platformLocales(env), core: corePackLocales() });
  }
  if (path === "i18n/dictionary" && method === "POST") {
    if (!(await requirePermission(env, user, "settings.manage"))) return ok({ error: "Forbidden" }, 403);
    const b = await jsonBody(request);
    const code = String(b.code ?? "").trim();
    if (!isLocaleCode(code)) return ok({ error: `invalid locale code: ${code}` }, 400);
    await upsertPlatformLocale(env, {
      code,
      name: String(b.name ?? code),
      native_name: b.native_name ? String(b.native_name) : null,
      direction: b.direction === "rtl" ? "rtl" : "ltr",
      enabled: b.enabled === false ? 0 : 1,
      sort_order: Number(b.sort_order ?? 0),
    });
    return ok({ ok: true, code }, 201);
  }
  // The admin's own interface language. Resolved through the pack stack, so a
  // language with no pack is refused rather than accepted and then rendered as
  // raw keys.
  if (path === "i18n/ui-locale") {
    if (method === "GET") {
      const ui = await resolveUiLocale(env, siteId, {
        userLang: (user as any).ui_lang ?? null,
        defaultLocale: await siteDefaultLocale(env, siteId),
      });
      return ok({
        locale: ui,
        user_preference: (user as any).ui_lang ?? null,
        available: await availableUiLocales(env, siteId),
      });
    }
    if (method === "POST") {
      const b = await jsonBody(request);
      const wanted = String(b.locale ?? "").trim();
      if (!wanted) {
        await setUserUiLang(env, user.id, null);
        return ok({ ok: true, locale: null });
      }
      const available = await availableUiLocales(env, siteId);
      if (!available.includes(wanted)) {
        return ok({ error: `no interface pack for "${wanted}"`, available }, 400);
      }
      await setUserUiLang(env, user.id, wanted);
      return ok({ ok: true, locale: wanted });
    }
  }
  // The admin SPA fetches its strings once per session. Returning the whole
  // merged stack (rather than one key per call) keeps the client free of a
  // per-string round trip and makes the layer precedence observable.
  if (path === "i18n/messages" && method === "GET") {
    const available = await availableUiLocales(env, siteId);
    const wanted = String(url.searchParams.get("locale") ?? "").trim();
    const locale = wanted && available.includes(wanted)
      ? wanted
      : await resolveUiLocale(env, siteId, {
          userLang: (user as any).ui_lang ?? null,
          defaultLocale: await siteDefaultLocale(env, siteId),
        });
    const packs = await loadUiPacks(env, siteId, locale);
    return ok({ locale, available, layers: packs.length, messages: mergePacks(packs) });
  }
  // Database override layer (§2.4 layer ④).
  if (path === "i18n/overrides") {
    if (method === "GET") {
      const locale = String(url.searchParams.get("locale") ?? "").trim();
      try {
        const r = locale
          ? await env.DB.prepare("SELECT key,value FROM i18n_overrides WHERE site_id=? AND locale=? ORDER BY key").bind(siteId, locale).all()
          : await env.DB.prepare("SELECT locale,key,value FROM i18n_overrides WHERE site_id=? ORDER BY locale,key").bind(siteId).all();
        return ok({ items: (r.results as any[]) ?? [] });
      } catch {
        return ok({ items: [] });
      }
    }
    if (method === "POST") {
      if (!(await requirePermission(env, user, "settings.manage"))) return ok({ error: "Forbidden" }, 403);
      const b = await jsonBody(request);
      const locale = String(b.locale ?? "").trim();
      const key = String(b.key ?? "").trim();
      if (!isLocaleCode(locale)) return ok({ error: "valid locale required" }, 400);
      if (!/^(core|theme|plugin)\.[a-z0-9_.-]+$/i.test(key)) {
        return ok({ error: "key must be namespaced core.* / theme.* / plugin.*" }, 400);
      }
      if (b.value === null || b.value === "") {
        await env.DB.prepare("DELETE FROM i18n_overrides WHERE site_id=? AND locale=? AND key=?")
          .bind(siteId, locale, key)
          .run();
        return ok({ ok: true, removed: true });
      }
      await env.DB.prepare(
        `INSERT INTO i18n_overrides(site_id,locale,key,value,updated_at) VALUES(?,?,?,?,?)
         ON CONFLICT(site_id,locale,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
      )
        .bind(siteId, locale, key, String(b.value), now())
        .run();
      return ok({ ok: true }, 201);
    }
  }
  // -- Content translation groups (L1) ------------------------------------
  if (path === "i18n/translations" && method === "GET") {
    const id = String(url.searchParams.get("id") ?? "").trim();
    if (!id) return ok({ error: "id required" }, 400);
    const group = await translationGroup(env, siteId, id);
    if (!group) return ok({ error: "not found" }, 404);
    return ok({ ...group, site: siteId });
  }
  if (path === "i18n/translations" && method === "POST") {
    if (!(await requirePermission(env, user, "content.write"))) return ok({ error: "Forbidden" }, 403);
    const b = await jsonBody(request);
    const id = String(b.id ?? "").trim();
    const locale = String(b.locale ?? "").trim();
    const mode = String(b.mode ?? "blank") === "copy" ? "copy" : "blank";
    if (!id) return ok({ error: "id required" }, 400);
    if (!isLocaleCode(locale)) return ok({ error: "valid locale required" }, 400);
    if (!(await siteLocaleCodes(env, siteId)).includes(locale)) {
      return ok({ error: `locale "${locale}" is not enabled for this site` }, 400);
    }
    const source = await env.DB.prepare(
      "SELECT id, type, slug, status, lang_group FROM posts WHERE id=? AND site_id=? LIMIT 1"
    )
      .bind(id, siteId)
      .first<any>();
    if (!source) return ok({ error: "source post not found" }, 404);
    const group = groupOf(source);
    const already = await env.DB.prepare(
      `SELECT p.id FROM posts p JOIN post_translations t ON t.post_id=p.id
        WHERE p.site_id=? AND ${GROUP_SQL}=? AND t.locale=? LIMIT 1`
    )
      .bind(siteId, group, locale)
      .first<any>();
    if (already) return ok({ error: `a ${locale} version already exists`, post_id: already.id }, 409);

    const newId = `${source.type}_${await randomId()}`;
    const slug = await freeSlug(env, siteId, String(source.type), String(source.slug));
    const ts = now();
    await env.DB.prepare(
      "INSERT INTO posts(id,site_id,author_id,type,slug,status,lang_group,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)"
    )
      .bind(newId, siteId, user.id, String(source.type), slug, "draft", group, ts, ts)
      .run();
    let title = "";
    let excerpt = "";
    let content = "";
    if (mode === "copy") {
      const src = await env.DB.prepare(
        "SELECT title,excerpt,content FROM post_translations WHERE post_id=? LIMIT 1"
      )
        .bind(id)
        .first<any>();
      title = String(src?.title ?? "");
      excerpt = String(src?.excerpt ?? "");
      content = String(src?.content ?? "");
    }
    await env.DB.prepare(
      "INSERT INTO post_translations(id,post_id,locale,title,excerpt,content,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)"
    )
      .bind(await randomId(), newId, locale, title, excerpt, content, ts, ts)
      .run();
    await bumpContentCache(env, siteId);
    await activity(env, user.id, "translate", String(source.type), newId, { from: id, locale, mode, site: siteId });
    return ok({ id: newId, locale, slug, mode, group }, 201);
  }
  // -- Theme-owned tables (L3) --------------------------------------------
  if (path === "theme-tables" && method === "GET") {
    const theme = await activeTheme(env, siteId).catch(() => null);
    const defs = await listThemeTableDefs(env, siteId);
    return ok({
      site: siteId,
      active_theme: theme?.name ?? null,
      items: defs.map((d) => ({
        ...d,
        active: d.theme_name === theme?.name,
      })),
    });
  }
  const ttMatch = path.match(/^theme-tables\/([a-z][a-z0-9_]{0,63})$/);
  if (ttMatch) {
    const def = await resolveTableForSite(env, siteId, ttMatch[1]);
    if (!def) return ok({ error: `no table "${ttMatch[1]}" is declared for this site` }, 404);
    const locale = String(url.searchParams.get("locale") ?? "").trim() || (await siteDefaultLocale(env, siteId));
    if (method === "GET") {
      const items = await tableList(env, def, {
        locale,
        limit: Number(url.searchParams.get("limit") ?? 50),
        offset: Number(url.searchParams.get("offset") ?? 0),
        status: url.searchParams.get("status"),
      });
      return ok({ def, locale, items });
    }
    if (method === "POST" || method === "PUT") {
      if (!(await requirePermission(env, user, "content.write"))) return ok({ error: "Forbidden" }, 403);
      const body = await jsonBody(request);
      try {
        const row = await tableSave(env, def, body, locale);
        return ok({ ok: true, locale, row }, 201);
      } catch (e: any) {
        return ok({ error: e?.message || "save failed" }, 400);
      }
    }
  }
  const ttRowMatch = path.match(/^theme-tables\/([a-z][a-z0-9_]{0,63})\/([^/]+)$/);
  if (ttRowMatch) {
    const def = await resolveTableForSite(env, siteId, ttRowMatch[1]);
    if (!def) return ok({ error: `no table "${ttRowMatch[1]}" is declared for this site` }, 404);
    const locale = String(url.searchParams.get("locale") ?? "").trim() || (await siteDefaultLocale(env, siteId));
    const slug = decodeURIComponent(ttRowMatch[2]);
    if (method === "GET") {
      const row = await tableBySlug(env, def, slug, locale);
      return row ? ok({ def, locale, row }) : ok({ error: "not found" }, 404);
    }
    if (method === "DELETE") {
      if (!(await requirePermission(env, user, "content.write"))) return ok({ error: "Forbidden" }, 403);
      const row = await tableBySlug(env, def, slug, locale);
      if (!row) return ok({ error: "not found" }, 404);
      await tableDelete(env, def, String(row.id));
      return ok({ ok: true });
    }
  }

  if (path === "dashboard" && method === "GET") {
    const [posts, pages, media, drafts] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS count FROM posts WHERE site_id=? AND type='post'").bind(siteId).first<any>(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM posts WHERE site_id=? AND type='page'").bind(siteId).first<any>(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM media_files").first<any>(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM posts WHERE site_id=? AND status='draft'").bind(siteId).first<any>()
    ]);
    return ok({ posts: posts?.count ?? 0, pages: pages?.count ?? 0, media: media?.count ?? 0, drafts: drafts?.count ?? 0, site: siteId });
  }

  if (path === "blocks" && method === "GET") return ok({ items: CORE_BLOCKS });
  if (path === "posts" && method === "GET") return listPosts(env, url, "post", siteId);
  if (path === "pages" && method === "GET") return listPosts(env, url, "page", siteId);
  if (path === "posts" && method === "POST") return savePost(env, user.id, null, await jsonBody(request), "post", siteId);
  if (path === "pages" && method === "POST") return savePost(env, user.id, null, await jsonBody(request), "page", siteId);

  // Theme-declared custom post type content: /api/v1/content/{type}
  const contentMatch = path.match(/^content\/([a-z][a-z0-9_-]{0,63})$/);
  if (contentMatch && method === "GET") {
    const type = contentMatch[1];
    const pt = await findActivePostType(env, type, siteId);
    if (!pt) return ok({ error: "unknown post type" }, 404);
    return listPosts(env, url, type, siteId);
  }
  if (contentMatch && method === "POST") {
    if(!(await requirePermission(env,user,"content.write"))) return ok({error:"Forbidden"},403);
    const type = contentMatch[1];
    const pt = await findActivePostType(env, type, siteId);
    if (!pt) return ok({ error: "unknown post type" }, 404);
    return savePost(env, user.id, null, await jsonBody(request), type, siteId);
  }
  const contentIdMatch = path.match(/^content\/([a-z][a-z0-9_-]{0,63})\/([^/]+)$/);
  if (contentIdMatch) {
    const type = contentIdMatch[1];
    const id = contentIdMatch[2];
    const pt = await findActivePostType(env, type, siteId);
    if (!pt) return ok({ error: "unknown post type" }, 404);
    if (method === "DELETE") {
      if(!(await requirePermission(env,user,"content.write"))) return ok({error:"Forbidden"},403);
      return deletePost(env, user.id, id, siteId);
    }
    if (method === "PUT") {
      if(!(await requirePermission(env,user,"content.write"))) return ok({error:"Forbidden"},403);
      return savePost(env, user.id, id, await jsonBody(request), type, siteId);
    }
    if (method === "GET") {
      const row = await env.DB.prepare(`
        SELECT p.*, t.locale, t.title, t.excerpt, t.content
        FROM posts p LEFT JOIN post_translations t ON t.post_id=p.id
        WHERE p.id=? ORDER BY t.locale
      `).bind(id).all();
      const items = (row.results as any[]) ?? [];
      const meta = await postMeta(env, id);
      return ok({ items: items.map((i) => ({ ...i, meta })) });
    }
  }

  const postMatch = path.match(/^(posts|pages)\/([^/]+)$/);
  if (postMatch) {
    const kind = postMatch[1] === "posts" ? "post" : "page";
    const id = postMatch[2];
    if (method === "DELETE") return deletePost(env, user.id, id, siteId);
    if (method === "PUT") return savePost(env, user.id, id, await jsonBody(request), kind, siteId);
    if (method === "GET") {
      const row = await env.DB.prepare(`
        SELECT p.*, t.locale, t.title, t.excerpt, t.content
        FROM posts p LEFT JOIN post_translations t ON t.post_id=p.id
        WHERE p.id=? ORDER BY t.locale
      `).bind(id).all();
      const items = (row.results as any[]) ?? [];
      // Attach theme-declared custom fields for the editor.
      const meta = await postMeta(env, id);
      return ok({ items: items.map((i) => ({ ...i, meta })) });
    }
  }

  if (path === "search" && method === "GET") {
    const q=String(url.searchParams.get("q")||"").trim(); const locale=String(url.searchParams.get("locale")||"en");
    if(!q)return ok({items:[]});
    const r=await env.DB.prepare(`SELECT p.id,p.type,p.slug,p.status,t.locale,t.title,t.excerpt FROM posts p JOIN post_translations t ON t.post_id=p.id WHERE p.site_id=? AND p.status='published' AND t.locale=? AND (t.title LIKE ? OR t.excerpt LIKE ? OR t.content LIKE ?) ORDER BY p.updated_at DESC LIMIT 50`).bind(siteId,locale,`%${q}%`,`%${q}%`,`%${q}%`).all();
    return ok({items:r.results});
  }

  if (path === "media" && method === "GET") return mediaList(env, siteId);
  if (path === "media" && method === "POST") return mediaUpload(env, user.id, request, siteId);
  if (path === "settings" && method === "GET") return settings(env, siteId);
  if (path === "settings" && method === "POST") { if(!(await requirePermission(env,user,"settings.manage"))) return ok({error:"Forbidden"},403); return saveSetting(env, user.id, await jsonBody(request), siteId); }

  const resourceMatch = path.match(/^(locales|redirects|rewrites|plugins|themes|menus|menu_items)$/);
  if (resourceMatch && method === "GET") return genericTable(env, resourceMatch[1], url, siteId);

  if (path === "menus" && method === "GET") {
    const rows=await env.DB.prepare("SELECT * FROM menus WHERE site_id=? ORDER BY name").bind(siteId).all(); return ok({items:rows.results,site:siteId});
  }
  if (path === "menus" && method === "POST") {
    const b=await jsonBody(request),id=b.id||`menu_${await randomId()}`;
    // Idempotent: re-declaring the same menu for a site updates it rather than
    // failing on the (site_id, id) primary key.
    await env.DB.prepare(
      "INSERT INTO menus (id,site_id,name,location,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(site_id,id) DO UPDATE SET name=excluded.name,location=excluded.location,updated_at=excluded.updated_at"
    ).bind(id,siteId,String(b.name||"Menu"),b.location||"header",now(),now()).run();
    return ok({id,site:siteId},201);
  }
  const mm=path.match(/^menus\/([^/]+)\/items$/);
  if(mm&&method==="GET"){const r=await env.DB.prepare("SELECT * FROM menu_items WHERE site_id=? AND menu_id=? ORDER BY sort_order,id").bind(siteId,mm[1]).all();return ok({items:r.results,site:siteId});}
  if(mm&&method==="POST"){const b=await jsonBody(request),id=await randomId();await env.DB.prepare("INSERT INTO menu_items (id,site_id,menu_id,parent_id,title,url,target,sort_order,locale,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(id,siteId,mm[1],b.parent_id||null,String(b.title||""),String(b.url||"#"),b.target||null,Number(b.sort_order||0),b.locale||null,now(),now()).run();return ok({id,site:siteId},201);}
  if (path === "extensions/bootstrap" && method === "POST") { await seedBundledExtensions(env); return ok({ok:true}); }
  if (path === "extensions/plugins" && method === "GET") {
    const rows=await env.DB.prepare("SELECT * FROM plugin_installs ORDER BY title").all();
    const runtime=await pluginRuntimeStatus(env).catch(()=>[]);
    const wired=Object.fromEntries(runtime.map(r=>[r.name,r.hooks]));
    return ok({items:((rows.results as any[])??[]).map(r=>({...r,hooks_wired:wired[r.name]??[]}))});
  }
  const pm=path.match(/^extensions\/plugins\/([^/]+)\/(enable|disable)$/);
  if(pm&&method==="POST"){
    await env.DB.prepare("UPDATE plugin_installs SET enabled=?,updated_at=? WHERE name=?").bind(pm[2]==="enable"?1:0,now(),pm[1]).run();
    if(pm[2]==="disable"){
      // Drop this plugin's menus — and only this plugin's. The registry is
      // keyed by owner so that disabling one extension cannot disturb a theme
      // or a different plugin. Re-enabling re-registers them from the manifest
      // in `loadEnabledPlugins`, so nothing is lost by deleting here.
      await clearPluginMenus(env,pm[1]);
    }
    // Rebuild the hook registry so the change is live for this isolate; the
    // memoised payload would otherwise keep the previous enabled-set for up
    // to `ENABLED_TTL_MS`.
    resetPluginRuntime();
    await bootPluginRuntime(env);
    await activity(env,user.id,pm[2],"plugin",pm[1]); return ok({ok:true});
  }
  if(path==="extensions/themes"&&method==="GET"){
    // `active` on theme_installs is a *global* flag and cannot express which
    // site uses which theme, so report per-site usage explicitly instead.
    const rows=await env.DB.prepare("SELECT * FROM theme_installs ORDER BY title").all();
    const active=await env.DB.prepare("SELECT site_id,value FROM settings WHERE key='theme.active'").all();
    const bySite=Object.fromEntries(((active.results as any[])??[]).map(r=>[r.site_id,r.value]));
    const activeForSite=bySite[siteId]??"default";
    return ok({
      items:((rows.results as any[])??[]).map(r=>({...r,active:r.name===activeForSite?1:0})),
      active:activeForSite,
      active_by_site:bySite,
      site:siteId,
    });
  }
  const tm=path.match(/^extensions\/themes\/([^/]+)\/activate$/);
  if(tm&&method==="POST"){
    if(!(await requirePermission(env,user,"extensions.manage"))) return ok({error:"Forbidden"},403);
    const target=tm[1];
    const row=await env.DB.prepare("SELECT name,version,manifest FROM theme_installs WHERE name=? LIMIT 1").bind(target).first<any>();
    if(!row)return ok({error:"theme not found"},404);
    let manifest:any;try{manifest=JSON.parse(String(row.manifest||"{}"))}catch{manifest={name:target,version:row.version}}

    // Activation is *per site*. The outgoing theme is whatever this site had
    // selected (from settings), not a global `active` flag — two sites may
    // legitimately run two different themes at once.
    const previousRow=await env.DB.prepare("SELECT value FROM settings WHERE site_id=? AND key='theme.active'").bind(siteId).first<any>();
    const previous=previousRow?.value?String(previousRow.value):null;
    if(previous && previous!==target){
      await clearThemeCapabilities(env,previous,siteId);
      // Drop the outgoing theme's loaded Worker so a later re-activation
      // re-reads the module from R2 instead of reusing the cached stub.
      invalidateThemeWorker(env,previous);
    }
    await env.DB.prepare("INSERT INTO settings(id,site_id,key,value,autoload) VALUES(?,?,?,?,1) ON CONFLICT(site_id,key) DO UPDATE SET value=excluded.value")
      .bind(`theme-active-${siteId}`,siteId,"theme.active",target).run();
    // A fresh activation must not reuse a stale module (the package may have
    // been re-uploaded between activations).
    invalidateThemeWorker(env,target);
    // `active` stays meaningful only as "some site uses this theme", which the
    // bundled-install seeding relies on; recompute it from the settings table.
    await env.DB.prepare("UPDATE theme_installs SET active=0").run();
    await env.DB.prepare("UPDATE theme_installs SET active=1, updated_at=? WHERE name IN (SELECT value FROM settings WHERE key='theme.active')").bind(now()).run();

    const applied=await applyThemeCapabilities(env,target,manifest,siteId);
    await bumpContentCache(env,siteId);
    await activity(env,user.id,"activate","theme",target,{previous,siteId,...applied});
    return ok({ok:true,theme:target,site:siteId,previous,applied});
  }

  // Theme business-capability introspection
  if(path==="theme/post-types"&&method==="GET") return ok({items:await listPostTypes(env,siteId),site:siteId});
  if(path==="theme/routes"&&method==="GET") return ok({items:await listRoutes(env,siteId),site:siteId});
  if(path==="theme/menus"&&method==="GET") return ok({items:await listThemeAdminMenus(env,siteId),site:siteId});
  // The unified view: theme menus and plugin menus in one list, grouped by
  // owner and already filtered by what this user may see (§4.4). The SPA
  // renders it verbatim rather than asking which extension kind produced each
  // item — that is the whole reason the registry exists.
  if(path==="admin-menus"&&method==="GET"){
    // One lookup per distinct capability, not per menu.
    const memo=new Map<string,boolean>();
    const canView=async(capability:string)=>{
      if(memo.has(capability)) return memo.get(capability)!;
      const allowed=await can(env,user,capability).catch(()=>false);
      memo.set(capability,allowed);
      return allowed;
    };
    const groups=await listAdminMenuGroups(env,siteId,{can:canView});
    return ok({site:siteId,groups,items:groups.flatMap(g=>g.items)});
  }
  if(path==="theme/blocks"&&method==="GET") return ok({items:await listThemeBlocks(env,siteId),site:siteId});
  if(path==="theme/fields"&&method==="GET") return ok({items:await listFieldDefs(env,siteId),site:siteId});
  if(path==="theme/taxonomies"&&method==="GET") return ok({items:await listTaxonomies(env,siteId),site:siteId});

  const tsm=path.match(/^theme\/([^/]+)\/settings$/);
  if(tsm&&method==="GET") return ok({items:await themeSettings(env,tsm[1])});
  if(tsm&&method==="POST"){
    if(!(await requirePermission(env,user,"settings.manage"))) return ok({error:"Forbidden"},403);
    const b=await jsonBody(request);
    const def=await env.DB.prepare("SELECT key FROM theme_setting_defs WHERE theme_name=? AND key=?").bind(tsm[1],String(b.key||"")).first<any>();
    if(!def)return ok({error:"setting not declared"},400);
    await env.DB.prepare("INSERT INTO theme_settings(theme_name,key,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(theme_name,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
      .bind(tsm[1],String(b.key),String(b.value??""),now()).run();
    await activity(env,user.id,"update","theme_setting",tsm[1],{key:b.key});
    return ok({ok:true});
  }
  const psm=path.match(/^extensions\/plugins\/([^/]+)\/settings$/);
  if(psm&&method==="GET") return pluginSettings(env,psm[1]);
  if(psm&&method==="POST") return savePluginSetting(env,user.id,psm[1],await jsonBody(request));

  if(path==="widgets"&&method==="GET"){
    const rows=await env.DB.prepare("SELECT * FROM widget_instances ORDER BY sidebar,sort_order").all();return ok({items:rows.results});
  }
  if(path==="widgets"&&method==="POST"){
    const b=await jsonBody(request),id=await randomId();
    await env.DB.prepare("INSERT INTO widget_instances (id,sidebar,widget_type,title,config,sort_order,enabled) VALUES (?,?,?,?,?,?,?)")
      .bind(id,b.sidebar||"sidebar",b.widget_type||"text",b.title||"",JSON.stringify(b.config||{}),Number(b.sort_order||0),b.enabled===false?0:1).run();
    return ok({id},201);
  }
  const uploadMatch=path.match(/^extensions\/(plugins|themes)\/upload$/);
  if(uploadMatch&&method==="POST") { if(!(await requirePermission(env,user,"extensions.manage"))) return ok({error:"Forbidden"},403); return uploadExtension(env,user.id,request,uploadMatch[1]==="plugins"?"plugin":"theme"); }
  if(path==="extensions/versions"&&method==="GET"){
    const type=url.searchParams.get("type");const name=url.searchParams.get("name");
    const r= type&&name ? await env.DB.prepare("SELECT * FROM extension_versions WHERE extension_type=? AND extension_name=? ORDER BY installed_at DESC").bind(type,name).all() : await env.DB.prepare("SELECT * FROM extension_versions ORDER BY installed_at DESC LIMIT 200").all();
    return ok({items:r.results});
  }
  const capm=path.match(/^extensions\/(plugins|themes)\/([^/]+)\/capabilities$/);
  if(capm&&method==="GET") return ok({items:await capabilityList(env,capm[1]==="plugins"?"plugin":"theme",capm[2])});
  const revm=path.match(/^(posts|pages)\/([^/]+)\/revisions$/);
  if(revm&&method==="GET") {const r=await env.DB.prepare("SELECT * FROM post_revisions WHERE post_id=? ORDER BY locale,version DESC LIMIT 200").bind(revm[2]).all();return ok({items:r.results});}
  if(revm&&method==="POST") {const b=await jsonBody(request);const v=await createRevision(env,revm[2],user.id,String(b.locale||"en"),String(b.title||""),String(b.excerpt||""),typeof b.content==="string"?b.content:JSON.stringify(b.content||[]));return ok({version:v},201);}
  const am=path.match(/^(posts|pages)\/([^/]+)\/autosave$/);
  if(am&&method==="GET"){const locale=url.searchParams.get("locale")||"en";const r=await env.DB.prepare("SELECT * FROM post_autosaves WHERE post_id=? AND user_id=? AND locale=?").bind(am[2],user.id,locale).first();return ok({item:r||null});}
  if(am&&method==="POST"){const b=await jsonBody(request);await autosave(env,am[2],user.id,String(b.locale||"en"),b);return ok({ok:true,updated_at:now()});}
  const restore=path.match(/^(posts|pages)\/([^/]+)\/revisions\/([^/]+)\/restore$/);
  if(restore&&method==="POST"){
    const r=await env.DB.prepare("SELECT * FROM post_revisions WHERE id=? AND post_id=?").bind(restore[3],restore[2]).first<any>();
    if(!r)return ok({error:"revision not found"},404);
    return savePost(env,user.id,restore[2],{locale:r.locale,title:r.title,excerpt:r.excerpt,content:r.content},restore[1]==="posts"?"post":"page",siteId);
  }

  if (path === "users" && method === "GET") {
    if(!(await requirePermission(env,user,"users.manage"))) return ok({error:"Forbidden"},403);
    const r=await env.DB.prepare("SELECT id,username,email,role,status,created_at,updated_at FROM site_users ORDER BY username").all(); return ok({items:r.results});
  }
  if (path === "users" && method === "POST") {
    if(!(await requirePermission(env,user,"users.manage"))) return ok({error:"Forbidden"},403);
    const b=await jsonBody(request); const role=String(b.role||"author");
    if(!["admin","editor","author"].includes(role)) return ok({error:"invalid role"},400);
    const username=String(b.username||"").trim(); const password=String(b.password||"");
    if(!username||password.length<8)return ok({error:"username and password(min 8) required"},400);
    const {hashPassword}=await import("./shared/crypto"); const id="user_"+await randomId();
    await env.DB.prepare("INSERT INTO site_users(id,username,email,password_hash,role,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").bind(id,username,b.email||null,await hashPassword(password),role,"active",now(),now()).run();
    await activity(env,user.id,"create","user",id,{username,role}); return ok({id},201);
  }

  if (path === "activity" && method === "GET") {
    const rows = await env.DB.prepare("SELECT * FROM admin_activity ORDER BY created_at DESC LIMIT 100").all();
    return ok({ items: rows.results });
  }

  return ok({ error: "Not found" }, 404);
}
