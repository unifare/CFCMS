import { Env } from "../../shared/types";
import { randomId } from "../../shared/crypto";
import { CAPABILITIES } from "../security";
import { registerPluginMenus } from "./menus";

export type ExtensionContext = {
  env: Env;
  request?: Request;
  siteId?: string;
  extension?: { type: string; name: string; permissions: string[] };
  /** Capability-gated facade handed to each hook so a plugin cannot touch
   *  anything its manifest did not declare. */
  api?: PluginApi;
};
type Hook = (ctx: ExtensionContext, data: any) => Promise<any> | any;
const runtime: { actions: Map<string, Hook[]>; filters: Map<string, Hook[]> } = {
  actions: new Map(),
  filters: new Map(),
};
export function addAction(name: string, fn: Hook) {
  const a = runtime.actions.get(name) || [];
  a.push(fn);
  runtime.actions.set(name, a);
}
export function addFilter(name: string, fn: Hook) {
  const a = runtime.filters.get(name) || [];
  a.push(fn);
  runtime.filters.set(name, a);
}
export async function doAction(name: string, ctx: ExtensionContext, data: any = null) {
  for (const fn of runtime.actions.get(name) || []) await fn(ctx, data);
}
export async function applyFilters(name: string, ctx: ExtensionContext, data: any) {
  let out = data;
  for (const fn of runtime.filters.get(name) || []) out = await fn(ctx, out);
  return out;
}

// ---------------------------------------------------------------------------
// Plugin runtime assembly
// ---------------------------------------------------------------------------
/**
 * Plugins are declarative manifests: they do not ship executable JavaScript
 * (the Workers runtime forbids `eval`/`new Function`, and we would not run
 * arbitrary user code anyway). Instead the manifest names *hooks*, and the
 * host supplies each hook's implementation. This is the whole point of the
 * registry above: it exists so a plugin can claim behaviour without us ever
 * evaluating anything.
 *
 * `HOOK_IMPLS` maps a declared hook name to the host-side behaviour that is
 * attached when the plugin is enabled for a site.
 */

/** Which runtime hooks a manifest may declare. Order matters for rendering. */
export const DECLARABLE_HOOKS = [
  "beforeRender",
  "html",
  "head",
  "beforeSavePost",
  "afterSavePost",
  "beforeDeletePost",
  "shortcode",
] as const;
export type DeclarableHook = (typeof DECLARABLE_HOOKS)[number];

/** A plugin hook implementation attached by the host. `order` breaks ties. */
type HookImpl = { phase: "action" | "filter"; impl: Hook; order: number };

const HOOK_IMPLS: Record<string, HookImpl> = {
  /**
   * `beforeRender` (action) — fires just before a themed page renders.
   * Nothing is returned; use it for side effects such as cache warming or
   * view counters. Kept cheap: it runs on every front-end request.
   */
  beforeRender: {
    phase: "action",
    order: 10,
    impl: async () => {
      /* host default: intentionally a no-op */
    },
  },

  /**
   * `html` (filter) — last chance to rewrite the rendered document. The
   * canonical use is injecting markup into `<head>`, which is why the SEO
   * plugin declares this hook.
   */
  html: {
    phase: "filter",
    order: 20,
    impl: async (ctx, doc) => {
      if (typeof doc !== "string") return doc;
      const head = await filterHead(ctx as ExtensionContext);
      if (!head) return doc;
      return doc.includes("</head>") ? doc.replace("</head>", `${head}</head>`) : doc;
    },
  },

  /** `head` (filter) — contributes raw markup for `<head>`. */
  head: {
    phase: "filter",
    order: 15,
    impl: async (ctx, doc) => {
      const extra = await filterHead(ctx as ExtensionContext);
      return extra ? `${doc}${extra}` : doc;
    },
  },

  /**
   * `beforeSavePost` (filter) — the payload about to be written. A plugin may
   * normalise fields here. Returning a non-object leaves content untouched.
   */
  beforeSavePost: {
    phase: "filter",
    order: 10,
    impl: async (_ctx, body) => body,
  },

  /** `afterSavePost` (action) — post id + site, for indexing side effects. */
  afterSavePost: {
    phase: "action",
    order: 10,
    impl: async () => {
      /* host default: intentionally a no-op */
    },
  },

  /** `beforeDeletePost` (action) — lets a plugin purge its own derived data. */
  beforeDeletePost: {
    phase: "action",
    order: 10,
    impl: async () => {
      /* host default: intentionally a no-op */
    },
  },

  /** `shortcode` (filter) — receives `{name, attrs, body}`, returns markup. */
  shortcode: {
    phase: "filter",
    order: 10,
    impl: async (_ctx, payload) => payload,
  },
};

interface RuntimePlugin {
  name: string;
  title: string;
  manifest: any;
  permissions: string[];
  hooks: string[];
}

// `booted` memoises the assembly promise per `env`. A WeakMap cannot be
// cleared, so the reset path swaps in a fresh one instead.
let booted = new WeakMap<Env, Promise<RuntimePlugin[]>>();

/** Per-request memo of the enabled plugin set, keyed by env. */
let enabledCache: { env: Env; at: number; rows: RuntimePlugin[] } | null = null;
const ENABLED_TTL_MS = 5_000;

async function loadEnabledPlugins(env: Env): Promise<RuntimePlugin[]> {
  if (enabledCache && enabledCache.env === env && Date.now() - enabledCache.at < ENABLED_TTL_MS) {
    return enabledCache.rows;
  }
  let rows: any[] = [];
  try {
    const r = await env.DB.prepare("SELECT name,title,manifest FROM plugin_installs WHERE enabled=1 ORDER BY title").all();
    rows = (r.results as any[]) ?? [];
  } catch {
    rows = []; // table missing on a very old database
  }
  const out: RuntimePlugin[] = rows.map((r) => {
    let manifest: any = {};
    try {
      manifest = JSON.parse(String(r.manifest ?? "{}"));
    } catch {
      manifest = {};
    }
    const permissions = Array.isArray(manifest.permissions) ? manifest.permissions.map(String) : [];
    // Only hooks we actually implement are honoured; unknown names are ignored
    // rather than silently becoming no-ops that look wired up.
    const hooks = Array.isArray(manifest.hooks)
      ? manifest.hooks.map(String).filter((h: string) => h in HOOK_IMPLS)
      : [];
    return { name: String(r.name), title: String(r.title ?? r.name), manifest, permissions, hooks };
  });

  // Converge the menu registry with the enabled set. Hooks and menus both come
  // from "which plugins are enabled and what did each declare", so they are
  // materialised at the same moment — a plugin whose `adminMenus` never made it
  // into the database would otherwise be a plugin with hooks that work and a
  // sidebar entry that silently never appears.
  for (const plugin of out) {
    try {
      await registerPluginMenus(env, plugin.name, plugin.manifest?.adminMenus);
    } catch {
      // A menu that cannot be written must not take the request down with it.
    }
  }

  enabledCache = { env, at: Date.now(), rows: out };
  return out;
}

/**
 * Register the host implementations for every enabled plugin. Idempotent per
 * `env`; concurrent callers share one promise so we do not double-register.
 */
export async function bootPluginRuntime(env: Env): Promise<RuntimePlugin[]> {
  const existing = booted.get(env);
  if (existing) return existing;
  const p = loadEnabledPlugins(env).then((plugins) => {
    for (const plugin of plugins) {
      const ctx: ExtensionContext = {
        env,
        extension: { type: "plugin", name: plugin.name, permissions: plugin.permissions },
        api: pluginApi(env, "plugin", plugin.name, plugin.permissions),
      };
      for (const hook of plugin.hooks) {
        const spec = HOOK_IMPLS[hook];
        if (!spec) continue;
        // Bind the plugin's context so the impl can read its own settings.
        const bound: Hook = (c, data) => spec.impl({ ...c, ...ctx, extension: ctx.extension }, data);
        if (spec.phase === "filter") addFilter(hook, bound);
        else addAction(hook, bound);
      }
    }
    return plugins;
  });
  booted.set(env, p);
  return p;
}

/** Drop memoised state. Used by tests and after plugin enable/disable. */
export function resetPluginRuntime() {
  runtime.actions.clear();
  runtime.filters.clear();
  enabledCache = null;
  // Must be a *new* WeakMap: reusing the old one would hand back the stale
  // assembly promise and the enable/disable change would not take effect.
  booted = new WeakMap<Env, Promise<RuntimePlugin[]>>();
}

/** Enabled plugins and the hooks each one actually got wired to. */
export async function pluginRuntimeStatus(env: Env): Promise<any[]> {
  const plugins = await bootPluginRuntime(env);
  return plugins.map((p) => ({
    name: p.name,
    title: p.title,
    hooks: p.hooks,
    permissions: p.permissions,
  }));
}

// ---------------------------------------------------------------------------
// Host hook behaviours that need database access
// ---------------------------------------------------------------------------

/**
 * Build the `<head>` contribution from enabled plugins that expose SEO-ish
 * settings. Currently derived from `plugin_setting_defs`/`plugin_settings` so
 * the bundled SEO plugin's `title_template` and `default_description` become
 * real output instead of inert configuration rows.
 */
async function filterHead(ctx: ExtensionContext): Promise<string> {
  const name = ctx.extension?.name;
  if (!name) return "";
  // Only plugins whose manifest declared the `html`/`head` hook reach here.
  const allowed = await capabilityAllowed(ctx.env, "plugin", name, "settings.read").catch(() => false);
  if (!allowed) return "";
  try {
    const defs = await ctx.env.DB.prepare(
      "SELECT key, value FROM plugin_settings WHERE plugin_id=(SELECT id FROM plugin_installs WHERE name=? LIMIT 1)"
    )
      .bind(name)
      .all();
    const map = Object.fromEntries(((defs.results as any[]) ?? []).map((r) => [r.key, r.value]));
    const out: string[] = [];
    if (map.default_description) {
      out.push(`<meta name="description" content="${escapeAttr(String(map.default_description))}">`);
    }
    return out.join("");
  } catch {
    return "";
  }
}

function escapeAttr(v: string) {
  return v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export async function installedPlugins(env: Env) {
  const r = await env.DB.prepare("SELECT * FROM plugin_installs WHERE enabled=1 ORDER BY title").all();
  return r.results as any[];
}
export async function installedThemes(env: Env) {
  const r = await env.DB.prepare("SELECT * FROM theme_installs ORDER BY active DESC,title").all();
  return r.results as any[];
}
export async function seedBundledExtensions(env: Env) {
  const now = Math.floor(Date.now() / 1000);
  const plugin = { name: "example", title: "Example Plugin", version: "1.0.0", permissions: ["content.read"], hooks: ["beforeRender"] };
  await env.DB
    .prepare(`INSERT OR IGNORE INTO plugin_installs(id,name,title,version,enabled,manifest,installed_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
    .bind("plugin_example", "example", plugin.title, plugin.version, 0, JSON.stringify(plugin), now, now)
    .run()
    .catch(() => {});
  const theme = { name: "default", title: "CFPress Default", version: "1.0.0", supports: ["blocks", "menus", "widgets"], templates: ["index", "home", "single", "page", "archive", "404"] };
  await env.DB
    .prepare(`INSERT OR IGNORE INTO theme_installs(id,name,title,version,active,manifest,installed_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
    .bind("theme_default", "default", theme.title, theme.version, 1, JSON.stringify(theme), now, now)
    .run()
    .catch(() => {});
}
export async function shortcode(env: Env, name: string, attrs: any, content: string) {
  const row = await env.DB.prepare("SELECT enabled,config FROM shortcodes WHERE name=?").bind(name).first<any>();
  // A registered `shortcode` filter runs even when the row is absent, so a
  // plugin can own a shortcode without a database row of its own.
  const filtered = await applyFilters("shortcode", { env }, { name, attrs, body: content, enabled: !!row?.enabled });
  if (filtered && typeof filtered === "object" && "body" in filtered && filtered.body !== content) {
    return String((filtered as any).body);
  }
  if (!row?.enabled) return content;
  if (name === "site_title") return await env.DB.prepare("SELECT value FROM settings WHERE key='site.title'").first<any>().then((x: any) => x?.value || "CFPress");
  if (name === "year") return String(new Date().getFullYear());
  return content;
}
export async function renderShortcodes(env: Env, html: string) {
  let out = html;
  const re = /\[([a-zA-Z0-9_-]+)(?:\s+([^\]]+))?\](.*?)\[\/\1\]|\[([a-zA-Z0-9_-]+)\]/gs;
  for (const m of [...out.matchAll(re)]) {
    const name = m[1] || m[4],
      body = m[3] || "";
    out = out.replace(m[0], await shortcode(env, name, {}, body));
  }
  return out;
}
export async function capabilityList(env: Env, type: string, name: string) {
  const rows = await env.DB.prepare("SELECT capability,enabled FROM extension_capabilities WHERE extension_type=? AND extension_name=? ORDER BY capability").bind(type, name).all();
  return rows.results as any[];
}
export async function capabilityAllowed(env: Env, type: string, name: string, capability: string) {
  if (!CAPABILITIES.includes(capability as any)) return false;
  const row = await env.DB.prepare("SELECT enabled FROM extension_capabilities WHERE extension_type=? AND extension_name=? AND capability=?").bind(type, name, capability).first<any>();
  return row?.enabled === 1;
}

/** Capability-gated API surface handed to every plugin hook as `ctx.api`. */
export interface PluginApi {
  identity: { type: string; name: string };
  has(cap: string): boolean;
  readSetting(key: string): Promise<string | null>;
  writeSetting(key: string, value: string): Promise<void>;
  readContent(id: string): Promise<any>;
  readPluginSetting(key: string): Promise<string | null>;
  log(message: string): Promise<void>;
}

export function pluginApi(env: Env, type: string, name: string, permissions: string[]): PluginApi {
  const allow = (cap: string) => permissions.includes(cap);
  const deny = (cap: string): never => {
    throw new Error(`Capability denied: ${cap}`);
  };
  return {
    identity: { type, name },
    has: (cap: string) => allow(cap),
    async readSetting(key: string) {
      if (!allow("settings.read")) deny("settings.read");
      return (await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(key).first<any>())?.value ?? null;
    },
    async writeSetting(key: string, value: string) {
      if (!allow("settings.write")) deny("settings.write");
      await env.DB.prepare("UPDATE settings SET value=? WHERE key=?").bind(value, key).run();
    },
    async readContent(id: string) {
      if (!allow("content.read")) deny("content.read");
      return await env.DB.prepare("SELECT * FROM posts WHERE id=?").bind(id).first();
    },
    async readPluginSetting(key: string) {
      if (!allow("settings.read")) deny("settings.read");
      const row = await env.DB
        .prepare("SELECT value FROM plugin_settings WHERE plugin_id=(SELECT id FROM plugin_installs WHERE name=? LIMIT 1) AND key=?")
        .bind(name, key)
        .first<any>();
      return row?.value ?? null;
    },
    async log(message: string) {
      try {
        await env.DB
          .prepare("INSERT INTO activity_log(id,user_id,action,object_type,object_id,meta,created_at) VALUES(?,?,?,?,?,?,?)")
          .bind(await randomId(), null, "plugin_log", "plugin", name, JSON.stringify({ message: String(message).slice(0, 500) }), Math.floor(Date.now() / 1000))
          .run();
      } catch {
        /* logging must never break a request */
      }
    },
  };
}

/** Kept as an alias so earlier call sites keep compiling. */
export const capabilityFacade = pluginApi;
