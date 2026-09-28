/**
 * Screen: Themes — installed themes, which site uses each, and what the theme
 * active on *this* site materialised (CPTs, routes, fields, blocks).
 */
import { api, loadContext, scoped, state } from "../state.js";
import { pageHead, render } from "../shell.js";
import { icon } from "../../icons.js";
import { alertDialog, attr, esc, toast } from "../../ui.js";
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
