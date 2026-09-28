/**
 * Admin SPA — shared state and API helpers.
 *
 * Leaf module: it imports nothing from the rest of the app, so every other
 * module may depend on it without creating an import cycle. Keep it that way.
 */

/** Mount point for the whole SPA. */
export const app = document.querySelector("#app");

/** All mutable UI state. Screens read it; navigation writes `page` / `editing`. */
export const state = {
  user: null,
  page: "dashboard",
  editing: null,
  type: "post",
  blocks: [],
  autosaveTimer: null,
  site: "default",
  sites: [],
  /** Locale codes this site serves, default first. Drives the editor's locale picker. */
  locales: [],
  /** The site's default locale. Falls back to `"en"` only when nothing loaded. */
  defaultLocale: "en",
  /** The open content's translation group, when the site serves >1 language. */
  translations: null,
  themeMenus: [],
  postTypes: [],
  fields: [],
  sidebarCollapsed: localStorage.getItem("cfpress.admin.sidebar") === "1",
  openGroups: new Set(JSON.parse(localStorage.getItem("cfpress.admin.groups") || "[]")),
};

export async function api(path, opts = {}) {
  const res = await fetch("/api/v1/" + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

/** Append the current site so the API scopes the request. */
export function scoped(path) {
  const sep = path.includes("?") ? "&" : "?";
  return path + sep + "site=" + encodeURIComponent(state.site);
}

/** Path for a content list, which may be a theme-declared custom post type. */
export function contentPath(type) {
  return ["posts", "pages"].includes(type) ? type : "content/" + type;
}

/** Look up a post type's human labels. */
export function postTypeInfo(type) {
  if (type === "posts") return { singular: "Post", plural: "Posts" };
  if (type === "pages") return { singular: "Page", plural: "Pages" };
  const pt = state.postTypes.find((p) => p.name === type);
  const singular = String(pt?.singular_label || pt?.label || type);
  const plural = String(pt?.plural_label || pt?.label || type);
  return { singular, plural };
}

/** Load the site list and the active theme's declared menus + CPTs + fields. */
export async function loadContext() {
  try { state.sites = (await api("sites")).items ?? []; } catch { state.sites = [{ id: "default", name: "Default Site" }]; }
  if (!state.sites.some((s) => s.id === state.site)) state.site = state.sites[0]?.id ?? "default";
  try { state.postTypes = (await api(scoped("theme/post-types"))).items ?? []; } catch { state.postTypes = []; }
  try { state.themeMenus = (await api(scoped("theme/menus"))).items ?? []; } catch { state.themeMenus = []; }
  try { state.fields = (await api(scoped("theme/fields"))).items ?? []; } catch { state.fields = []; }
  // The languages this site serves. The editor needs them to offer a locale
  // picker and a language-version bar, and to know which locale a new piece of
  // content should start in.
  try {
    const d = await api("i18n/locales");
    const enabled = Array.isArray(d.enabled) ? d.enabled : [];
    state.locales = enabled;
    state.defaultLocale = d.default || enabled[0] || "en";
  } catch {
    state.locales = [];
    state.defaultLocale = "en";
  }
}
