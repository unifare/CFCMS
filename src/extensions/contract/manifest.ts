/**
 * The vocabulary an extension declaration may use (ARCHITECTURE.md §5.3).
 *
 * Everything here answers one question: *what is a legal declaration?* The
 * allowed capability names, the allowed admin screens, the six field types a
 * generated table may use, the reserved columns, and the shape rules for the
 * identifiers that end up inside generated SQL or R2 keys.
 *
 * ## Why this is a separate file from `validation.ts`
 *
 * `validation.ts` asks "is this particular manifest acceptable?" and produces a
 * message. This file says what exists at all. Keeping them apart matters because
 * the vocabularies have **other readers**: `tests/architecture.test.mjs` reads
 * this file to check that every *shipped* theme and plugin only uses screens
 * that exist, and the admin SPA needs the same set to decide whether it has a
 * renderer. When the list lived inside the validator, the only way to check a
 * shipped manifest was to copy the list — and a copy drifts.
 *
 * So: **add a screen or a field type here, and every reader sees it at once.**
 * Nothing may re-declare these lists locally.
 */

/**
 * Columns the platform owns on every generated table.
 *
 * A theme declaring one of these would produce a `CREATE TABLE` with two
 * columns of the same name — or worse, silently shadow the platform's
 * `site_id` and break multi-site isolation for that table. There is no
 * legitimate use, so it is rejected rather than de-duplicated.
 */
export const RESERVED_COLUMNS = [
  "id", "site_id", "slug", "lang_group", "status", "created_at", "updated_at",
] as const;

/** Field types allowed on a post type's custom fields (13, incl. media/select). */
export const ALLOWED_FIELD_TYPES = [
  "text", "textarea", "number", "boolean", "select", "date", "datetime",
  "media", "media-multiple", "color", "url", "email", "richtext",
] as const;

/**
 * Field types allowed on an extension-declared table (§9 decision 2: basic
 * only).
 *
 * Deliberately much shorter than `ALLOWED_FIELD_TYPES`. Every type here must
 * have exactly one admin control (see `public/admin/js/table-form.js`), because
 * the admin form is *generated* from the declaration — a type with no control
 * would render an empty input and look like a data problem.
 */
export const ALLOWED_TABLE_FIELD_TYPES = ["text", "longtext", "number", "boolean", "date", "datetime"] as const;

/**
 * Screen types a declared admin menu may open.
 *
 * `table-list` / `table-edit` (batch 3) are the two that let a theme show a
 * generated form for its own table without shipping a line of admin code — the
 * form is built from `tables[].fields[]`. `plugin-settings` is the plugin
 * counterpart of `theme-settings`: it opens the extension's own declared
 * settings rather than the site's.
 */
export const ALLOWED_ADMIN_SCREENS = [
  "dashboard", "content-list", "content-edit", "settings", "media", "custom",
  "theme-settings", "plugin-settings", "table-list", "table-edit",
] as const;

/**
 * Screen types that read an extension-owned table, and therefore must name one.
 *
 * Kept next to the screen list rather than inside the validator so the two can
 * never drift: adding a screen here without adding it to
 * `ALLOWED_ADMIN_SCREENS` is a no-op, not a hole.
 */
export const TABLE_ADMIN_SCREENS = ["table-list", "table-edit"] as const;

/**
 * Locale codes accepted in a theme's `locales[]` and its `langs{}` keys.
 *
 * Deliberately a *shape* check (BCP-47-ish), not a membership check against
 * the `locales` table: a theme ships its language packs before it is
 * installed, and the platform's enabled-locale set is per site and may change
 * afterwards. What matters here is that the code is well-formed enough to be
 * a filename (`zh-CN.json`) and a URL segment.
 */
export const LOCALE_CODE_RE = /^[a-z]{2,3}(?:-[A-Za-z]{2,8})*$/;

/** Names that become identifiers in generated DDL or generated SQL. */
export const IDENT_RE = /^[a-z][a-z0-9_-]{0,63}$/i;
export const FIELD_KEY_RE = /^[a-z0-9_][a-z0-9_-]{0,63}$/i;

/**
 * Names a template scope variable may take.
 *
 * Used by a route's `query.as`, which is the same idea as the `as` attribute on
 * `{{@query ... as="x"}}`: it names the variable a listing lands in. Both should
 * therefore accept exactly the same spellings.
 *
 * Deliberately tighter than `IDENT_RE`. The value becomes a property a template
 * reaches through the expression parser, which tokenises identifiers as
 * `[A-Za-z_$][A-Za-z0-9_$]*`. A hyphen is a legal JS property name but is not
 * reachable from a template — `{{#each my-list}}` parses as `my` minus `list`,
 * and there is no arithmetic operator — so allowing it would create a binding
 * nobody can read, which is the failure mode this whole area keeps producing.
 */
export const SCOPE_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Table names become identifiers in generated DDL, so keep them boring. */
export const TABLE_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;

/**
 * Template names are not identifiers: WordPress-style names may be numeric
 * (`404`), nested with a slash (`parts/card`) and contain dots (`single-post.v2`).
 * Reject only the things that would let a name escape the R2 prefix.
 */
export function validTemplateName(name: unknown): boolean {
  if (typeof name !== "string" || !name || name.length > 120) return false;
  if (name.startsWith("/") || name.includes("..") || name.includes("\\") || name.includes("\0")) return false;
  return /^[a-z0-9][a-z0-9._/-]*$/i.test(name);
}

export function validExtensionName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-_]{1,63}$/.test(name);
}

export function validVersion(v: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v);
}

// ---------------------------------------------------------------------------
// Declaration model
// ---------------------------------------------------------------------------
//
// These interfaces describe what a declaration may *say*. They are the type
// half of the same vocabulary the constants above describe, and they exist so
// that platform code reading a manifest has a name for the shape instead of
// passing `any` around. The validator still takes `unknown` at the boundary —
// an installed zip is untrusted input, and a type annotation is not a check.

export interface AdminMenuDecl {
  id: string;
  label: string;
  screen: string;
  icon?: string;
  /** Screen-specific. `table-list`/`table-edit` need `table`, `custom` needs `view`. */
  args?: Record<string, unknown>;
  /** Gates the menu on a capability; an unusable menu is then impossible. */
  capability?: string;
  sortOrder?: number;
}

export interface TableFieldDecl {
  key: string;
  type: string;
  label?: string;
  required?: boolean;
}

export interface TableDecl {
  name: string;
  label?: string;
  /** Field keys that also live in `{table}_i18n` when the site is multilingual. */
  translatable?: string[];
  fields?: TableFieldDecl[];
}

export interface SettingDecl {
  key: string;
  type?: string;
  label?: string;
  options?: unknown[];
  default?: string | number | boolean | null;
}

/** What both extension kinds declare. */
export interface ExtensionManifest {
  name: string;
  title?: string;
  version: string;
  description?: string;
  permissions?: string[];
  adminMenus?: AdminMenuDecl[];
  settings?: SettingDecl[];
  /** Inline language packs: locale code → `{ "plugin.{name}.key": "text" }`. */
  langs?: Record<string, Record<string, string>>;
}

export interface ThemeManifest extends ExtensionManifest {
  templates?: string[];
  parts?: string[];
  runtime?: "declarative" | "worker";
  entry?: string;
  supports?: string[];
  postTypes?: unknown[];
  taxonomies?: unknown[];
  fields?: unknown[];
  routes?: unknown[];
  blocks?: unknown[];
  locales?: string[];
  tables?: TableDecl[];
}

export interface PluginManifest extends ExtensionManifest {
  hooks?: string[];
}

/** The normalised result of a successful validation. */
export interface ValidatedManifest {
  name: string;
  title: string;
  version: string;
  manifest: any;
}
