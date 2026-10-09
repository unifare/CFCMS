/**
 * Admin SPA — shell: render loop, page chrome and navigation actions.
 *
 * This module owns `render()`, and therefore the *only* thing that knows how a
 * page name maps to a screen. It deliberately does **not** import any screen:
 * screens register themselves through `setScreenTable()` (called once by the
 * entry point), which is what keeps the module graph acyclic — screens import
 * the shell, the shell imports none of them.
 *
 * The login screen is injected the same way, by `auth.js`, for the same reason.
 */
import { app, loadContext, state, stopAutosave } from "./state.js";
import { header, rememberGroups, sidebar } from "./nav.js";
import { closeMenus, esc, setTheme, toast } from "../ui.js";
import { t, setUiLocale } from "./i18n.js";

let screens = new Map();
let loginScreen = null;

/** Wire the page-name → screen table. Called once from the entry point. */
export function setScreenTable(table) {
  screens = new Map(Object.entries(table));
}

/** Inject the screen shown when there is no session. Called once by auth.js. */
export function setLoginScreen(fn) {
  loginScreen = fn;
}

export function closeDrawer() {
  document.querySelector(".layout")?.classList.remove("drawer-open");
  const scrim = document.querySelector(".scrim");
  if (scrim) scrim.hidden = true;
}

export function toggleGroup(id) {
  if (state.openGroups.has(id)) state.openGroups.delete(id);
  else state.openGroups.add(id);
  rememberGroups();
  render();
}

export function toggleSidebar() {
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
}

export async function go(p) {
  state.page = p;
  state.editing = null;
  // Leaving the editor through the sidebar is still leaving the editor. Without
  // this the autosave interval survived navigation and kept POSTing while the
  // user was on another screen.
  stopAutosave();
  closeDrawer();
  closeMenus();
  await render();
}

export async function switchSite(id) {
  state.site = id;
  state.editing = null;
  stopAutosave();
  closeMenus();
  await loadContext();
  await render();
  const name = state.sites.find((s) => s.id === id)?.name || id;
  toast(t("core.msg.switchedTo", "Switched to {name}").replace("{name}", name));
}

/** Global click delegation for nav / theme / language / actions rendered as data attrs. */
document.addEventListener("click", (e) => {
  const themeBtn = e.target.closest("[data-theme]");
  if (themeBtn) {
    setTheme(themeBtn.dataset.theme);
    closeMenus();
    render();
    return;
  }
  // Interface language. Labels are translated server-side (menu labels) and
  // client-side (everything else), so a switch must refresh BOTH the
  // dictionary and the cached menu context before re-rendering — otherwise
  // the sidebar keeps the previous language until the next full load.
  const langBtn = e.target.closest("[data-ui-locale]");
  if (langBtn) {
    closeMenus();
    awaitWrap(setUiLocale(langBtn.dataset.uiLocale).then(() => loadContext()));
    return;
  }
  const siteBtn = e.target.closest("[data-switch-site]");
  if (siteBtn) { switchSite(siteBtn.dataset.switchSite); return; }
  // Open the site's front end in a new window. The URL must respect the site's
  // path prefix (a shop mounted at /shop serves its front end at /shop/<locale>),
  // which is why it is built here rather than hardcoded to `/<locale>`.
  const view = e.target.closest("[data-view-site]");
  if (view) {
    const prefix = String(view.dataset.viewSitePrefix || "");
    window.open(`${prefix}/${state.defaultLocale}`, "_blank", "noopener");
    return;
  }
  const nav = e.target.closest("[data-nav]");
  if (nav) { go(nav.dataset.nav); return; }
});

async function awaitWrap(p) {
  try { await p; } finally { await render(); }
}

/** Cmd/Ctrl+K focuses search. */
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    go("search");
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
export function pageHead({ title, sub = "", actions = "", crumbs = null }) {
  return `${crumbs ? breadcrumb(crumbs) : ""}
  <div class="top">
    <div><h1>${esc(title)}</h1>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>
    ${actions ? `<div class="actions">${actions}</div>` : ""}
  </div>`;
}

/**
 * Resolve a page name to a screen. Five prefixes are dynamic:
 * `cpt:<name>` (a theme-declared post type), `menu:<id>` (a declared admin
 * menu), the two table pages — `table:<table>` for the list and
 * `table-edit:<table>[:<slug>]` / `table-new:<table>` for the form — and
 * `plugin-page:<id>` (a plugin-declared page, ARCHITECTURE.md §5.3).
 *
 * The table pages use three distinct prefixes rather than one prefix plus an
 * optional segment. An earlier version used `table:<table>[:<slug>]`, which
 * made "the list" and "a new row" the *same* page name when the slug was
 * absent — so the Add button navigated to the list it was already on and
 * nothing happened. Three prefixes cannot collide that way, and the absence of
 * a slug no longer has to mean two different things.
 */
async function renderScreen(c, page) {
  if (page.startsWith("cpt:")) return screens.get("content-list")(c, page.slice(4));
  if (page.startsWith("menu:")) return screens.get("theme-menu")(c, page.slice(5));
  if (page.startsWith("table-new:")) {
    return screens.get("table-edit")(c, page.slice("table-new:".length) || null, null);
  }
  if (page.startsWith("table-edit:")) {
    const rest = page.slice("table-edit:".length);
    const at = rest.indexOf(":");
    const table = at === -1 ? rest : rest.slice(0, at);
    // The slug was percent-encoded when the page name was built, because a
    // slug may contain anything a URL path segment may contain.
    const slug = at === -1 ? null : decodeURIComponent(rest.slice(at + 1));
    return screens.get("table-edit")(c, table || null, slug || null);
  }
  if (page.startsWith("table:")) {
    return screens.get("table-list")(c, page.slice("table:".length) || null);
  }
  if (page.startsWith("plugin-page:")) {
    // A plugin-declared admin page. The id is the manifest's own `adminPages[].id`,
    // validated at install time to exist — so a page that cannot be found here
    // means the plugin was disabled after its menu was written, not a bad link.
    return screens.get("plugin-page")(c, page.slice("plugin-page:".length) || null);
  }
  const screen = screens.get(page);
  if (!screen) {
    c.innerHTML = `<div class="panel">${esc(page)} ${esc(t("core.msg.notAScreen", "is not a screen."))}</div>`;
    return;
  }
  return screen(c);
}

export async function render() {
  if (!state.user) return loginScreen ? loginScreen() : undefined;

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
    await renderScreen(c, state.page);
  } catch (e) {
    c.innerHTML = `<div class="panel"><div class="top" style="margin-bottom:.5rem"><h1 style="font-size:1.125rem">${esc(t("core.msg.wentWrong", "Something went wrong"))}</h1></div><p class="muted">${esc(e.message)}</p></div>`;
  }
}
