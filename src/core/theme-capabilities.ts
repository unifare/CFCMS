/**
 * Theme capability installation.
 *
 * When a theme is activated, its manifest declarations (post types, taxonomies,
 * fields, routes, admin menus, blocks, settings) are materialised into the
 * database. When it is deactivated, its declarations are marked inactive but
 * the *data* is preserved, so switching back restores everything.
 */
import { Env } from "../types";
import { now } from "./repo";
import { randomId } from "./crypto";
import type {
  ThemeManifest,
  ThemePostType,
  ThemeTaxonomy,
  ThemeField,
  ThemeRoute,
  ThemeAdminMenu,
  ThemeBlock,
  ThemeSettingDef,
} from "./theme-runtime";

export interface ApplyResult {
  postTypes: number;
  taxonomies: number;
  fields: number;
  routes: number;
  adminMenus: number;
  blocks: number;
  settings: number;
}

/**
 * Write a theme's declarations into the database, replacing anything it
 * declared previously. Runs inside the request that activates the theme.
 */
export async function applyThemeCapabilities(
  env: Env,
  themeName: string,
  manifest: ThemeManifest,
  siteId = "default"
): Promise<ApplyResult> {
  const ts = now();
  const result: ApplyResult = {
    postTypes: 0,
    taxonomies: 0,
    fields: 0,
    routes: 0,
    adminMenus: 0,
    blocks: 0,
    settings: 0,
  };

  // Re-declaring from the same theme is idempotent: clear its previous
  // declarations (but never touch rows declared by other themes).
  await clearThemeCapabilities(env, themeName, siteId);

  for (const pt of manifest.postTypes ?? []) {
    if (!validName(pt.name)) continue;
    await env.DB.prepare(
      `INSERT INTO post_types(name,site_id,label,singular_label,plural_label,supports,has_archive,rewrite_slug,declared_by_theme,active,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,1,?,?)
       ON CONFLICT(site_id,name) DO UPDATE SET
         label=excluded.label, singular_label=excluded.singular_label, plural_label=excluded.plural_label,
         supports=excluded.supports, has_archive=excluded.has_archive, rewrite_slug=excluded.rewrite_slug,
         declared_by_theme=excluded.declared_by_theme, active=1, updated_at=excluded.updated_at`
    )
      .bind(
        pt.name,
        siteId,
        pt.label ?? pt.labels?.plural ?? pt.name,
        pt.labels?.singular ?? pt.label ?? pt.name,
        pt.labels?.plural ?? pt.label ?? pt.name,
        JSON.stringify(pt.supports ?? ["title", "editor"]),
        pt.hasArchive ? 1 : 0,
        pt.rewrite?.slug ?? null,
        themeName,
        ts,
        ts
      )
      .run();
    result.postTypes++;
  }

  for (const tax of manifest.taxonomies ?? []) {
    if (!validName(tax.name)) continue;
    await env.DB.prepare(
      `INSERT INTO taxonomies(name,site_id,label,post_types,hierarchical,declared_by_theme,active,created_at,updated_at)
       VALUES(?,?,?,?,?,?,1,?,?)
       ON CONFLICT(site_id,name) DO UPDATE SET
         label=excluded.label, post_types=excluded.post_types, hierarchical=excluded.hierarchical,
         declared_by_theme=excluded.declared_by_theme, active=1, updated_at=excluded.updated_at`
    )
      .bind(tax.name, siteId, tax.label ?? tax.name, JSON.stringify(tax.postTypes ?? []), tax.hierarchical ? 1 : 0, themeName, ts, ts)
      .run();
    result.taxonomies++;
  }

  for (const f of manifest.fields ?? []) {
    if (!f.key || !/^[a-z0-9_][a-z0-9_-]{0,63}$/i.test(f.key)) continue;
    await env.DB.prepare(
      `INSERT INTO field_defs(id,site_id,meta_key,label,field_type,post_types,required,default_value,sort_order,declared_by_theme,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(site_id,meta_key) DO UPDATE SET
         label=excluded.label, field_type=excluded.field_type, post_types=excluded.post_types,
         required=excluded.required, default_value=excluded.default_value,
         declared_by_theme=excluded.declared_by_theme, updated_at=excluded.updated_at`
    )
      .bind(
        scopedId("field", siteId, f.key),
        siteId,
        f.key,
        f.label ?? f.key,
        f.type ?? "text",
        JSON.stringify(f.postTypes ?? []),
        f.required ? 1 : 0,
        f.default === undefined ? null : JSON.stringify(f.default),
        result.fields,
        themeName,
        ts,
        ts
      )
      .run();
    result.fields++;
  }

  for (const r of manifest.routes ?? []) {
    if (!r.path || !r.template) continue;
    const normalised = r.path.startsWith("/") ? r.path : `/${r.path}`;
    await env.DB.prepare(
      `INSERT INTO theme_routes(id,site_id,path,template,title,query_json,resolve_json,sort_order,declared_by_theme,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(site_id,path) DO UPDATE SET
         template=excluded.template, title=excluded.title, query_json=excluded.query_json,
         resolve_json=excluded.resolve_json,
         sort_order=excluded.sort_order, declared_by_theme=excluded.declared_by_theme, updated_at=excluded.updated_at`
    )
      .bind(
        scopedId("route", siteId, r.path),
        siteId,
        normalised,
        r.template,
        r.title ?? null,
        JSON.stringify(r.query ?? {}),
        r.resolve ? JSON.stringify(r.resolve) : null,
        result.routes,
        themeName,
        ts,
        ts
      )
      .run();
    result.routes++;
  }

  for (const m of manifest.adminMenus ?? []) {
    if (!m.id || !m.screen) continue;
    await env.DB.prepare(
      `INSERT INTO theme_admin_menus(id,site_id,menu_id,label,icon,screen,args_json,sort_order,declared_by_theme,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(site_id,menu_id) DO UPDATE SET
         label=excluded.label, icon=excluded.icon, screen=excluded.screen,
         args_json=excluded.args_json, sort_order=excluded.sort_order,
         declared_by_theme=excluded.declared_by_theme, updated_at=excluded.updated_at`
    )
      .bind(scopedId("tam", siteId, m.id), siteId, m.id, m.label ?? m.id, m.icon ?? null, m.screen, JSON.stringify(m.args ?? {}), result.adminMenus, themeName, ts, ts)
      .run();
    result.adminMenus++;
  }

  for (const b of manifest.blocks ?? []) {
    if (!b.name) continue;
    await env.DB.prepare(
      `INSERT INTO theme_blocks(id,site_id,name,title,template,declared_by_theme,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(site_id,name) DO UPDATE SET
         title=excluded.title, template=excluded.template, declared_by_theme=excluded.declared_by_theme, updated_at=excluded.updated_at`
    )
      .bind(scopedId("block", siteId, b.name), siteId, b.name, b.title ?? b.name, b.template ?? null, themeName, ts, ts)
      .run();
    result.blocks++;
  }

  for (const s of manifest.settings ?? []) {
    if (!s.key) continue;
    await env.DB.prepare(
      `INSERT INTO theme_setting_defs(theme_name,key,label,type,default_value)
       VALUES(?,?,?,?,?)
       ON CONFLICT(theme_name,key) DO UPDATE SET label=excluded.label, type=excluded.type, default_value=excluded.default_value`
    )
      .bind(themeName, s.key, s.label ?? s.key, s.type ?? "text", s.default === undefined ? null : String(s.default))
      .run();
    result.settings++;
  }

  await env.DB.prepare("UPDATE theme_installs SET manifest=?, updated_at=? WHERE name=?")
    .bind(JSON.stringify(manifest), ts, themeName)
    .run();

  return result;
}

/**
 * Mark everything a theme declared as inactive. Data rows (posts, terms,
 * meta) are deliberately left intact so reactivating restores the site.
 */
export async function clearThemeCapabilities(
  env: Env,
  themeName: string,
  siteId = "default"
): Promise<void> {
  const ts = now();
  const statements = [
    env.DB.prepare("DELETE FROM post_types WHERE site_id=? AND declared_by_theme=?").bind(siteId, themeName),
    env.DB.prepare("DELETE FROM taxonomies WHERE site_id=? AND declared_by_theme=?").bind(siteId, themeName),
    env.DB.prepare("DELETE FROM field_defs WHERE site_id=? AND declared_by_theme=?").bind(siteId, themeName),
    env.DB.prepare("DELETE FROM theme_routes WHERE site_id=? AND declared_by_theme=?").bind(siteId, themeName),
    env.DB.prepare("DELETE FROM theme_admin_menus WHERE site_id=? AND declared_by_theme=?").bind(siteId, themeName),
    env.DB.prepare("DELETE FROM theme_blocks WHERE site_id=? AND declared_by_theme=?").bind(siteId, themeName),
  ];
  for (const s of statements) await s.run().catch(() => {});
  // Settings are per-theme; keep definitions but they simply stop being used.
  void ts;
}

// ---------------------------------------------------------------------------
// Readers used by the API and the router
// ---------------------------------------------------------------------------

export interface PostTypeRow {
  name: string;
  label: string;
  singular_label: string | null;
  plural_label: string | null;
  supports: string[];
  has_archive: number;
  rewrite_slug: string | null;
}

export async function listPostTypes(env: Env, siteId = "default"): Promise<PostTypeRow[]> {
  try {
    const r = await env.DB.prepare(
      "SELECT * FROM post_types WHERE site_id=? AND active=1 ORDER BY name"
    )
      .bind(siteId)
      .all();
    return ((r.results as any[]) ?? []).map((row) => ({
      ...row,
      supports: safeJsonArray(row.supports),
    }));
  } catch {
    return [];
  }
}

/** Find a post type by its rewrite slug (used for front-end routing). */
export async function findPostTypeBySlug(
  env: Env,
  slug: string,
  siteId = "default"
): Promise<PostTypeRow | null> {
  const all = await listPostTypes(env, siteId);
  return all.find((pt) => (pt.rewrite_slug ?? pt.name) === slug) ?? null;
}

export async function listRoutes(env: Env, siteId = "default") {
  try {
    const r = await env.DB.prepare(
      "SELECT * FROM theme_routes WHERE site_id=? ORDER BY sort_order"
    )
      .bind(siteId)
      .all();
    return (r.results as any[]) ?? [];
  } catch {
    return [];
  }
}

export interface TaxonomyRow {
  name: string;
  label: string;
  post_types: any[];
  hierarchical: number;
}

export async function listTaxonomies(env: Env, siteId = "default"): Promise<TaxonomyRow[]> {
  try {
    const r = await env.DB.prepare(
      "SELECT * FROM taxonomies WHERE site_id=? AND active=1 ORDER BY name"
    )
      .bind(siteId)
      .all();
    return ((r.results as any[]) ?? []).map((row) => ({
      ...row,
      post_types: safeJsonArray(row.post_types),
    }));
  } catch {
    return [];
  }
}

export async function listThemeAdminMenus(env: Env, siteId = "default") {
  try {
    const r = await env.DB.prepare(
      "SELECT * FROM theme_admin_menus WHERE site_id=? ORDER BY sort_order, menu_id"
    )
      .bind(siteId)
      .all();
    return ((r.results as any[]) ?? []).map((row) => ({
      ...row,
      args: safeJsonObject(row.args_json),
    }));
  } catch {
    return [];
  }
}

export async function listThemeBlocks(env: Env, siteId = "default") {
  try {
    const r = await env.DB.prepare("SELECT * FROM theme_blocks WHERE site_id=? ORDER BY name")
      .bind(siteId)
      .all();
    return (r.results as any[]) ?? [];
  } catch {
    return [];
  }
}

export async function listFieldDefs(env: Env, siteId = "default") {
  try {
    const r = await env.DB.prepare(
      "SELECT * FROM field_defs WHERE site_id=? ORDER BY sort_order, meta_key"
    )
      .bind(siteId)
      .all();
    return ((r.results as any[]) ?? []).map((row) => ({
      ...row,
      post_types: safeJsonArray(row.post_types),
    }));
  } catch {
    return [];
  }
}

export async function themeSettings(env: Env, themeName: string) {
  try {
    const defs = await env.DB.prepare(
      "SELECT * FROM theme_setting_defs WHERE theme_name=? ORDER BY key"
    )
      .bind(themeName)
      .all();
    const vals = await env.DB.prepare("SELECT key,value FROM theme_settings WHERE theme_name=?")
      .bind(themeName)
      .all();
    const map = Object.fromEntries(((vals.results as any[]) ?? []).map((v) => [v.key, v.value]));
    return ((defs.results as any[]) ?? []).map((d) => ({
      ...d,
      value: map[d.key] ?? d.default_value ?? "",
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validName(name: unknown): boolean {
  return typeof name === "string" && /^[a-z][a-z0-9_-]{1,63}$/.test(name);
}

/**
 * Primary keys in the declaration tables are global, but the natural key is
 * per-site. Two sites may declare the same meta key / route / menu id, so the
 * synthetic id must embed the site to avoid a cross-site UNIQUE collision.
 */
function scopedId(prefix: string, siteId: string, value: string): string {
  const safeSite = String(siteId).replace(/[^a-z0-9]+/gi, "_");
  const safeValue = String(value).replace(/[^a-z0-9]+/gi, "_");
  return `${prefix}_${safeSite}_${safeValue}`;
}

function safeJsonArray(v: unknown): any[] {
  try {
    const parsed = JSON.parse(String(v ?? "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeJsonObject(v: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(v ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export { randomId };
