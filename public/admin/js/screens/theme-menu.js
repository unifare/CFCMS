/**
 * Screen: theme-contributed admin menus (`menu:<id>` pages).
 *
 * A theme declares menus with a `screen` type; the platform renders it. Only
 * two types are implemented so far — anything else shows its own declaration
 * rather than becoming a dead end.
 */
import { api, state } from "../state.js";
import { pageHead } from "../shell.js";
import { icon } from "../../icons.js";
import { attr, esc, toast } from "../../ui.js";
import { contentList } from "./content-list.js";

export default async function themeMenuScreen(c, menuId) {
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
