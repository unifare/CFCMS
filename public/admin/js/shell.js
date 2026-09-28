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
import { app, loadContext, state } from "./state.js";
import { header, rememberGroups, sidebar } from "./nav.js";
import { closeMenus, esc, setTheme, toast } from "../ui.js";

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
  closeDrawer();
  closeMenus();
  await render();
}

export async function switchSite(id) {
  state.site = id;
  state.editing = null;
  closeMenus();
  await loadContext();
  await render();
  toast(`Switched to ${state.sites.find((s) => s.id === id)?.name || id}`);
}

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
  if (siteBtn) { switchSite(siteBtn.dataset.switchSite); return; }
  const nav = e.target.closest("[data-nav]");
  if (nav) { go(nav.dataset.nav); return; }
});

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
 * Resolve a page name to a screen. Two prefixes are dynamic:
 * `cpt:<name>` (a theme-declared post type) and `menu:<id>` (a theme-declared
 * admin menu). Everything else is a plain lookup.
 */
async function renderScreen(c, page) {
  if (page.startsWith("cpt:")) return screens.get("content-list")(c, page.slice(4));
  if (page.startsWith("menu:")) return screens.get("theme-menu")(c, page.slice(5));
  const screen = screens.get(page);
  if (!screen) {
    c.innerHTML = `<div class="panel">${esc(page)} is not a screen.</div>`;
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
    c.innerHTML = `<div class="panel"><div class="top" style="margin-bottom:.5rem"><h1 style="font-size:1.125rem">Something went wrong</h1></div><p class="muted">${esc(e.message)}</p></div>`;
  }
}
