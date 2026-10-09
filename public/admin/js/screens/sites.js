/**
 * Screen: Sites — multi-site registry with create / edit / delete.
 *
 * Each site owns its own content, settings, media and active theme; routing
 * matches path prefix first, then host.
 */
import { api, loadContext, state } from "../state.js";
import { pageHead, render } from "../shell.js";
import { icon } from "../../icons.js";
import { t } from "../i18n.js";
import { alertDialog, attr, confirmDialog, emptyRow, esc, openDialog, toast } from "../../ui.js";

export default async function sites(c) {
  const d = await api("sites");
  state.sites = d.items || [];
  const rows = state.sites.map((s) => `<tr>
      <td><code>${esc(s.id)}</code>${s.id === state.site ? ` <span class="badge default">${esc(t("core.sites.current", "current"))}</span>` : ""}</td>
      <td style="font-weight:500">${esc(s.name)}</td>
      <td class="muted text-sm">${esc(s.host || "—")}</td>
      <td class="muted text-sm">${esc(s.path_prefix || "—")}</td>
      <td>${s.is_default ? `<span class="badge success">${esc(t("core.sites.default", "default"))}</span>` : `<span class="muted">—</span>`}</td>
      <td class="actions">
        <button class="btn outline sm" data-site-edit="${attr(s.id)}">${icon("pencil")}${esc(t("core.editor.edit", "Edit"))}</button>
        ${s.id === state.site ? "" : `<button class="btn outline sm" data-switch-site="${attr(s.id)}">${icon("arrow-right")}${esc(t("core.sites.switch", "Switch"))}</button>`}
        ${s.is_default ? "" : `<button class="btn outline danger sm" data-site-del="${attr(s.id)}">${icon("trash")}${esc(t("core.action.delete", "Delete"))}</button>`}
      </td>
    </tr>`).join("");

  c.innerHTML = `${pageHead({
    title: t("core.nav.sites", "Sites"),
    sub: t("core.sites.sub", "Each site has its own content, settings, media and active theme"),
    actions: `<button class="btn primary" data-action="new-site">${icon("plus")}${esc(t("core.sites.add", "Add site"))}</button>`,
    crumbs: [{ label: t("core.nav.system", "System") }, { label: t("core.nav.sites", "Sites") }],
  })}
  <div class="table-wrap"><table class="table">
    <thead><tr>
      <th>${esc(t("core.sites.colId", "ID"))}</th>
      <th>${esc(t("core.sites.colName", "Name"))}</th>
      <th>${esc(t("core.sites.colHost", "Host"))}</th>
      <th>${esc(t("core.sites.colPrefix", "Path prefix"))}</th>
      <th>${esc(t("core.sites.colDefault", "Default"))}</th>
      <th></th>
    </tr></thead>
    <tbody>${rows || emptyRow(6, t("core.sites.none", "No sites."))}</tbody>
  </table></div>
  <div class="panel" style="margin-top:1rem">
    <div class="card-title">${esc(t("core.sites.routing", "How routing works"))}</div>
    <p class="muted text-sm" style="margin:.5rem 0 0">${esc(t("core.sites.routingDesc", "A request is matched to a site by path prefix first (longest match wins), then by host. Anything unmatched falls back to the default site. Content, settings, menus, media and the active theme are all stored per site."))}</p>
  </div>`;
}

document.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-action]");
  if (a?.dataset.action === "new-site") {
    const v = await openDialog({
      title: t("core.sites.addTitle", "Add a site"),
      description: t("core.sites.addDesc", "A site is isolated: its own content, settings and theme."),
      confirmLabel: t("core.sites.createSite", "Create site"),
      fields: [
        { name: "id", label: t("core.sites.fieldId", "Site ID"), required: true, placeholder: "shop", hint: t("core.sites.idHint", "Lowercase letters, digits, - or _") },
        { name: "name", label: t("core.sites.fieldName", "Site name"), required: true, placeholder: "Shop" },
        { name: "host", label: t("core.sites.fieldHost", "Host"), placeholder: "shop.example.com", hint: t("core.sites.hostHint", "Optional. Matches the request host.") },
        { name: "path_prefix", label: t("core.sites.fieldPrefix", "Path prefix"), placeholder: "/shop", hint: t("core.sites.prefixHint", "Optional. Longest prefix wins.") },
      ],
    });
    if (!v) return;
    if (!/^[a-z0-9_-]+$/.test(v.id)) { await alertDialog({ title: t("core.sites.badId", "Invalid site ID"), description: t("core.sites.badIdDesc", "Use only lowercase letters, digits, - and _.") }); return; }
    try {
      await api("sites", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: v.id, name: v.name, host: v.host || null, path_prefix: v.path_prefix || null }) });
      toast(t("core.sites.created", "Site created"));
      await loadContext();
      render();
    } catch (err) { await alertDialog({ title: t("core.sites.createFailed", "Could not create site"), description: err.message }); }
  }

  const ed = e.target.closest("[data-site-edit]");
  if (ed) {
    const s = state.sites.find((x) => x.id === ed.dataset.siteEdit);
    if (!s) return;
    const v = await openDialog({
      title: t("core.sites.editTitle", "Edit “{name}”", { name: s.name }),
      confirmLabel: t("core.sites.saveChanges", "Save changes"),
      fields: [
        { name: "name", label: t("core.sites.fieldName", "Site name"), value: s.name, required: true },
        { name: "host", label: t("core.sites.fieldHost", "Host"), value: s.host || "", placeholder: "shop.example.com" },
        { name: "path_prefix", label: t("core.sites.fieldPrefix", "Path prefix"), value: s.path_prefix || "", placeholder: "/shop" },
      ],
    });
    if (!v) return;
    try {
      await api("sites/" + s.id, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: v.name, host: v.host || null, path_prefix: v.path_prefix || null }) });
      toast(t("core.sites.updated", "Site updated"));
      await loadContext();
      render();
    } catch (err) { await alertDialog({ title: t("core.sites.updateFailed", "Could not update site"), description: err.message }); }
  }

  const del = e.target.closest("[data-site-del]");
  if (del) {
    const ok = await confirmDialog({
      title: t("core.sites.deleteTitle", "Delete site “{name}”?", { name: del.dataset.siteDel }),
      description: t("core.sites.deleteDesc", "Its content is preserved in the database but becomes unreachable."),
      confirmLabel: t("core.sites.deleteSite", "Delete site"),
    });
    if (!ok) return;
    try {
      await api("sites/" + del.dataset.siteDel, { method: "DELETE" });
      toast(t("core.sites.deleted", "Site deleted"));
      if (state.site === del.dataset.siteDel) state.site = "default";
      await loadContext();
      render();
    } catch (err) { await alertDialog({ title: t("core.sites.deleteFailed", "Could not delete site"), description: err.message }); }
  }
});
