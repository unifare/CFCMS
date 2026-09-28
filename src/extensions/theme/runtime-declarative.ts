/**
 * Theme runtime: binds the template engine to R2-stored theme files, the
 * content database and the template hierarchy resolver.
 *
 * This replaces the old `replaceAll`-based renderer. Templates are now real
 * programs (conditions, loops, includes, inheritance, queries) interpreted by
 * `template-engine.ts` — never evaluated as JavaScript, which keeps the
 * Worker's security model intact.
 */
import { Env } from "../../shared/types";
import { esc, setting, siteInfo, menu, locales, renderBlocks, latestPosts } from "../../platform/frontend";
import { resolveTemplate, templateCandidates, type TemplateContext } from "../../rendering/template-resolver";
import { renderTemplateSource, TemplateError, type RenderOptions } from "../../rendering/template-engine";
import { NULL_HOOKS, hostHooks, type HostHooks } from "../contract/hooks";

// ---------------------------------------------------------------------------
// Theme discovery
// ---------------------------------------------------------------------------

export interface ActiveTheme {
  name: string;
  version: string;
  manifest: ThemeManifest;
}

export interface ThemeManifest {
  name: string;
  title: string;
  version: string;
  templates?: string[];
  parts?: string[];
  postTypes?: ThemePostType[];
  taxonomies?: ThemeTaxonomy[];
  fields?: ThemeField[];
  routes?: ThemeRoute[];
  adminMenus?: ThemeAdminMenu[];
  blocks?: ThemeBlock[];
  settings?: ThemeSettingDef[];
  capabilities?: string[];
  runtime?: "declarative" | "worker";
}

export interface ThemePostType {
  name: string;
  label?: string;
  labels?: { singular?: string; plural?: string };
  supports?: string[];
  hasArchive?: boolean;
  rewrite?: { slug?: string };
}

export interface ThemeTaxonomy {
  name: string;
  label?: string;
  postTypes?: string[];
  hierarchical?: boolean;
}

export interface ThemeField {
  key: string;
  label?: string;
  type: string;
  postTypes?: string[];
  required?: boolean;
  default?: unknown;
}

export interface ThemeRoute {
  path: string;
  template: string;
  /** Heading shown on the rendered archive. Falls back to the template name. */
  title?: string;
  query?: Record<string, unknown>;
  resolve?: { type: string; by?: "slug" | "id" };
}

export interface ThemeAdminMenu {
  id: string;
  label: string;
  icon?: string;
  screen: string;
  args?: Record<string, unknown>;
}

export interface ThemeBlock {
  name: string;
  title?: string;
  template?: string;
}

export interface ThemeSettingDef {
  key: string;
  label?: string;
  type?: string;
  default?: unknown;
}

/**
 * Resolve the active theme for a site.
 *
 * A missing `theme.active` setting is ambiguous: the string we would use as a
 * fallback is also a legitimate theme name (`default`), so a site whose
 * setting was never written looks exactly like a site that deliberately chose
 * the bundled theme — and, because the bundled theme has no R2 files, every
 * page then renders the bare `__fallback__` shell. That is a silent, very
 * confusing failure.
 *
 * So when no setting exists we do not guess by name. We walk the installed
 * themes and pick the first one whose package is actually present in R2
 * (probed by its `index.html`, the one template the hierarchy always ends
 * at), which guarantees the result can really render. Only if nothing is
 * loadable do we fall back to the literal `default`.
 */
export async function activeTheme(env: Env, siteId: string): Promise<ActiveTheme> {
  let name = await setting(env, "theme.active", "", siteId);
  if (!name) {
    // No explicit choice for this site: find one that can actually render.
    const candidates = await env.DB.prepare(
      "SELECT name, version FROM theme_installs ORDER BY active DESC, installed_at ASC"
    ).all<any>();
    for (const c of (candidates.results as any[]) ?? []) {
      const probe = `extensions/themes/${c.name}/${c.version}/files/templates/index.html`;
      const obj = await env.MEDIA.get(probe);
      if (obj) { name = String(c.name); break; }
    }
    if (!name) name = "default";
  }
  const row = await env.DB.prepare(
    "SELECT name, version, manifest FROM theme_installs WHERE name=? LIMIT 1"
  )
    .bind(name)
    .first<any>();
  if (!row) {
    return { name, version: "1.0.0", manifest: { name, title: name, version: "1.0.0" } };
  }
  let manifest: ThemeManifest;
  try {
    manifest = JSON.parse(String(row.manifest ?? "{}"));
  } catch {
    manifest = { name: row.name, title: row.name, version: row.version };
  }
  // A manifest with no explicit name would break key construction downstream.
  if (!manifest.name) manifest.name = String(row.name);
  if (!manifest.version) manifest.version = String(row.version);
  return { name: String(row.name), version: String(row.version), manifest };
}

// ---------------------------------------------------------------------------
// Template loading (R2)
// ---------------------------------------------------------------------------

/** R2 key prefix holding a theme version's unpacked files. */
export function themeFilePrefix(theme: ActiveTheme): string {
  return `extensions/themes/${theme.name}/${theme.version}/files`;
}

/**
 * Load a template by logical name, e.g. `single-product`. `name` may contain
 * subdirectories such as `parts/card`. Returns null when absent.
 */
export async function loadThemeTemplate(
  env: Env,
  theme: ActiveTheme,
  name: string,
  cache?: Map<string, string | null>
): Promise<string | null> {
  if (cache?.has(name)) return cache.get(name)!;
  const key = `${themeFilePrefix(theme)}/templates/${name}.html`;
  const obj = await env.MEDIA.get(key);
  const text = obj ? await obj.text() : null;
  cache?.set(name, text);
  return text;
}

// ---------------------------------------------------------------------------
// Query resolution for {{@query ...}}
// ---------------------------------------------------------------------------

interface QueryRow {
  id: string;
  slug: string;
  type: string;
  status: string;
  created_at: number;
  updated_at: number;
  locale: string;
  title: string | null;
  excerpt: string | null;
  content: string | null;
}

const QUERY_ORDER_WHITELIST = new Set([
  "created_at",
  "updated_at",
  "title",
  "slug",
  "published_at",
]);

/**
 * Execute a declarative `@query`. Params are validated against a whitelist so
 * a template can never reach arbitrary SQL.
 */
export async function runThemeQuery(
  env: Env,
  params: Record<string, string | number>,
  scope: Record<string, unknown>,
  siteId: string
): Promise<QueryRow[]> {
  const type = params.type ? String(params.type) : "post";
  const locale = params.locale ? String(params.locale) : String(scope.locale ?? "en");
  const status = params.status ? String(params.status) : "published";
  const limit = Math.min(100, Math.max(1, Number(params.limit ?? 10)));
  const offset = Math.max(0, Number(params.offset ?? 0));

  // `order` looks like "created_at desc".
  const rawOrder = String(params.order ?? "created_at desc").trim().split(/\s+/);
  const orderCol = QUERY_ORDER_WHITELIST.has(rawOrder[0]) ? rawOrder[0] : "created_at";
  const orderDir = String(rawOrder[1] ?? "desc").toLowerCase() === "asc" ? "ASC" : "DESC";

  const conditions: string[] = ["p.site_id = ?", "p.type = ?", "p.status = ?", "t.locale = ?"];
  const binds: unknown[] = [siteId, type, status, locale];

  if (params.slug) {
    conditions.push("p.slug = ?");
    binds.push(String(params.slug));
  }
  if (params.ids && typeof params.ids === "string") {
    const ids = params.ids.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 50);
    if (ids.length) {
      conditions.push(`p.id IN (${ids.map(() => "?").join(",")})`);
      binds.push(...ids);
    }
  }
  // Exclude the object currently being viewed (useful for "related" blocks).
  if (params.exclude_current === "true" && scope.post && (scope.post as any).id) {
    conditions.push("p.id != ?");
    binds.push(String((scope.post as any).id));
  }

  const sql = `SELECT p.id, p.slug, p.type, p.status, p.created_at, p.updated_at,
                      t.locale, t.title, t.excerpt, t.content
               FROM posts p JOIN post_translations t ON t.post_id = p.id
               WHERE ${conditions.join(" AND ")}
               ORDER BY p.${orderCol} ${orderDir}
               LIMIT ? OFFSET ?`;
  binds.push(limit, offset);

  const rows = await env.DB.prepare(sql).bind(...binds).all();
  const items = (rows.results as any[]) ?? [];
  await attachMeta(env, items);
  return items as QueryRow[];
}

/** Attach theme-declared custom fields to query results as `meta`. */
async function attachMeta(env: Env, rows: any[]): Promise<void> {
  if (!rows.length) return;
  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(",");
  let metaRows: any[] = [];
  try {
    const res = await env.DB.prepare(
      `SELECT post_id, meta_key, meta_value FROM post_meta WHERE post_id IN (${placeholders})`
    )
      .bind(...ids)
      .all();
    metaRows = (res.results as any[]) ?? [];
  } catch {
    metaRows = []; // table may not exist on a pre-0008 database
  }
  const byPost = new Map<string, Record<string, string>>();
  for (const m of metaRows) {
    const bucket = byPost.get(m.post_id) ?? {};
    bucket[m.meta_key] = m.meta_value;
    byPost.set(m.post_id, bucket);
  }
  for (const row of rows) {
    row.meta = byPost.get(row.id) ?? {};
    // Expose a rendered HTML form for convenience in templates.
    row.html = row.content ? renderBlocks(String(row.content)) : "";
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface ThemeRenderOptions {
  /**
   * The site being rendered. Required, not optional: the renderer resolves the
   * active theme, settings and cache namespace from it, so a missing value
   * cannot be papered over with a default without rendering another site's
   * content. `locale` is the *content* locale (L1); `siteId` is orthogonal.
   */
  siteId: string;
  locale: string;
  path: string;
  kind: TemplateContext["kind"];
  postType?: string;
  slug?: string;
  taxonomy?: string;
  term?: string;
  title: string;
  description?: string;
  /** The current object, exposed to templates as `post`. */
  post?: Record<string, unknown>;
  /** Pre-built scope additions (e.g. `posts` on an archive). */
  extra?: Record<string, unknown>;
  /**
   * The plugin hook dispatcher.
   *
   * Optional only so that tests and narrow call sites can render without
   * setting up the plugin runtime. When absent we read the process-wide slot
   * (`hostHooks()`), which `index.ts` fills at boot and which falls back to
   * `NULL_HOOKS` — behaving exactly like "this site has no plugins". The theme
   * layer never imports `plugin/`; see `contract/hooks.ts` for why.
   */
  hooks?: HostHooks;
}

/**
 * Resolve the hook dispatcher for a render.
 *
 * Centralised so no call site has to remember the fallback, and so the
 * "no plugins installed" case is indistinguishable from "not yet injected".
 */
function hooksOf(o: ThemeRenderOptions): HostHooks {
  return o.hooks ?? hostHooks() ?? NULL_HOOKS;
}

/** Build the base scope every template can rely on. */
export async function buildScope(
  env: Env,
  theme: ActiveTheme,
  o: ThemeRenderOptions
): Promise<Record<string, unknown>> {
  const siteId = o.siteId;
  const [s, items, ls] = await Promise.all([
    siteInfo(env, siteId),
    menu(env, o.locale, siteId),
    locales(env, siteId),
  ]);
  const navItems = (items as any[]).map((i) => ({
    title: i.title,
    url: i.url,
    target: i.target ?? null,
  }));
  // Plugins may contribute extra scope keys via the `beforeRender` action by
  // mutating the payload object handed to them.
  const extra: Record<string, unknown> = { ...(o.extra ?? {}) };
  const hooks = hooksOf(o);
  await hooks.boot(env);
  try {
    await hooks.doAction("beforeRender", { env, siteId }, { siteId, locale: o.locale, path: o.path, kind: o.kind, scope: extra });
  } catch {
    /* a failing plugin must not break rendering */
  }
  return {
    site: { title: s.title, description: s.description, robots: s.robots, locale: o.locale },
    page: {
      title: o.title,
      description: o.description ?? s.description,
      path: o.path,
      kind: o.kind,
      // Ready-to-render <title> text. A theme cannot compare two strings in
      // the template language, so the "do not repeat the site name" rule is
      // applied here: on the front page `title` already *is* the site title,
      // and naively appending the suffix yields "My Shop | My Shop".
      document_title:
        o.title && s.title && o.title !== s.title ? `${o.title} | ${s.title}` : o.title || s.title,
    },
    locale: o.locale,
    locales: (ls as any[]).map((l) => ({ code: l.code, name: l.name, is_default: l.is_default })),
    menu: {
      primary: navItems,
      // Convenience: pre-rendered anchor markup for the legacy placeholder.
      primary_html: navItems.map((i) => `<a href="${esc(i.url)}">${esc(i.title)}</a>`).join(" "),
    },
    post: o.post ?? null,
    theme: { name: theme.name, version: theme.version, title: theme.manifest.title },
    ...extra,
  };
}

export interface ThemeRenderResult {
  html: string;
  template: string;
  tried: string[];
  error?: string;
}

/**
 * Render a themed page. On any template error we surface the message in dev
 * and fall back to a minimal shell so the site stays up.
 */
export async function renderThemePage(
  env: Env,
  o: ThemeRenderOptions
): Promise<ThemeRenderResult> {
  const theme = await activeTheme(env, o.siteId);
  const cache = new Map<string, string | null>();
  const load = (name: string) => loadThemeTemplate(env, theme, name, cache);

  const ctx: TemplateContext = {
    kind: o.kind,
    postType: o.postType,
    slug: o.slug,
    taxonomy: o.taxonomy,
    term: o.term,
  };

  const resolved = await resolveTemplate(ctx, load, () => minimalShell(o));
  if (!resolved) {
    return { html: minimalShell(o), template: "__none__", tried: templateCandidates(ctx) };
  }

  const scope = await buildScope(env, theme, o);
  const opts: RenderOptions = {
    loadTemplate: load,
    runQuery: (params, sc) => runThemeQuery(env, params, sc, o.siteId ?? "default"),
  };

  try {
    let html = await renderTemplateSource(resolved.source, scope, opts);
    html = await decorateOutput(env, o, resolved.name, html);
    return { html, template: resolved.name, tried: resolved.tried };
  } catch (e) {
    const message = e instanceof TemplateError ? e.message : "Template rendering failed";
    // Never leak template internals to end users in production.
    const html = minimalShell(o, message);
    return { html, template: resolved.name, tried: resolved.tried, error: message };
  }
}

/**
 * Post-render pipeline shared by every themed page:
 *   1. expand `[shortcode]` markup,
 *   2. fire the `html` filter so enabled plugins can rewrite the document.
 *
 * A plugin throwing must never take the page down, so each stage is isolated
 * and the document falls back to whatever the previous stage produced.
 */
async function decorateOutput(env: Env, o: ThemeRenderOptions, template: string, html: string): Promise<string> {
  const hooks = hooksOf(o);
  await hooks.boot(env);
  const siteId = o.siteId;
  const ctx = { env, siteId };

  let out = html;
  try {
    out = await hooks.renderShortcodes(env, out);
  } catch {
    /* a broken shortcode leaves the raw markup in place */
  }
  try {
    const filtered = await hooks.applyFilters("html", ctx, out);
    if (typeof filtered === "string") out = filtered;
  } catch {
    /* a broken filter leaves the previous stage's output */
  }
  return out;
}

/** Absolute last-resort shell used when a theme is missing or broken. */
export function minimalShell(o: ThemeRenderOptions, error?: string): string {
  const note = error ? `<p class="cfpress-error">Template error: ${esc(error)}</p>` : "";
  return `<!doctype html><html lang="${esc(o.locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(o.title)}</title></head><body>${note}<h1>${esc(o.title)}</h1></body></html>`;
}

export { TemplateError };
