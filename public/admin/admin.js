/**
 * CFPress Admin SPA.
 *
 * Layout mirrors shadcn-admin: a grouped, collapsible sidebar on the left, a
 * sticky header with search / theme switch / notifications / user menu, and a
 * scrollable content area. All state lives in `state`; every screen renders
 * into `#content`.
 *
 * Structure:
 *   1. state + API helpers
 *   2. navigation model + sidebar
 *   3. header
 *   4. shell (render)
 *   5. screens (dashboard, content, media, appearance, ...)
 *   6. auth
 */
import { icon } from "./icons.js";
import {
  applyTheme, setTheme, themePref, watchSystemTheme,
  toast, openDialog, confirmDialog, alertDialog,
  toggleMenu, closeMenus, esc, attr, fmtDate, fmtRelative,
  statusBadge, emptyRow,
} from "./ui.js";

const app = document.querySelector("#app");

// Inline `onclick=` handlers in rendered markup resolve against `window`, so the
// few functions that markup calls directly must be re-exported there.
window.toggleMenu = toggleMenu;
window.closeMenus = closeMenus;

const state = {
  user: null,
  page: "dashboard",
  editing: null,
  type: "post",
  blocks: [],
  autosaveTimer: null,
  site: "default",
  sites: [],
  themeMenus: [],
  postTypes: [],
  fields: [],
  sidebarCollapsed: localStorage.getItem("cfpress.admin.sidebar") === "1",
  openGroups: new Set(JSON.parse(localStorage.getItem("cfpress.admin.groups") || "[]")),
};

// ---------------------------------------------------------------------------
// 1. API
// ---------------------------------------------------------------------------

async function api(path, opts = {}) {
  const res = await fetch("/api/v1/" + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

/** Append the current site so the API scopes the request. */
function scoped(path) {
  const sep = path.includes("?") ? "&" : "?";
  return path + sep + "site=" + encodeURIComponent(state.site);
}

/** Path for a content list, which may be a theme-declared custom post type. */
function contentPath(type) {
  return ["posts", "pages"].includes(type) ? type : "content/" + type;
}

/** Look up a post type's human labels. */
function postTypeInfo(type) {
  if (type === "posts") return { singular: "Post", plural: "Posts" };
  if (type === "pages") return { singular: "Page", plural: "Pages" };
  const pt = state.postTypes.find((p) => p.name === type);
  const singular = String(pt?.singular_label || pt?.label || type);
  const plural = String(pt?.plural_label || pt?.label || type);
  return { singular, plural };
}

// ---------------------------------------------------------------------------
// 2. Navigation model + sidebar
// ---------------------------------------------------------------------------

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

function navGroups() {
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
function rememberGroups() {
  localStorage.setItem("cfpress.admin.groups", JSON.stringify([...state.openGroups]));
}

window.toggleGroup = (id) => {
  if (state.openGroups.has(id)) state.openGroups.delete(id);
  else state.openGroups.add(id);
  rememberGroups();
  render();
};

window.toggleSidebar = () => {
  // On mobile the collapsed rail is meaningless — toggle the drawer instead.
  if (window.matchMedia("(max-width: 1023px)").matches) {
    document.querySelector(".layout")?.classList.toggle("drawer-open");
    const scrim = document.querySelector(".scrim");
    if (scrim) scrim.hidden = !scrim.hidden;
    return;
  }
  state.sidebarCollapsed = !state.sidebarCollapsed;
  localStorage.setItem("cfpress.admin.sidebar", state.sidebarCollapsed ? "1" : "0");
  document.querySelector(".layout")?.classList.toggle("collapsed", state.sidebarCollapsed);
};

function closeDrawer() {
  document.querySelector(".layout")?.classList.remove("drawer-open");
  const scrim = document.querySelector(".scrim");
  if (scrim) scrim.hidden = true;
}

function navItem(item) {
  const badge = item.badge ? `<span class="nav-badge">${esc(item.badge)}</span>` : "";
  return `<button class="nav-item${item.active ? " active" : ""}" data-nav="${attr(item.key)}" title="${attr(item.title)}">
    <span class="nav-icon">${icon(item.icon)}</span>
    <span class="sidebar-text">${esc(item.title)}</span>${badge}
  </button>`;
}

function sidebar() {
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

// ---------------------------------------------------------------------------
// 3. Header
// ---------------------------------------------------------------------------

const THEME_LABEL = { light: "Light", dark: "Dark", system: "System" };
const THEME_ICON = { light: "sun", dark: "moon", system: "monitor" };

function header() {
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

// ---------------------------------------------------------------------------
// 4. Shell
// ---------------------------------------------------------------------------

window.go = async (p) => {
  state.page = p;
  state.editing = null;
  closeDrawer();
  closeMenus();
  await render();
};

window.switchSite = async (id) => {
  state.site = id;
  state.editing = null;
  closeMenus();
  await loadContext();
  await render();
  toast(`Switched to ${state.sites.find((s) => s.id === id)?.name || id}`);
};

/** Global click delegation for nav / theme / actions rendered as data attrs. */
document.addEventListener("click", (e) => {
  const themeBtn = e.target.closest("[data-theme]");
  if (themeBtn) {
    setTheme(themeBtn.dataset.theme);
    closeMenus();
    render();
    return;
  }
  const siteBtn = e.target.closest("[data-switch-site]");
  if (siteBtn) { window.switchSite(siteBtn.dataset.switchSite); return; }
  const nav = e.target.closest("[data-nav]");
  if (nav) { window.go(nav.dataset.nav); return; }
  const action = e.target.closest("[data-action]");
  if (action && action.dataset.action === "logout") { window.logout(); return; }
});

/** Cmd/Ctrl+K focuses search. */
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    window.go("search");
  }
});

/** Add a shadow to the sticky header once the page scrolls. */
function wireHeaderShadow() {
  const h = document.querySelector("#app-header");
  if (!h) return;
  const onScroll = () => h.classList.toggle("scrolled", window.scrollY > 10);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
}

function breadcrumb(parts) {
  return `<nav class="breadcrumb">${parts
    .map((p, i) => {
      const isLast = i === parts.length - 1;
      const crumb = isLast ? `<span class="cur">${esc(p.label)}</span>` : `<span>${esc(p.label)}</span>`;
      return (i ? `<span class="sep">/</span>` : "") + crumb;
    })
    .join("")}</nav>`;
}

/** Page header: optional breadcrumb + title + subtitle + actions. */
function pageHead({ title, sub = "", actions = "", crumbs = null }) {
  return `${crumbs ? breadcrumb(crumbs) : ""}
  <div class="top">
    <div><h1>${esc(title)}</h1>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>
    ${actions ? `<div class="actions">${actions}</div>` : ""}
  </div>`;
}

async function render() {
  if (!state.user) return renderLogin();

  app.innerHTML = `<div class="layout${state.sidebarCollapsed ? " collapsed" : ""}">
    ${sidebar()}
    <div class="main">
      ${header()}
      <div class="page" id="content"></div>
    </div>
    <div class="scrim" hidden onclick="toggleSidebar()"></div>
  </div>`;
  wireHeaderShadow();

  const c = document.querySelector("#content");
  try {
    const p = state.page;
    if (p === "dashboard") await dashboard(c);
    else if (p.startsWith("cpt:")) await contentList(c, p.slice(4));
    else if (p.startsWith("menu:")) await themeMenuScreen(c, p.slice(5));
    else if (["posts", "pages"].includes(p)) await contentList(c, p);
    else if (p === "media") await media(c);
    else if (p === "appearance") await themes(c);
    else if (p === "plugins") await plugins(c);
    else if (p === "languages") await resources(c, "locales", "Languages");
    else if (p === "menus") await menus(c);
    else if (p === "seo") await seo(c);
    else if (p === "widgets") await widgets(c);
    else if (p === "urls") await urls(c);
    else if (p === "settings") await settings(c);
    else if (p === "sites") await sites(c);
    else if (p === "users") await users(c);
    else if (p === "search") await search(c);
    else if (p === "activity") await resources(c, "activity", "Activity");
    else c.innerHTML = `<div class="panel">${esc(p)} is not a screen.</div>`;
  } catch (e) {
    c.innerHTML = `<div class="panel"><div class="top" style="margin-bottom:.5rem"><h1 style="font-size:1.125rem">Something went wrong</h1></div><p class="muted">${esc(e.message)}</p></div>`;
  }
}

// ---------------------------------------------------------------------------
// 5. Screens
// ---------------------------------------------------------------------------

async function dashboard(c) {
  const d = await api(scoped("dashboard"));
  const site = state.sites.find((s) => s.id === state.site);

  const stat = (label, value, note) => `<div class="card">
    <div class="card-head"><span class="card-title">${esc(label)}</span>${icon("chart", 'class="nav-icon" style="width:1rem;height:1rem;color:var(--muted-foreground)"')}</div>
    <div class="metric">${esc(value ?? 0)}</div>
    ${note ? `<div class="metric-note">${note}</div>` : ""}
  </div>`;

  const cptCards = state.postTypes
    .map((pt) => `<div class="card">
      <div class="card-head"><span class="card-title">${esc(pt.plural_label || pt.label || pt.name)}</span><span class="badge secondary">CPT</span></div>
      <div class="metric-note" style="margin-top:.75rem">Theme-declared content type</div>
      <button class="btn outline sm" style="margin-top:.75rem" data-nav="cpt:${attr(pt.name)}">Open</button>
    </div>`)
    .join("");

  const recent = (d.recent || []).slice(0, 5).map((r) => `<div class="list-row">
      <div><div class="title">${esc(r.title || "(untitled)")}</div><div class="meta">${esc(r.type)} · ${esc(r.locale || "—")}</div></div>
      <span class="badge secondary">${esc(r.status)}</span>
    </div>`).join("");

  c.innerHTML = `${pageHead({
    title: "Dashboard",
    sub: `${site?.name || state.site} · Cloudflare-native CMS`,
    actions: `<button class="btn outline" data-nav="search">${icon("search")}Search</button>
              <button class="btn primary" data-nav="posts">${icon("plus")}New post</button>`,
    crumbs: [{ label: "Home" }, { label: "Dashboard" }],
  })}
  <div class="cards cols-4">
    ${stat("Posts", d.posts, `<span class="up">${esc(d.published ?? 0)}</span> published`)}
    ${stat("Pages", d.pages)}
    ${stat("Media", d.media)}
    ${stat("Drafts", d.drafts, "awaiting review")}
  </div>
  <div class="grid2" style="margin-top:1.25rem;grid-template-columns:minmax(0,1fr) 22rem">
    <div class="panel">
      <div class="card-head" style="margin-bottom:1rem">
        <div><div class="card-title">Recent content</div><div class="card-desc">Latest updates across this site</div></div>
        <button class="btn outline sm" data-nav="posts">View all</button>
      </div>
      ${recent || `<div class="empty">No content yet.</div>`}
    </div>
    <div class="panel">
      <div class="card-title">CFPress 0.8.0</div>
      <p class="muted text-sm" style="margin:.5rem 0 0">
        Multi-site, theme business packages (custom post types, fields, routes, admin menus),
        declarative template engine, revisions, autosave, multilingual content, R2 media and block editor.
      </p>
      <div class="menu-sep" style="margin:1rem -1.25rem"></div>
      <div class="card-title">Active theme</div>
      <div id="dash-theme" class="muted text-sm" style="margin-top:.5rem">Loading…</div>
    </div>
  </div>
  ${cptCards ? `<div class="panel" style="margin-top:1.25rem">
    <div class="card-title" style="margin-bottom:1rem">Content types from the active theme</div>
    <div class="cards">${cptCards}</div>
  </div>` : ""}`;

  // Theme name loads independently so a failure never blanks the dashboard.
  api(scoped("extensions/themes"))
    .then((t) => {
      const active = (t.items || []).find((x) => x.active);
      const el = document.querySelector("#dash-theme");
      if (el) el.textContent = active ? `${active.title} v${active.version}` : "No theme active";
    })
    .catch(() => {
      const el = document.querySelector("#dash-theme");
      if (el) el.textContent = "—";
    });
}

async function contentList(c, type) {
  const pt = postTypeInfo(type);
  if (state.editing) return editor(c, type);

  const d = await api(scoped(contentPath(type)));
  const rows = (d.items || []).map((x) => `<tr>
      <td><div style="font-weight:500">${esc(x.title || "(untitled)")}</div><div class="muted text-sm">/${esc(x.slug || "")}</div></td>
      <td><span class="badge outline">${esc(x.locale || "—")}</span></td>
      <td>${statusBadge(x.status)}</td>
      <td class="muted text-sm">${esc(fmtDate(x.updated_at))}</td>
      <td class="actions"><button class="btn outline sm" data-edit="${attr(type)}|${attr(x.id)}">${icon("pencil")}Edit</button></td>
    </tr>`).join("");

  c.innerHTML = `${pageHead({
    title: pt.plural,
    sub: `${(d.items || []).length} item${(d.items || []).length === 1 ? "" : "s"} on ${state.sites.find((s) => s.id === state.site)?.name || state.site}`,
    actions: `<button class="btn primary" data-new="${attr(type)}">${icon("plus")}Add ${esc(pt.singular)}</button>`,
    crumbs: [{ label: "Content" }, { label: pt.plural }],
  })}
  <div class="table-wrap"><table class="table">
    <thead><tr><th>Title</th><th>Locale</th><th>Status</th><th>Updated</th><th></th></tr></thead>
    <tbody>${rows || emptyRow(5, `No ${pt.plural.toLowerCase()} yet.`)}</tbody>
  </table></div>`;
}

window.newContent = (type) => {
  state.editing = { id: null, slug: "", title: "", excerpt: "", locale: "en", status: "draft", content: "[]", meta: {} };
  state.type = type;
  render();
};

window.editContent = async (type, id) => {
  const d = await api(scoped(contentPath(type) + "/" + id));
  const x = d.items?.[0] || {};
  state.editing = {
    id, slug: x.slug || "", title: x.title || "", excerpt: x.excerpt || "",
    locale: x.locale || "en", status: x.status || "draft", content: x.content || "[]", meta: x.meta || {},
  };
  state.type = type;
  render();
};

document.addEventListener("click", (e) => {
  const n = e.target.closest("[data-new]");
  if (n) { window.newContent(n.dataset.new); return; }
  const ed = e.target.closest("[data-edit]");
  if (ed) {
    const [t, id] = ed.dataset.edit.split("|");
    window.editContent(t, id);
  }
});

/** Custom-field inputs declared by the active theme for this content type. */
function fieldInputs(type) {
  const fields = state.fields.filter((f) => !f.post_types?.length || f.post_types.includes(type));
  if (!fields.length) return "";
  const x = state.editing.meta || {};
  const inputs = fields.map((f) => {
    const val = esc(x[f.meta_key] ?? "");
    const label = esc(f.label || f.meta_key);
    const key = attr(f.meta_key);
    if (f.field_type === "number") return `<div class="field"><label>${label}</label><input data-meta="${key}" type="number" value="${val}"></div>`;
    if (f.field_type === "boolean") return `<div class="field"><label>${label}</label><select data-meta="${key}"><option value="">—</option><option value="1"${x[f.meta_key] === "1" ? " selected" : ""}>Yes</option><option value="0"${x[f.meta_key] === "0" ? " selected" : ""}>No</option></select></div>`;
    if (["textarea", "html", "richtext"].includes(f.field_type)) return `<div class="field"><label>${label}</label><textarea data-meta="${key}">${val}</textarea></div>`;
    if (f.field_type === "date") return `<div class="field"><label>${label}</label><input data-meta="${key}" type="date" value="${val}"></div>`;
    return `<div class="field"><label>${label}</label><input data-meta="${key}" value="${val}"></div>`;
  }).join("");
  return `<div class="panel" style="margin-top:1rem">
    <div class="card-title">Custom fields</div>
    <div class="card-desc" style="margin-bottom:1rem">Declared by the active theme for this content type</div>
    ${inputs}</div>`;
}

async function editor(c, type) {
  const x = state.editing;
  let blocks = [];
  try { blocks = JSON.parse(x.content || "[]"); } catch { /* keep empty */ }
  state.blocks = Array.isArray(blocks) ? blocks : [];
  const pt = postTypeInfo(type);

  const blockButtons = [
    ["core/paragraph", "Paragraph"], ["core/heading", "Heading"], ["core/list", "List"],
    ["core/image", "Image"], ["core/quote", "Quote"], ["core/code", "Code"],
    ["core/separator", "Separator"], ["core/html", "HTML"], ["core/group", "Group"],
  ].map(([t, label]) => `<button class="btn outline sm" data-block="${attr(t)}">${icon("plus")}${esc(label)}</button>`).join("");

  c.innerHTML = `${pageHead({
    title: `${x.id ? "Edit" : "Add"} ${pt.singular}`,
    sub: x.id ? `Last saved content for ${state.site}` : "New content, saved as draft",
    actions: `<span class="badge secondary" id="saveState">Ready</span>
              <button class="btn outline" data-back="1">${icon("chevron-left")}Back</button>`,
    crumbs: [{ label: "Content" }, { label: pt.plural }, { label: x.id ? "Edit" : "Add" }],
  })}
  <div class="grid2">
    <div>
      <div class="panel">
        <div class="field"><label class="req" for="title">Title</label><input id="title" value="${attr(x.title)}" placeholder="Post title"></div>
        <div class="field">
          <label>Content</label>
          <div id="blocks" class="blocks"></div>
          <div class="toolbar" style="margin-top:.75rem">${blockButtons}</div>
        </div>
        <div class="field" style="margin-bottom:0"><label for="excerpt">Excerpt</label><textarea id="excerpt" placeholder="Short summary shown in listings">${esc(x.excerpt)}</textarea></div>
      </div>
      ${fieldInputs(type)}
    </div>
    <div>
      <div class="panel">
        <div class="field"><label for="locale">Locale</label><input id="locale" value="${attr(x.locale)}"></div>
        <div class="field"><label for="slug">Slug</label><input id="slug" value="${attr(x.slug)}" placeholder="auto from title"></div>
        <div class="field"><label for="status">Status</label><select id="status">
          ${["draft", "published", "private", "scheduled"].map((s) => `<option${x.status === s ? " selected" : ""}>${s}</option>`).join("")}
        </select></div>
        <div class="field"><label for="publishAt">Publish at</label><input id="publishAt" type="datetime-local"><span class="hint">Used when status is scheduled</span></div>
        <button class="btn primary" style="width:100%" data-action="save-content">${icon("save")}Save</button>
        ${x.id ? `<div class="toolbar" style="margin-top:.5rem">
          <button class="btn outline sm" data-action="revisions">${icon("history")}Revisions</button>
          <button class="btn outline danger sm" data-action="delete-content">${icon("trash")}Delete</button>
        </div>` : ""}
      </div>
      ${x.id ? `<div class="panel" id="revisions" style="margin-top:1rem;display:none"></div>` : ""}
    </div>
  </div>`;

  drawBlocks();
  if (x.id) {
    clearInterval(state.autosaveTimer);
    state.autosaveTimer = setInterval(doAutosave, 10000);
  }
}

function blockText(b) { return b.attrs?.text || b.attrs?.html || b.attrs?.url || ""; }

function drawBlocks() {
  const el = document.querySelector("#blocks");
  if (!el) return;
  el.innerHTML = state.blocks.map((b, i) => `<div class="block">
      <div class="blockhead">
        <b>${esc(b.type)}</b>
        <span class="block-tools">
          <button class="btn ghost sm" data-block-move="${i}|-1" title="Move up">${icon("arrow-up")}</button>
          <button class="btn ghost sm" data-block-move="${i}|1" title="Move down">${icon("arrow-down")}</button>
          <button class="btn ghost sm" data-block-dup="${i}" title="Duplicate">${icon("copy")}</button>
          <button class="btn ghost sm" data-block-del="${i}" title="Remove">${icon("trash")}</button>
        </span>
      </div>
      <textarea data-block-input="${i}" placeholder="Block content…">${esc(blockText(b))}</textarea>
    </div>`).join("") || `<div class="empty">Add a block to start writing.</div>`;
}

window.addBlock = (t) => { state.blocks.push({ type: t, attrs: { text: "" } }); drawBlocks(); markDirty(); };
function moveBlock(i, d) {
  const j = i + d;
  if (j < 0 || j >= state.blocks.length) return;
  [state.blocks[i], state.blocks[j]] = [state.blocks[j], state.blocks[i]];
  drawBlocks(); markDirty();
}
function duplicateBlock(i) { state.blocks.splice(i + 1, 0, JSON.parse(JSON.stringify(state.blocks[i]))); drawBlocks(); markDirty(); }
function removeBlock(i) { state.blocks.splice(i, 1); drawBlocks(); markDirty(); }
function updateBlock(i, v) { state.blocks[i].attrs = state.blocks[i].attrs || {}; state.blocks[i].attrs.text = v; markDirty(); }

function markDirty() {
  const e = document.querySelector("#saveState");
  if (e) { e.textContent = "Unsaved changes"; e.className = "badge warn"; }
}

/** Wire editor interactions via delegation so re-renders never lose handlers. */
document.addEventListener("click", (e) => {
  const add = e.target.closest("[data-block]");
  if (add) { window.addBlock(add.dataset.block); return; }
  const mv = e.target.closest("[data-block-move]");
  if (mv) { const [i, d] = mv.dataset.blockMove.split("|").map(Number); moveBlock(i, d); return; }
  const dup = e.target.closest("[data-block-dup]");
  if (dup) { duplicateBlock(Number(dup.dataset.blockDup)); return; }
  const del = e.target.closest("[data-block-del]");
  if (del) { removeBlock(Number(del.dataset.blockDel)); return; }
  const back = e.target.closest("[data-back]");
  if (back) { clearInterval(state.autosaveTimer); window.go(state.page); return; }
  const act = e.target.closest("[data-action]");
  if (!act) return;
  if (act.dataset.action === "save-content") window.saveContent();
  if (act.dataset.action === "revisions") window.showRevisions();
  if (act.dataset.action === "delete-content") window.deleteContent();
});

document.addEventListener("input", (e) => {
  const ta = e.target.closest("[data-block-input]");
  if (ta) { updateBlock(Number(ta.dataset.blockInput), ta.value); return; }
  if (e.target.closest("#title, #excerpt, #locale, #slug, #status")) markDirty();
});

async function doAutosave() {
  if (!state.editing?.id) return;
  const body = {
    locale: document.querySelector("#locale")?.value || "en",
    title: document.querySelector("#title")?.value || "",
    excerpt: document.querySelector("#excerpt")?.value || "",
    content: state.blocks,
  };
  try {
    await api(scoped(contentPath(state.type) + "/" + state.editing.id + "/autosave"), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const e = document.querySelector("#saveState");
    if (e) { e.textContent = "Autosaved"; e.className = "badge success"; }
  } catch { /* autosave is best-effort */ }
}

/** Collect theme-declared custom-field values from the editor. */
function collectMeta() {
  const meta = {};
  for (const el of document.querySelectorAll("[data-meta]")) meta[el.dataset.meta] = el.value;
  return meta;
}

window.saveContent = async () => {
  clearInterval(state.autosaveTimer);
  const titleEl = document.querySelector("#title");
  if (!titleEl.value.trim()) {
    await alertDialog({ title: "Title required", description: "Give this content a title before saving." });
    titleEl.focus();
    return;
  }
  const publishAt = document.querySelector("#publishAt")?.value;
  const body = {
    title: titleEl.value,
    excerpt: document.querySelector("#excerpt").value,
    locale: document.querySelector("#locale").value,
    slug: document.querySelector("#slug").value,
    status: document.querySelector("#status").value,
    publish_at: publishAt ? Math.floor(new Date(publishAt).getTime() / 1000) : null,
    content: state.blocks,
    meta: collectMeta(),
  };
  try {
    await api(scoped(contentPath(state.type) + (state.editing.id ? "/" + state.editing.id : "")), {
      method: state.editing.id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    toast("Saved");
    state.editing = null;
    setTimeout(render, 300);
  } catch (e) {
    toast(e.message, "error");
  }
};

window.showRevisions = async () => {
  const box = document.querySelector("#revisions");
  box.style.display = "block";
  box.innerHTML = `<div class="card-title">Revision history</div><div class="muted text-sm">Loading…</div>`;
  try {
    const d = await api(scoped(`${state.type}/${state.editing.id}/revisions`));
    const items = d.items || [];
    box.innerHTML = `<div class="card-title" style="margin-bottom:.75rem">Revision history</div>
      ${items.map((r) => `<div class="list-row">
        <div><div class="title">v${esc(r.version)}</div><div class="meta">${esc(r.locale)} · ${esc(fmtDate(r.created_at))}</div></div>
        <button class="btn outline sm" data-restore="${attr(r.id)}">Restore</button>
      </div>`).join("") || `<div class="empty">No revisions yet.</div>`}`;
  } catch (e) {
    box.innerHTML = `<div class="muted text-sm">${esc(e.message)}</div>`;
  }
};

document.addEventListener("click", async (e) => {
  const r = e.target.closest("[data-restore]");
  if (!r) return;
  const ok = await confirmDialog({
    title: "Restore this revision?",
    description: "The current content will be replaced by the selected revision.",
    confirmLabel: "Restore", danger: false,
  });
  if (!ok) return;
  await api(scoped(`${state.type}/${state.editing.id}/revisions/${r.dataset.restore}/restore`), { method: "POST" });
  toast("Revision restored");
  window.editContent(state.type, state.editing.id);
});

window.deleteContent = async () => {
  const ok = await confirmDialog({
    title: "Delete this content?",
    description: "This permanently removes the item and its translations. Revisions go with it.",
    confirmLabel: "Delete",
  });
  if (!ok) return;
  clearInterval(state.autosaveTimer);
  await api(scoped(contentPath(state.type) + "/" + state.editing.id), { method: "DELETE" });
  toast("Deleted");
  state.editing = null;
  window.go(state.page);
};

async function media(c) {
  const d = await api(scoped("media"));
  const items = d.items || [];
  const isImg = (t) => String(t || "").startsWith("image/");
  const rows = items.map((x) => `<tr>
      <td>
        <div style="display:flex;align-items:center;gap:.75rem">
          <span class="team-logo" style="width:2.25rem;height:2.25rem;background:var(--muted);color:var(--muted-foreground)">
            ${isImg(x.mime_type)
              ? `<img src="/media/${encodeURIComponent(x.object_key)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">`
              : icon("file-text")}
          </span>
          <div><div style="font-weight:500">${esc(x.filename)}</div><div class="muted text-sm">${esc(x.mime_type)}</div></div>
        </div>
      </td>
      <td class="muted text-sm">${esc(formatBytes(x.size))}</td>
      <td class="muted text-sm">${esc(x.alt_text || "—")}</td>
      <td class="actions">
        <a class="btn outline sm" href="/media/${encodeURIComponent(x.object_key)}" target="_blank" rel="noopener">${icon("external")}Open</a>
        <button class="btn outline sm" data-copy="/media/${attr(encodeURIComponent(x.object_key))}">${icon("copy")}URL</button>
      </td>
    </tr>`).join("");

  c.innerHTML = `${pageHead({
    title: "Media",
    sub: `${items.length} file${items.length === 1 ? "" : "s"} in R2 for this site`,
    actions: `<label class="btn primary">${icon("upload")}Upload<input id="upload" type="file" hidden></label>`,
    crumbs: [{ label: "Content" }, { label: "Media" }],
  })}
  <div class="table-wrap"><table class="table">
    <thead><tr><th>File</th><th>Size</th><th>Alt text</th><th></th></tr></thead>
    <tbody>${rows || emptyRow(4, "No media uploaded yet.")}</tbody>
  </table></div>`;

  document.querySelector("#upload").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const fd = new FormData();
    fd.append("file", f);
    try {
      await api(scoped("media"), { method: "POST", body: fd });
      toast("Uploaded");
      render();
    } catch (err) { toast(err.message, "error"); }
  };
}

function formatBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

document.addEventListener("click", async (e) => {
  const cp = e.target.closest("[data-copy]");
  if (!cp) return;
  try {
    await navigator.clipboard.writeText(new URL(cp.dataset.copy, location.origin).href);
    toast("URL copied");
  } catch { toast("Could not copy", "error"); }
});

/** Generic table for tabular resources (locales, activity). */
async function resources(c, path, title) {
  const d = await api(path);
  const rows = d.items || [];
  const keys = rows[0] ? Object.keys(rows[0]).slice(0, 7) : [];
  c.innerHTML = `${pageHead({
    title,
    sub: `${rows.length} record${rows.length === 1 ? "" : "s"}`,
    crumbs: [{ label: "General" }, { label: title }],
  })}
  <div class="table-wrap"><table class="table">
    <thead><tr>${keys.map((k) => `<th>${esc(k.replace(/_/g, " "))}</th>`).join("") || "<th>Data</th>"}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${keys.map((k) => `<td>${esc(r[k] ?? "—")}</td>`).join("")}</tr>`).join("") || emptyRow(keys.length || 1, "No records.")}</tbody>
  </table></div>`;
}

async function urls(c) {
  const [r, w] = await Promise.all([api("redirects"), api("rewrites")]);
  const list = (rows, kind) => rows.map((x) => `<div class="list-row">
      <div><div class="title">${esc(x.source || x.from || "—")}</div><div class="meta">${kind}</div></div>
      <span style="display:flex;align-items:center;gap:.5rem" class="muted">${icon("arrow-right")}<code>${esc(x.target || x.to || "")}</code></span>
    </div>`).join("") || `<div class="empty">No rules.</div>`;

  c.innerHTML = `${pageHead({
    title: "URL Manager",
    sub: "Redirects and rewrites applied before theme routing",
    crumbs: [{ label: "Tools" }, { label: "URL Manager" }],
  })}
  <div class="grid2" style="grid-template-columns:1fr 1fr">
    <div class="panel"><div class="card-title" style="margin-bottom:.5rem">Redirects</div>${list(r.items || [], "redirect")}</div>
    <div class="panel"><div class="card-title" style="margin-bottom:.5rem">Rewrites</div>${list(w.items || [], "rewrite")}</div>
  </div>`;
}

async function settings(c) {
  const d = await api(scoped("settings"));
  const site = state.sites.find((s) => s.id === state.site);
  const items = d.items || [];

  // Group keys by their prefix (e.g. "seo.titleTemplate" -> "seo").
  const groups = {};
  for (const x of items) {
    const g = String(x.key).includes(".") ? String(x.key).split(".")[0] : "general";
    (groups[g] ||= []).push(x);
  }
  const sections = Object.entries(groups).map(([g, rows]) => `<div class="panel" style="margin-bottom:1rem">
      <div class="card-title" style="text-transform:capitalize">${esc(g)}</div>
      <div class="card-desc" style="margin-bottom:1rem">${rows.length} setting${rows.length === 1 ? "" : "s"}</div>
      ${rows.map((x) => `<div class="field"><label>${esc(x.key)}</label><input data-key="${attr(x.key)}" value="${attr(x.value)}"></div>`).join("")}
    </div>`).join("");

  c.innerHTML = `${pageHead({
    title: "Settings",
    sub: `Stored per site · ${site?.name || state.site}`,
    actions: `<button class="btn primary" data-action="save-settings">${icon("save")}Save all</button>`,
    crumbs: [{ label: "Tools" }, { label: "Settings" }],
  })}
  ${sections || `<div class="panel"><div class="empty">This site has no settings yet.</div></div>`}
  <p class="muted text-sm">Settings are stored per site. Switch sites from the sidebar to edit another one.</p>`;
}

async function seo(c) {
  const d = await api(scoped("settings"));
  const v = Object.fromEntries((d.items || []).map((x) => [x.key, x.value]));
  c.innerHTML = `${pageHead({
    title: "SEO",
    sub: "Titles, descriptions and crawl directives for this site",
    actions: `<button class="btn primary" data-action="save-seo">${icon("save")}Save</button>`,
    crumbs: [{ label: "Tools" }, { label: "SEO" }],
  })}
  <div class="grid2">
    <div class="panel">
      <div class="field"><label for="st">Title template</label><input id="st" value="${attr(v["seo.titleTemplate"] || "%title% | %site%")}"><span class="hint">%title% and %site% are replaced at render time</span></div>
      <div class="field"><label for="sd">Meta description</label><textarea id="sd">${esc(v["seo.description"] || "")}</textarea></div>
      <div class="field" style="margin-bottom:0"><label for="sr">Robots</label><input id="sr" value="${attr(v["seo.robots"] || "index,follow")}"><span class="hint">e.g. index,follow or noindex,nofollow</span></div>
    </div>
    <div class="panel">
      <div class="card-title">Generated endpoints</div>
      <div class="list-row"><div class="title">Sitemap</div><a class="btn outline sm" href="/sitemap.xml" target="_blank" rel="noopener">${icon("external")}/sitemap.xml</a></div>
      <div class="list-row"><div class="title">Robots</div><a class="btn outline sm" href="/robots.txt" target="_blank" rel="noopener">${icon("external")}/robots.txt</a></div>
      <div class="list-row"><div class="title">hreflang</div><span class="muted text-sm">Emitted on frontend pages</span></div>
    </div>
  </div>`;
}

document.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-action]");
  if (!a) return;
  if (a.dataset.action === "save-settings") {
    for (const el of document.querySelectorAll("[data-key]")) {
      await api(scoped("settings"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: el.dataset.key, value: el.value }) });
    }
    toast("Settings saved");
  }
  if (a.dataset.action === "save-seo") {
    for (const [key, id] of [["seo.titleTemplate", "st"], ["seo.description", "sd"], ["seo.robots", "sr"]]) {
      await api(scoped("settings"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, value: document.querySelector("#" + id).value }) });
    }
    toast("SEO saved");
  }
});

// --- Sites -----------------------------------------------------------------

async function sites(c) {
  const d = await api("sites");
  state.sites = d.items || [];
  const rows = state.sites.map((s) => `<tr>
      <td><code>${esc(s.id)}</code>${s.id === state.site ? ` <span class="badge default">current</span>` : ""}</td>
      <td style="font-weight:500">${esc(s.name)}</td>
      <td class="muted text-sm">${esc(s.host || "—")}</td>
      <td class="muted text-sm">${esc(s.path_prefix || "—")}</td>
      <td>${s.is_default ? `<span class="badge success">default</span>` : `<span class="muted">—</span>`}</td>
      <td class="actions">
        <button class="btn outline sm" data-site-edit="${attr(s.id)}">${icon("pencil")}Edit</button>
        ${s.id === state.site ? "" : `<button class="btn outline sm" data-switch-site="${attr(s.id)}">${icon("arrow-right")}Switch</button>`}
        ${s.is_default ? "" : `<button class="btn outline danger sm" data-site-del="${attr(s.id)}">${icon("trash")}Delete</button>`}
      </td>
    </tr>`).join("");

  c.innerHTML = `${pageHead({
    title: "Sites",
    sub: "Each site has its own content, settings, media and active theme",
    actions: `<button class="btn primary" data-action="new-site">${icon("plus")}Add site</button>`,
    crumbs: [{ label: "System" }, { label: "Sites" }],
  })}
  <div class="table-wrap"><table class="table">
    <thead><tr><th>ID</th><th>Name</th><th>Host</th><th>Path prefix</th><th>Default</th><th></th></tr></thead>
    <tbody>${rows || emptyRow(6, "No sites.")}</tbody>
  </table></div>
  <div class="panel" style="margin-top:1rem">
    <div class="card-title">How routing works</div>
    <p class="muted text-sm" style="margin:.5rem 0 0">
      A request is matched to a site by <b>path prefix</b> first (longest match wins), then by <b>host</b>.
      Anything unmatched falls back to the default site. Content, settings, menus, media and the active
      theme are all stored per site.
    </p>
  </div>`;
}

document.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-action]");
  if (a?.dataset.action === "new-site") {
    const v = await openDialog({
      title: "Add a site",
      description: "A site is isolated: its own content, settings and theme.",
      confirmLabel: "Create site",
      fields: [
        { name: "id", label: "Site ID", required: true, placeholder: "shop", hint: "Lowercase letters, digits, - or _" },
        { name: "name", label: "Site name", required: true, placeholder: "Shop" },
        { name: "host", label: "Host", placeholder: "shop.example.com", hint: "Optional. Matches the request host." },
        { name: "path_prefix", label: "Path prefix", placeholder: "/shop", hint: "Optional. Longest prefix wins." },
      ],
    });
    if (!v) return;
    if (!/^[a-z0-9_-]+$/.test(v.id)) { await alertDialog({ title: "Invalid site ID", description: "Use only lowercase letters, digits, - and _." }); return; }
    try {
      await api("sites", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: v.id, name: v.name, host: v.host || null, path_prefix: v.path_prefix || null }) });
      toast("Site created");
      await loadContext();
      render();
    } catch (err) { await alertDialog({ title: "Could not create site", description: err.message }); }
  }

  const ed = e.target.closest("[data-site-edit]");
  if (ed) {
    const s = state.sites.find((x) => x.id === ed.dataset.siteEdit);
    if (!s) return;
    const v = await openDialog({
      title: `Edit “${s.name}”`,
      confirmLabel: "Save changes",
      fields: [
        { name: "name", label: "Site name", value: s.name, required: true },
        { name: "host", label: "Host", value: s.host || "", placeholder: "shop.example.com" },
        { name: "path_prefix", label: "Path prefix", value: s.path_prefix || "", placeholder: "/shop" },
      ],
    });
    if (!v) return;
    try {
      await api("sites/" + s.id, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: v.name, host: v.host || null, path_prefix: v.path_prefix || null }) });
      toast("Site updated");
      await loadContext();
      render();
    } catch (err) { await alertDialog({ title: "Could not update site", description: err.message }); }
  }

  const del = e.target.closest("[data-site-del]");
  if (del) {
    const ok = await confirmDialog({
      title: `Delete site “${del.dataset.siteDel}”?`,
      description: "Its content is preserved in the database but becomes unreachable.",
      confirmLabel: "Delete site",
    });
    if (!ok) return;
    try {
      await api("sites/" + del.dataset.siteDel, { method: "DELETE" });
      toast("Site deleted");
      if (state.site === del.dataset.siteDel) state.site = "default";
      await loadContext();
      render();
    } catch (err) { await alertDialog({ title: "Could not delete site", description: err.message }); }
  }
});

// --- Users -----------------------------------------------------------------

async function users(c) {
  const d = await api("users");
  const rows = (d.items || []).map((x) => `<tr>
      <td><div style="display:flex;align-items:center;gap:.6rem">
        <span class="team-logo" style="width:2rem;height:2rem;background:var(--muted);color:var(--muted-foreground);font-weight:600">${esc(String(x.username || "?").slice(0, 2).toUpperCase())}</span>
        <div><div style="font-weight:500">${esc(x.username)}</div><div class="muted text-sm">${esc(x.email || "no email")}</div></div>
      </div></td>
      <td><span class="badge outline">${esc(x.role)}</span></td>
      <td>${x.status === "active" ? `<span class="badge success">active</span>` : `<span class="badge secondary">${esc(x.status)}</span>`}</td>
    </tr>`).join("");

  c.innerHTML = `${pageHead({
    title: "Users",
    sub: `${(d.items || []).length} account${(d.items || []).length === 1 ? "" : "s"} with admin access`,
    actions: `<button class="btn primary" data-action="new-user">${icon("plus")}Add user</button>`,
    crumbs: [{ label: "System" }, { label: "Users" }],
  })}
  <div class="table-wrap"><table class="table">
    <thead><tr><th>User</th><th>Role</th><th>Status</th></tr></thead>
    <tbody>${rows || emptyRow(3, "No users.")}</tbody>
  </table></div>`;
}

document.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-action]");
  if (a?.dataset.action !== "new-user") return;
  const v = await openDialog({
    title: "Add a user",
    confirmLabel: "Create user",
    fields: [
      { name: "username", label: "Username", required: true },
      { name: "password", label: "Password", type: "password", required: true, hint: "At least 8 characters" },
      { name: "role", label: "Role", type: "select", value: "author", options: [
        { value: "admin", label: "Admin" }, { value: "editor", label: "Editor" },
        { value: "author", label: "Author" }, { value: "viewer", label: "Viewer" },
      ] },
    ],
  });
  if (!v) return;
  if (String(v.password).length < 8) { await alertDialog({ title: "Password too short", description: "Use at least 8 characters." }); return; }
  try {
    await api("users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(v) });
    toast("User created");
    render();
  } catch (err) { await alertDialog({ title: "Could not create user", description: err.message }); }
});

// --- Search ----------------------------------------------------------------

async function search(c) {
  c.innerHTML = `${pageHead({
    title: "Search",
    sub: "Full-text search across published content on this site",
    crumbs: [{ label: "General" }, { label: "Search" }],
  })}
  <div class="panel">
    <div class="header-search" style="max-width:none;height:2.5rem;cursor:text" onclick="this.querySelector('input').focus()">
      ${icon("search")}
      <input id="sq" placeholder="Search titles, slugs and excerpts…" style="flex:1;border:0;background:transparent;min-height:0;padding:0" autofocus>
    </div>
    <div id="searchResults" style="margin-top:1rem"></div>
  </div>`;
  const input = c.querySelector("#sq");
  let t = null;
  input.addEventListener("input", () => { clearTimeout(t); t = setTimeout(runSearch, 250); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); });
}

async function runSearch() {
  const q = document.querySelector("#sq")?.value?.trim();
  const box = document.querySelector("#searchResults");
  if (!box) return;
  if (!q) { box.innerHTML = `<div class="empty">Type to search.</div>`; return; }
  box.innerHTML = `<div class="muted text-sm">Searching…</div>`;
  try {
    const d = await api(scoped("search?q=" + encodeURIComponent(q)));
    const items = d.items || [];
    box.innerHTML = items.map((x) => `<div class="list-row">
        <div>
          <div class="title">${esc(x.title || x.slug)}</div>
          <div class="meta">${esc(x.type)} · ${esc(x.locale)} · /${esc(x.locale)}/${x.type === "post" ? "blog/" : ""}${esc(x.slug)}</div>
          ${x.excerpt ? `<div class="muted text-sm" style="margin-top:.25rem">${esc(x.excerpt)}</div>` : ""}
        </div>
        <span class="badge secondary">${esc(x.type)}</span>
      </div>`).join("") || `<div class="empty">No results for “${esc(q)}”.</div>`;
  } catch (e) {
    box.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

// --- Menus -----------------------------------------------------------------

async function menus(c) {
  const d = await api(scoped("menus"));
  const items = d.items || [];
  const rows = items.map((m) => `<tr>
      <td><div style="font-weight:500">${esc(m.name)}</div><div class="muted text-sm" id="menu-${attr(m.id)}">Loading…</div></td>
      <td><span class="badge outline">${esc(m.location || "—")}</span></td>
      <td class="actions"><button class="btn outline sm" data-menu-items="${attr(m.id)}">${icon("arrow-right")}View items</button></td>
    </tr>`).join("");

  c.innerHTML = `${pageHead({
    title: "Menus",
    sub: `${items.length} menu${items.length === 1 ? "" : "s"} for this site`,
    actions: `<button class="btn primary" data-action="new-menu">${icon("plus")}New menu</button>`,
    crumbs: [{ label: "Appearance" }, { label: "Menus" }],
  })}
  <div class="table-wrap"><table class="table">
    <thead><tr><th>Menu</th><th>Location</th><th></th></tr></thead>
    <tbody>${rows || emptyRow(3, "No menus for this site yet.")}</tbody>
  </table></div>`;

  for (const m of items) {
    try {
      const x = await api(scoped("menus/" + m.id + "/items"));
      const el = document.querySelector(`#menu-${CSS.escape(m.id)}`);
      if (el) el.textContent = (x.items || []).map((i) => `${i.title} → ${i.url}`).join("  ·  ") || "No items";
    } catch { /* leave the placeholder */ }
  }
}

document.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-action]");
  if (a?.dataset.action === "new-menu") {
    const v = await openDialog({
      title: "New menu",
      confirmLabel: "Create menu",
      fields: [
        { name: "name", label: "Menu name", required: true, placeholder: "Primary" },
        { name: "location", label: "Location", type: "select", value: "header", options: ["header", "footer", "sidebar"] },
      ],
    });
    if (!v) return;
    await api(scoped("menus"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(v) });
    toast("Menu created");
    render();
  }
});

// --- Widgets ---------------------------------------------------------------

async function widgets(c) {
  const d = await api("widgets");
  const rows = (d.items || []).map((x) => `<tr>
      <td><span class="badge outline">${esc(x.sidebar)}</span></td>
      <td>${esc(x.widget_type)}</td>
      <td style="font-weight:500">${esc(x.title || "—")}</td>
      <td class="muted text-sm">${esc(x.sort_order)}</td>
    </tr>`).join("");

  c.innerHTML = `${pageHead({
    title: "Widgets",
    sub: "Sidebar widgets rendered by the active theme",
    actions: `<button class="btn primary" data-action="new-widget">${icon("plus")}Add widget</button>`,
    crumbs: [{ label: "Appearance" }, { label: "Widgets" }],
  })}
  <div class="table-wrap"><table class="table">
    <thead><tr><th>Sidebar</th><th>Type</th><th>Title</th><th>Order</th></tr></thead>
    <tbody>${rows || emptyRow(4, "No widgets.")}</tbody>
  </table></div>`;
}

document.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-action]");
  if (a?.dataset.action !== "new-widget") return;
  const v = await openDialog({
    title: "Add a widget",
    confirmLabel: "Add widget",
    fields: [
      { name: "title", label: "Widget title", placeholder: "About this site" },
      { name: "widget_type", label: "Type", type: "select", value: "text", options: [
        { value: "text", label: "Text" }, { value: "html", label: "HTML" },
        { value: "recent-posts", label: "Recent posts" }, { value: "menu", label: "Menu" },
      ] },
      { name: "sidebar", label: "Sidebar", type: "select", value: "sidebar", options: ["sidebar", "footer", "header"] },
    ],
  });
  if (!v) return;
  await api("widgets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(v) });
  toast("Widget added");
  render();
});

// --- Themes ----------------------------------------------------------------

function activeSitesFor(name, bySite) {
  return Object.entries(bySite || {}).filter(([, v]) => v === name).map(([k]) => k);
}

async function themes(c) {
  const d = await api(scoped("extensions/themes"));
  const site = state.sites.find((s) => s.id === state.site);
  const items = d.items || [];

  const cards = items.map((x) => {
    const others = activeSitesFor(x.name, x.active_by_site).filter((s) => s !== state.site);
    return `<div class="card">
      <div class="card-head">
        <div><div class="card-title" style="font-size:1rem">${esc(x.title)}</div><div class="card-desc">v${esc(x.version)}</div></div>
        ${x.active ? `<span class="badge success">${icon("check")}active</span>` : ""}
      </div>
      <div style="height:4.5rem;margin:.9rem 0;border:1px solid var(--border);border-radius:var(--radius-md);background:linear-gradient(135deg,var(--muted),transparent);display:grid;place-items:center;color:var(--muted-foreground)">
        ${icon("palette", 'style="width:1.5rem;height:1.5rem"')}
      </div>
      ${x.active
        ? `<div class="muted text-sm">Active on this site</div>`
        : `<div class="muted text-sm">${others.length ? `Also used by: ${esc(others.join(", "))}` : "Not in use"}</div>
           <button class="btn primary sm" style="margin-top:.75rem" data-theme-activate="${attr(x.name)}">${icon("check")}Activate here</button>`}
    </div>`;
  }).join("");

  const active = items.find((x) => x.active);
  c.innerHTML = `${pageHead({
    title: "Themes",
    sub: `Appearance for ${site?.name || state.site}`,
    actions: `<label class="btn primary">${icon("upload")}Install theme ZIP<input id="themeZip" type="file" accept=".zip" hidden></label>`,
    crumbs: [{ label: "Appearance" }, { label: "Themes" }],
  })}
  <div class="cards">${cards || `<div class="panel"><div class="empty">No themes installed.</div></div>`}</div>
  <div id="theme-capabilities">${active ? await themeCapabilitySummary(active) : ""}</div>`;

  document.querySelector("#themeZip").onchange = (e) => installExtension(e.target.files[0], "themes");
}

/** Show what the active theme brings to this site. */
async function themeCapabilitySummary(active) {
  const [pt, routes, fields, blocks] = await Promise.all([
    api(scoped("theme/post-types")).catch(() => ({ items: [] })),
    api(scoped("theme/routes")).catch(() => ({ items: [] })),
    api(scoped("theme/fields")).catch(() => ({ items: [] })),
    api(scoped("theme/blocks")).catch(() => ({ items: [] })),
  ]);
  const row = (label, items, fmt, iconName) => `<div class="list-row">
      <div style="display:flex;align-items:center;gap:.6rem">
        <span class="nav-icon" style="color:var(--muted-foreground)">${icon(iconName)}</span>
        <div><div class="title">${esc(label)}</div><div class="meta">${(items || []).length} declared</div></div>
      </div>
      <div class="muted text-sm" style="text-align:right;max-width:60%">${items.map(fmt).join(", ") || "—"}</div>
    </div>`;

  return `<div class="panel" style="margin-top:1.25rem">
    <div class="card-title">What “${esc(active.title)}” provides on this site</div>
    <div class="card-desc" style="margin-bottom:.75rem">Business capabilities the theme declared and CFPress materialised</div>
    ${row("Custom post types", pt.items, (x) => esc(x.plural_label || x.name), "layers")}
    ${row("Routes", routes.items, (x) => `<code>${esc(x.path)}</code>`, "route")}
    ${row("Custom fields", fields.items, (x) => esc(x.label || x.meta_key), "file-text")}
    ${row("Blocks", blocks.items, (x) => esc(x.title || x.name), "package")}
  </div>`;
}

document.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-theme-activate]");
  if (!a) return;
  try {
    await api(scoped("extensions/themes/" + a.dataset.themeActivate + "/activate"), { method: "POST" });
    toast("Theme activated for this site");
    await loadContext();
    render();
  } catch (err) { await alertDialog({ title: "Could not activate theme", description: err.message }); }
});

// --- Plugins ---------------------------------------------------------------

async function plugins(c) {
  const d = await api("extensions/plugins");
  const items = d.items || [];
  const rows = items.map((x) => `<tr>
      <td><div style="display:flex;align-items:center;gap:.6rem">
        <span class="team-logo" style="width:2rem;height:2rem;background:var(--muted);color:var(--muted-foreground)">${icon("puzzle")}</span>
        <div><div style="font-weight:500">${esc(x.title)}</div><div class="muted text-sm">v${esc(x.version)}${x.hooks_wired?.length ? ` · hooks: ${esc(x.hooks_wired.join(", "))}` : ""}</div></div>
      </div></td>
      <td>${x.enabled ? `<span class="badge success">enabled</span>` : `<span class="badge secondary">disabled</span>`}</td>
      <td class="actions">
        <button class="btn outline sm" data-plugin-toggle="${attr(x.name)}|${x.enabled ? 1 : 0}">${icon(x.enabled ? "x" : "check")}${x.enabled ? "Disable" : "Enable"}</button>
        <button class="btn outline sm" data-plugin-settings="${attr(x.name)}">${icon("settings")}Settings</button>
      </td>
    </tr>`).join("");

  c.innerHTML = `${pageHead({
    title: "Plugins",
    sub: `${items.length} installed · declarative hooks, no executable plugin code`,
    actions: `<label class="btn primary">${icon("upload")}Install plugin ZIP<input id="pluginZip" type="file" accept=".zip" hidden></label>`,
    crumbs: [{ label: "System" }, { label: "Plugins" }],
  })}
  <div class="table-wrap"><table class="table">
    <thead><tr><th>Plugin</th><th>Status</th><th></th></tr></thead>
    <tbody>${rows || emptyRow(3, "No plugins installed.")}</tbody>
  </table></div>`;

  document.querySelector("#pluginZip").onchange = (e) => installExtension(e.target.files[0], "plugins");
}

window.installExtension = async (file, type) => {
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);
  try {
    const d = await api(`extensions/${type}/upload`, { method: "POST", body: fd });
    toast(`Installed ${d.name} ${d.version}`);
    render();
  } catch (e) {
    await alertDialog({ title: "Install failed", description: e.message });
  }
};

document.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-plugin-toggle]");
  if (t) {
    const [name, on] = t.dataset.pluginToggle.split("|");
    try {
      await api("extensions/plugins/" + name + "/" + (on === "1" ? "disable" : "enable"), { method: "POST" });
      toast(on === "1" ? "Plugin disabled" : "Plugin enabled");
      render();
    } catch (err) { toast(err.message, "error"); }
    return;
  }
  const s = e.target.closest("[data-plugin-settings]");
  if (s) await window.pluginSettings(s.dataset.pluginSettings);
});

window.pluginSettings = async (n) => {
  let d;
  try { d = await api(`extensions/plugins/${n}/settings`); }
  catch (e) { await alertDialog({ title: "Could not load settings", description: e.message }); return; }
  if (!d.items?.length) { toast("This plugin declares no settings"); return; }

  const v = await openDialog({
    title: `${n} settings`,
    description: "Values are stored per plugin and validated against its manifest.",
    confirmLabel: "Save settings",
    fields: d.items.map((x) => ({ name: x.key, label: x.label || x.key, value: x.value || "" })),
  });
  if (!v) return;
  try {
    for (const [key, value] of Object.entries(v)) {
      await api(`extensions/plugins/${n}/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, value }) });
    }
    toast("Plugin settings saved");
  } catch (e) { await alertDialog({ title: "Could not save", description: e.message }); }
};

// --- Theme-contributed screens ---------------------------------------------

async function themeMenuScreen(c, menuId) {
  const m = state.themeMenus.find((x) => x.menu_id === menuId);
  if (!m) { c.innerHTML = `<div class="panel">Unknown screen.</div>`; return; }
  const args = m.args || {};

  if (m.screen === "content-list") {
    return contentList(c, String(args.type || menuId));
  }

  if (m.screen === "theme-settings") {
    const theme = (await api("extensions/themes")).active;
    const d = await api(`theme/${encodeURIComponent(theme)}/settings`);
    const fields = d.items || [];
    c.innerHTML = `${pageHead({
      title: m.label || "Theme Settings",
      sub: `Declared by ${theme}`,
      actions: `<button class="btn primary" data-save-theme-settings="${attr(theme)}">${icon("save")}Save</button>`,
      crumbs: [{ label: "Appearance" }, { label: m.label || "Theme Settings" }],
    })}
    <div class="panel">
      ${fields.map((x) => `<div class="field"><label>${esc(x.label || x.key)}</label><input data-ts-key="${attr(x.key)}" value="${attr(x.value ?? "")}"></div>`).join("")
        || `<div class="empty">This theme declares no settings.</div>`}
    </div>`;
    return;
  }

  // Unknown screen type: show the declaration so it is not a dead end.
  c.innerHTML = `${pageHead({
    title: m.label || menuId,
    sub: "Declared by the active theme",
    crumbs: [{ label: "From theme" }, { label: m.label || menuId }],
  })}
  <div class="panel">
    <div class="card-title">Screen declaration</div>
    <div class="card-desc" style="margin-bottom:.75rem">CFPress does not have a built-in renderer for this screen type yet.</div>
    <pre class="code">${esc(JSON.stringify({ screen: m.screen, args }, null, 2))}</pre>
  </div>`;
}

document.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-save-theme-settings]");
  if (!a) return;
  for (const el of document.querySelectorAll("[data-ts-key]")) {
    await api(`theme/${encodeURIComponent(a.dataset.saveThemeSettings)}/settings`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: el.dataset.tsKey, value: el.value }),
    });
  }
  toast("Theme settings saved");
});

// ---------------------------------------------------------------------------
// 6. Auth
// ---------------------------------------------------------------------------

function renderLogin() {
  app.innerHTML = `<div class="login"><div class="loginbox">
    <span class="brand-mark">${icon("layers")}</span>
    <h1>Sign in to CFPress</h1>
    <p class="muted">Manage content, themes and sites.</p>
    <div class="login-shell">
      <div class="field"><label for="u">Username</label><input id="u" value="admin" autocomplete="username"></div>
      <div class="field" style="margin-bottom:0"><label for="p">Password</label><input id="p" type="password" value="change-me-now" autocomplete="current-password"></div>
    </div>
    <button class="btn primary" style="width:100%" id="signin">Sign in</button>
    <p class="muted text-sm" style="margin-top:1rem">First login default: <b>admin / change-me-now</b>. Change it before production use.</p>
  </div></div>`;

  const submit = () => window.doLogin();
  app.querySelector("#signin").onclick = submit;
  app.querySelector("#p").addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
}

window.doLogin = async () => {
  const u = document.querySelector("#u").value;
  const p = document.querySelector("#p").value;
  try {
    const d = await api("auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: u, password: p }) });
    state.user = d.user;
    await loadContext();
    render();
  } catch (e) {
    await alertDialog({ title: "Sign-in failed", description: e.message });
  }
};

window.logout = async () => {
  try { await api("auth/logout", { method: "POST" }); } catch { /* ignore */ }
  state.user = null;
  renderLogin();
};

/**
 * Force a theme without touching the UI. Used by the verification harness and
 * handy when debugging contrast; not linked from the interface.
 */
window.setThemeForTest = (pref) => setTheme(pref);

/** Load the site list and the active theme's declared menus + CPTs + fields. */
async function loadContext() {
  try { state.sites = (await api("sites")).items ?? []; } catch { state.sites = [{ id: "default", name: "Default Site" }]; }
  if (!state.sites.some((s) => s.id === state.site)) state.site = state.sites[0]?.id ?? "default";
  try { state.postTypes = (await api(scoped("theme/post-types"))).items ?? []; } catch { state.postTypes = []; }
  try { state.themeMenus = (await api(scoped("theme/menus"))).items ?? []; } catch { state.themeMenus = []; }
  try { state.fields = (await api(scoped("theme/fields"))).items ?? []; } catch { state.fields = []; }
}

watchSystemTheme();
applyTheme();
(async () => {
  try {
    const d = await api("auth/me");
    state.user = d.user;
    if (!state.user) renderLogin();
    else { await loadContext(); render(); }
  } catch { renderLogin(); }
})();
