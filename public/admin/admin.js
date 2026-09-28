/**
 * CFPress Admin SPA — entry point.
 *
 * Layout mirrors shadcn-admin: a grouped, collapsible sidebar on the left, a
 * sticky header with search / theme switch / notifications / user menu, and a
 * scrollable content area. All state lives in `state`; every screen renders
 * into `#content`.
 *
 * This file only wires things together. The work lives in:
 *
 *   js/state.js             shared state + API helpers (leaf module)
 *   js/nav.js               navigation model, sidebar, header
 *   js/shell.js             render loop, page chrome, navigation actions
 *   js/auth.js              login screen, sign-in / sign-out
 *   js/screens/<name>.js    one module per screen
 *   js/screens/index.js     the page-name → screen table
 *
 * The shell does not import any screen (and vice versa): screens register
 * themselves through the table below, which is what keeps the module graph
 * acyclic. `tests/admin-spa.test.mjs` enforces that, plus the `window.*`
 * contract described next.
 */
import { api, loadContext, state } from "./js/state.js";
import { go, render, setLoginScreen, setScreenTable, switchSite, toggleGroup, toggleSidebar } from "./js/shell.js";
import { doLogin, logout, renderLogin, setThemeForTest } from "./js/auth.js";
import { SCREENS } from "./js/screens/index.js";
import { addBlock, deleteContent, editContent, newContent, saveContent, showRevisions } from "./js/screens/editor.js";
import { installExtension } from "./js/screens/extension-install.js";
import { pluginSettings } from "./js/screens/plugins.js";
import { applyTheme, closeMenus, setTheme, toggleMenu, watchSystemTheme } from "./ui.js";

setScreenTable(SCREENS);
setLoginScreen(renderLogin);

/**
 * The external contract of the SPA.
 *
 * Rendered markup calls handlers with inline `onclick="name(...)"`, which the
 * browser resolves against `window` — not against this module's scope. So every
 * handler referenced from HTML must be published here, by name. Dropping one
 * does not fail any build: the page still renders and the button silently does
 * nothing. `tests/admin-spa.test.mjs` asserts this list matches what the markup
 * actually calls.
 */
const WINDOW_HANDLERS = {
  toggleMenu, closeMenus,          // dropdown menus (ui.js)
  toggleGroup, toggleSidebar,      // sidebar (shell.js)
  go, switchSite,                  // navigation (shell.js)
  newContent, editContent, addBlock, saveContent, showRevisions, deleteContent,  // editor
  installExtension, pluginSettings,                                              // extensions
  doLogin, logout, setThemeForTest,                                              // auth
};

for (const [name, fn] of Object.entries(WINDOW_HANDLERS)) window[name] = fn;

watchSystemTheme();
applyTheme();
(async () => {
  try {
    const d = await api("auth/me");
    state.user = d.user;
    if (!state.user) renderLogin();
    else { await loadContext(); await render(); }
  } catch { renderLogin(); }
})();
