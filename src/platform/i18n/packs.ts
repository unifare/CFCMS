/**
 * L2 — the UI dictionary, four layers deep (ARCHITECTURE.md §2.4).
 *
 *   ① core pack       bundled with the platform (`core-pack.ts`)
 *   ② plugin packs    declared inline in an enabled plugin's manifest
 *   ③ theme pack      `langs/{locale}.json` inside the active theme package
 *   ④ DB overrides    `i18n_overrides`, editable from the admin
 *
 * Later layers win. A missing key falls back to the key itself, never to an
 * empty string — see `translate.ts`.
 *
 * ## Why layers ② and ③ arrive through injected providers
 *
 * Reading a theme pack means knowing which theme is active, and that is
 * `extensions/` knowledge. `platform/` may not import `extensions/` (§7.3
 * rule 1), so this module declares a *provider* shape and `index.ts` — the one
 * module allowed to see every layer — injects the implementations at boot.
 *
 * The mechanism is deliberately the same one `contract/hooks.ts` uses for
 * plugin hooks: an interface in the middle, wired once, with a no-op default.
 * With no provider installed the stack is just core + overrides, which is
 * exactly "no theme or plugin is translating anything" — so call sites need no
 * null checks.
 */
import { Env } from "../../shared/types";
import { CORE_PACKS } from "./core-pack";
import { createTranslator, packForLocale, parsePack, type Pack, type Translator } from "./translate";

/** Returns the pack for `locale`, or null when this extension has none. */
export type PackProvider = (env: Env, siteId: string, locale: string) => Promise<Pack | null>;

let themeProvider: PackProvider | null = null;
let pluginProvider: PackProvider | null = null;

/**
 * Install the extension pack providers. Called once per request from
 * `index.ts`, right next to `setHostHooks`.
 */
export function setPackProviders(p: { theme?: PackProvider | null; plugin?: PackProvider | null }): void {
  if ("theme" in p) themeProvider = p.theme ?? null;
  if ("plugin" in p) pluginProvider = p.plugin ?? null;
}

/** Layer ④ — the admin's own wording, per site and locale. */
export async function dbOverridePack(env: Env, siteId: string, locale: string): Promise<Pack | null> {
  try {
    const r = await env.DB.prepare(
      "SELECT key,value FROM i18n_overrides WHERE site_id=? AND locale=?"
    )
      .bind(siteId, locale)
      .all();
    const rows = (r.results as any[]) ?? [];
    if (!rows.length) return null;
    const out: Pack = Object.create(null) as Pack;
    for (const row of rows) {
      if (typeof row?.value === "string") out[String(row.key)] = row.value;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * The ordered stack, lowest priority first. Layers that contribute nothing are
 * omitted rather than included as empty objects — an empty pack is
 * indistinguishable from a missing one at lookup time and only costs a loop.
 */
export async function loadUiPacks(env: Env, siteId: string, locale: string): Promise<Pack[]> {
  const packs: Pack[] = [];

  const core = packForLocale(CORE_PACKS, locale);
  if (core) packs.push(core);

  if (pluginProvider) {
    const p = await safeProvider(pluginProvider, env, siteId, locale);
    if (p) packs.push(p);
  }
  if (themeProvider) {
    const t = await safeProvider(themeProvider, env, siteId, locale);
    if (t) packs.push(t);
  }

  const override = await dbOverridePack(env, siteId, locale);
  if (override) packs.push(override);

  return packs;
}

/** Build the `__()` function for one request. */
export async function uiTranslator(env: Env, siteId: string, locale: string): Promise<Translator> {
  return createTranslator(await loadUiPacks(env, siteId, locale), locale);
}

/**
 * Which UI languages can actually be shown: everything a bundled pack covers,
 * plus anything the database has overrides for.
 *
 * This is deliberately **not** `site_locales`. UI language and content language
 * are independent (ARCHITECTURE.md §2.4): a Chinese site owner managing an
 * English-only site must be able to read the admin in Chinese even though
 * `zh-CN` is not a language that site serves to visitors. Constraining this
 * list to the site's content locales would make that impossible.
 */
export async function availableUiLocales(env: Env, siteId: string): Promise<string[]> {
  const out = new Set<string>(Object.keys(CORE_PACKS));
  try {
    const r = await env.DB.prepare("SELECT DISTINCT locale FROM i18n_overrides WHERE site_id=?")
      .bind(siteId)
      .all();
    for (const row of (r.results as any[]) ?? []) {
      const code = String(row?.locale ?? "");
      if (code) out.add(code);
    }
  } catch {
    /* table absent on a pre-0011 database */
  }
  return [...out].sort();
}

/**
 * Pick the UI language for a request.
 *
 * Priority: the user's own setting → their cookie → the site's default →
 * whatever the platform ships. The user's preference is honoured even when the
 * site does not serve that language, which is the whole point of the split.
 */
export async function resolveUiLocale(
  env: Env,
  siteId: string,
  opts: { userLang?: string | null; cookieLang?: string | null; defaultLocale: string }
): Promise<string> {
  const available = await availableUiLocales(env, siteId);
  const known = (code: unknown): boolean => {
    const c = String(code ?? "").trim();
    return !!c && available.includes(c);
  };
  if (known(opts.userLang)) return String(opts.userLang).trim();
  if (known(opts.cookieLang)) return String(opts.cookieLang).trim();
  if (known(opts.defaultLocale)) return opts.defaultLocale;
  // The site's default has no pack. Prefer English when it exists (the
  // platform's own authoring language), else take whatever is first.
  if (available.includes("en")) return "en";
  return available[0] ?? "en";
}

/** Re-exported so callers need only one import for the common pair. */
export { parsePack };
export type { Pack, Translator };

async function safeProvider(
  provider: PackProvider,
  env: Env,
  siteId: string,
  locale: string
): Promise<Pack | null> {
  // A provider reads from R2 and from the database. A failure there must not
  // take the admin down with it — the stack simply loses one layer.
  try {
    return await provider(env, siteId, locale);
  } catch {
    return null;
  }
}
