/**
 * Admin SPA — navigation model, sidebar and header.
 *
 * Pure markup builders: they read `state` and return HTML strings. The render
 * loop that mounts them lives in `shell.js`, so nothing here calls `render()`
 * and the dependency graph stays one-directional (shell → nav → state).
 */
import { state } from "./state.js";
import { icon } from "../icons.js";
import { attr, esc, themePref } from "../ui.js";

/**
 * A theme may declare both a custom post type (`theme/post-types`) and an admin
 * menu pointing at that same type's list screen (`theme/menus`), e.g. the
 * `storefront` theme ships `product` + `{ screen: "content-list",
 * args: { type: "product" } }`. The CPT already occupies a Content slot and
 * opens the very same screen, so rendering the menu too would show "Products"
 * twice. Drop any content-list menu that a CPT entry already covers; keep every
 * other theme menu (custom panels, settings screens, …).
 */
function isRedundantThemeMenu(menu, postTypes) {
  if (menu.screen !== "content-list") return false;
  const type = menu.args?.type;
  if (!type) return false;
  if (type === "posts" || type === "pages") return true; // core screens
  return postTypes.some((pt) => pt.name === type);
}

export function navGroups() {
  const core = (name) => state.page === name;
  const cptItems = state.postTypes.map((pt) => ({
    key: `cpt:${pt.name}`,
    title: String(pt.plural_label || pt.label || pt.name),
    icon: "layers",
    active: state.page === `cpt:${pt.name}`,
  }));
  const themeItems = state.themeMenus
    .filter((m) => !isRedundantThemeMenu(m, state.postTypes))
    .map((m) => ({
      key: `menu:${m.menu_id}`,
      title: String(m.label || m.menu_id),
      icon: "sparkles",
      active: state.page === `menu:${m.menu_id}`,
    }));

  return [
    {
      label: "General",
      items: [
        { key: "dashboard", title: "Dashboard", icon: "layout-dashboard", active: core("dashboard") },
        { key: "search", title: "Search", icon: "search", active: core("search") },
        { key: "activity", title: "Activity", icon: "activity", active: core("activity") },
      ],
    },
    {
      label: "Content",
      items: [
        { key: "posts", title: "Posts", icon: "file-text", active: core("posts") },
        { key: "pages", title: "Pages", icon: "files", active: core("pages") },
        { key: "media", title: "Media", icon: "image", active: core("media") },
        ...cptItems,
      ],
    },
    ...(themeItems.length
      ? [{ label: "From theme", items: themeItems }]
      : []),
    {
      label: "Appearance",
      items: [
        { key: "appearance", title: "Themes", icon: "palette", active: core("appearance") },
        { key: "menus", title: "Menus", icon: "menu", active: core("menus") },
        { key: "widgets", title: "Widgets", icon: "package", active: core("widgets") },
      ],
    },
    {
      label: "System",
      items: [
        { key: "plugins", title: "Plugins", icon: "puzzle", active: core("plugins") },
        { key: "languages", title: "Languages", icon: "languages", active: core("languages") },
        { key: "sites", title: "Sites", icon: "landmark", active: core("sites") },
        { key: "users", title: "Users", icon: "users", active: core("users") },
      ],
    },
    {
      label: "Tools",
      items: [
        { key: "seo", title: "SEO", icon: "chart", active: core("seo") },
        { key: "urls", title: "URL Manager", icon: "route", active: core("urls") },
        { key: "settings", title: "Settings", icon: "settings", active: core("settings") },
      ],
    },
  ];
}

/** Persist which collapsible groups are expanded. */
export function rememberGroups() {
  localStorage.setItem("cfpress.admin.groups", JSON.stringify([...state.openGroups]));
}

function navItem(item) {
  const badge = item.badge ? `<span class="nav-badge">${esc(item.badge)}</span>` : "";
  return `<button class="nav-item${item.active ? " active" : ""}" data-nav="${attr(item.key)}" title="${attr(item.title)}">
    <span class="nav-icon">${icon(item.icon)}</span>
    <span class="sidebar-text">${esc(item.title)}</span>${badge}
  </button>`;
}

export function sidebar() {
  const site = state.sites.find((s) => s.id === state.site);
  const siteOptions = state.sites
    .map((s) => `<button class="menu-item" data-switch-site="${attr(s.id)}">${icon(s.id === state.site ? "check" : "globe")}<span>${esc(s.name)}</span></button>`)
    .join("");

  const groups = navGroups().map((g) => `
    <div class="nav-group">
      <div class="nav-group-label">${esc(g.label)}</div>
      ${g.items.map(navItem).join("")}
    </div>`).join("");

  return `<aside class="sidebar">
    <div class="sidebar-header">
      <button class="team-switcher" onclick="toggleMenu('site-menu')">
        <span class="team-logo">${icon("layers")}</span>
        <span class="team-meta">
          <span class="team-name">${esc(site?.name || "CFPress")}</span>
          <span class="team-plan">Cloudflare-native CMS</span>
        </span>
        <span class="nav-chevron">${icon("chevron-down")}</span>
      </button>
      <div class="dropdown">
        <div class="menu left" id="site-menu" hidden style="width:100%">
          <div class="menu-label">Switch site</div>
          ${siteOptions || `<div class="menu-label">No sites</div>`}
          <div class="menu-sep"></div>
          <button class="menu-item" data-nav="sites">${icon("landmark")}<span>Manage sites</span></button>
        </div>
      </div>
    </div>
    <div class="sidebar-content">${groups}</div>
    <div class="sidebar-footer">
      <button class="nav-item" data-nav="settings" title="Settings">
        <span class="nav-icon">${icon("settings")}</span><span class="sidebar-text">Settings</span>
      </button>
    </div>
  </aside>`;
}

const THEME_LABEL = { light: "Light", dark: "Dark", system: "System" };
const THEME_ICON = { light: "sun", dark: "moon", system: "monitor" };

export function header() {
  const current = themePref();
  const themeItems = ["light", "dark", "system"]
    .map((t) => `<button class="menu-item theme-opt${current === t ? " active" : ""}" data-theme="${t}">
        ${icon(THEME_ICON[t])}<span>${THEME_LABEL[t]}</span><span class="check">${icon("check")}</span>
      </button>`)
    .join("");

  return `<header class="header" id="app-header">
    <button class="icon-btn" onclick="toggleSidebar()" aria-label="Toggle navigation">${icon("panel-left")}</button>
    <button class="header-search" onclick="go('search')">
      ${icon("search")}<span>Search…</span><kbd>⌘K</kbd>
    </button>
    <div class="header-actions">
      <div class="dropdown">
        <button class="icon-btn" onclick="toggleMenu('theme-menu')" aria-label="Change theme">${icon(THEME_ICON[current])}</button>
        <div class="menu right" id="theme-menu" hidden>
          <div class="menu-label">Theme</div>${themeItems}
        </div>
      </div>
      <div class="dropdown">
        <button class="icon-btn has-dot" onclick="toggleMenu('notif-menu')" aria-label="Notifications">
          ${icon("bell")}<span class="notif-dot"></span>
        </button>
        <div class="menu right" id="notif-menu" hidden style="min-width:18rem">
          <div class="menu-label">Notifications</div>
          <div class="menu-sep"></div>
          <div class="menu-label" style="white-space:normal;line-height:1.5">
            Autosave is on for drafts you open in the editor. Revisions are kept per locale.
          </div>
        </div>
      </div>
      <div class="dropdown">
        <button class="icon-btn" onclick="toggleMenu('user-menu')" aria-label="Account">${icon("user")}</button>
        <div class="menu right" id="user-menu" hidden>
          <div class="menu-label">
            <div style="color:var(--foreground);font-weight:600">${esc(state.user?.username || "—")}</div>
            <div>${esc(state.user?.role || "")}</div>
          </div>
          <div class="menu-sep"></div>
          <button class="menu-item" data-nav="users">${icon("users")}<span>Manage users</span></button>
          <button class="menu-item" data-nav="settings">${icon("settings")}<span>Site settings</span></button>
          <div class="menu-sep"></div>
          <button class="menu-item danger" data-action="logout">${icon("log-out")}<span>Log out</span></button>
        </div>
      </div>
    </div>
  </header>`;
}
