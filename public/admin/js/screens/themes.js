/**
 * Screen: Themes — installed themes, which site uses each, and what the theme
 * active on *this* site materialised (CPTs, routes, fields, blocks).
 */
import { api, loadContext, scoped, state } from "../state.js";
import { pageHead, render } from "../shell.js";
import { icon } from "../../icons.js";
import { t } from "../i18n.js";
import { alertDialog, attr, confirmDialog, esc, toast } from "../../ui.js";
import { installExtension } from "./extension-install.js";

function activeSitesFor(name, bySite) {
  return Object.entries(bySite || {}).filter(([, v]) => v === name).map(([k]) => k);
}

export default async function themes(c) {
  const d = await api(scoped("extensions/themes"));
  const site = state.sites.find((s) => s.id === state.site);
  const items = d.items || [];

  const cards = items.map((x) => {
    const others = activeSitesFor(x.name, x.active_by_site).filter((s) => s !== state.site);
    return `<div class="card">
      <div class="card-head">
        <div><div class="card-title" style="font-size:1rem">${esc(x.title)}</div><div class="card-desc">v${esc(x.version)}</div></div>
        ${x.active ? `<span class="badge success">${icon("check")}${esc(t("core.themes.active", "active"))}</span>` : ""}
      </div>
      <div style="height:4.5rem;margin:.9rem 0;border:1px solid var(--border);border-radius:var(--radius-md);background:linear-gradient(135deg,var(--muted),transparent);display:grid;place-items:center;color:var(--muted-foreground)">
        ${icon("palette", 'style="width:1.5rem;height:1.5rem"')}
      </div>
      ${x.active
        ? `<div class="muted text-sm">${esc(t("core.themes.activeHere", "Active on this site"))}</div>`
        : `<div class="muted text-sm">${others.length ? esc(t("core.themes.alsoUsed", "Also used by: {sites}", { sites: others.join(", ") })) : esc(t("core.themes.notInUse", "Not in use"))}</div>
           <button class="btn primary sm" style="margin-top:.75rem" data-theme-activate="${attr(x.name)}">${icon("check")}${esc(t("core.themes.activateHere", "Activate here"))}</button>
           <button class="btn outline danger sm" style="margin-top:.5rem" data-theme-del="${attr(x.name)}">${icon("trash")}${esc(t("core.themes.uninstall", "Uninstall"))}</button>`}
    </div>`;
  }).join("");

  const active = items.find((x) => x.active);
  c.innerHTML = `${pageHead({
    title: t("core.nav.themes", "Themes"),
    sub: t("core.themes.sub", "Appearance for {site}", { site: site?.name || state.site }),
    actions: `<label class="btn primary">${icon("upload")}${esc(t("core.themes.installZip", "Install theme ZIP"))}<input id="themeZip" type="file" accept=".zip" hidden></label>`,
    crumbs: [{ label: t("core.nav.appearance", "Appearance") }, { label: t("core.nav.themes", "Themes") }],
  })}
  <div class="cards">${cards || `<div class="panel"><div class="empty">${esc(t("core.themes.none", "No themes installed."))}</div></div>`}</div>
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
        <div><div class="title">${esc(label)}</div><div class="meta">${esc(t("core.themes.declared", "{n} declared", { n: (items || []).length }))}</div></div>
      </div>
      <div class="muted text-sm" style="text-align:right;max-width:60%">${items.map(fmt).join(", ") || "—"}</div>
    </div>`;

  return `<div class="panel" style="margin-top:1.25rem">
    <div class="card-title">${esc(t("core.themes.provides", "What “{name}” provides on this site", { name: active.title }))}</div>
    <div class="card-desc" style="margin-bottom:.75rem">${esc(t("core.themes.providesDesc", "Business capabilities the theme declared and CFPress materialised"))}</div>
    ${row(t("core.themes.cpt", "Custom post types"), pt.items, (x) => esc(x.plural_label || x.name), "layers")}
    ${row(t("core.themes.routes", "Routes"), routes.items, (x) => `<code>${esc(x.path)}</code>`, "route")}
    ${row(t("core.editor.customFields", "Custom fields"), fields.items, (x) => esc(x.label || x.meta_key), "file-text")}
    ${row(t("core.themes.blocks", "Blocks"), blocks.items, (x) => esc(x.title || x.name), "package")}
  </div>`;
}

document.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-theme-activate]");
  if (a) {
    try {
      await api(scoped("extensions/themes/" + a.dataset.themeActivate + "/activate"), { method: "POST" });
      toast(t("core.themes.activated", "Theme activated for this site"));
      await loadContext();
      render();
    } catch (err) { await alertDialog({ title: t("core.themes.activateFailed", "Could not activate theme"), description: err.message }); }
    return;
  }

  const del = e.target.closest("[data-theme-del]");
  if (del) {
    const name = del.dataset.themeDel;
    const sure = await confirmDialog({
      title: t("core.themes.uninstallTitle", "Uninstall this theme?"),
      description: t("core.themes.uninstallDesc", "Removes its files, registry row and generated tables. A theme that is still active on a site cannot be uninstalled."),
      confirmLabel: t("core.themes.uninstall", "Uninstall"),
    });
    if (!sure) return;
    try {
      await api(`extensions/themes/${encodeURIComponent(name)}`, { method: "DELETE" });
      toast(t("core.themes.uninstalled", "Theme uninstalled"));
      render();
    } catch (err) {
      // A 409 names the sites that still use it — show that verbatim, it is the
      // actionable part.
      await alertDialog({ title: t("core.themes.uninstallFailed", "Could not uninstall theme"), description: err.message });
    }
  }
});
