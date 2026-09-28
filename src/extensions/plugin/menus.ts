/**
 * Plugin-contributed admin menus (ARCHITECTURE.md §4.4).
 *
 * ## Why a plugin's menus are install-wide
 *
 * A theme is activated *per site*, so its menus are per site: two sites can run
 * two themes and show two different sidebars. A plugin has no such switch —
 * `plugin_installs.enabled` is one install-wide flag — so "which site owns this
 * plugin's menu?" has no per-site answer to mirror.
 *
 * Rather than fan out one row per site (and then need a second hook on site
 * creation, whose absence would silently leave a new site with no plugin
 * menus), plugin rows are written once against `ALL_SITES` and matched by the
 * read helpers in `platform/admin-menus.ts`. Enabling a plugin is one write,
 * disabling it is one delete, and a site created tomorrow is already correct.
 *
 * ## Where registration is triggered
 *
 * `loadEnabledPlugins()` in `runtime.ts` is the single place that already
 * answers "which plugins are enabled, and what did each declare?" — hooks and
 * menus both come from that answer, so menus are materialised there instead of
 * growing a second, separately-maintained list. The enable/disable endpoint
 * calls `resetPluginRuntime()` + `bootPluginRuntime()` and therefore converges
 * immediately; a `waitUntil` boot converges the rest.
 */
import { Env } from "../../shared/types";
import {
  registerOwnerMenus,
  clearOwnerMenus,
  listOwnerMenus,
  ALL_SITES,
  type AdminMenuRow,
} from "../../platform/admin-menus";

export interface PluginAdminMenu {
  id: string;
  label?: string;
  icon?: string;
  screen: string;
  args?: Record<string, unknown>;
  capability?: string;
}

/** Materialise a plugin's `adminMenus` into the shared registry. */
export async function registerPluginMenus(
  env: Env,
  pluginName: string,
  menus: PluginAdminMenu[] | undefined
): Promise<number> {
  const list = Array.isArray(menus) ? menus : [];
  return registerOwnerMenus(
    env,
    ALL_SITES,
    "plugin",
    pluginName,
    list
      .filter((m) => m && m.id && m.screen)
      .map((m, i) => ({
        id: m.id,
        label: m.label ?? m.id,
        icon: m.icon ?? null,
        screen: m.screen,
        args: m.args ?? {},
        capability: m.capability ?? null,
        sortOrder: i,
      }))
  );
}

/**
 * Remove exactly this plugin's menus. Other plugins' and the theme's menus are
 * untouched — that is the property the registry exists to provide.
 */
export async function clearPluginMenus(env: Env, pluginName: string): Promise<void> {
  await clearOwnerMenus(env, ALL_SITES, "plugin", pluginName);
}

export async function listPluginMenus(
  env: Env,
  siteId: string,
  pluginName: string
): Promise<AdminMenuRow[]> {
  return listOwnerMenus(env, siteId, "plugin", pluginName);
}
