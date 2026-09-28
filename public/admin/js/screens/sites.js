/**
 * Screen: Sites — multi-site registry with create / edit / delete.
 *
 * Each site owns its own content, settings, media and active theme; routing
 * matches path prefix first, then host.
 */
import { api, loadContext, state } from "../state.js";
import { pageHead, render } from "../shell.js";
import { icon } from "../../icons.js";
import { alertDialog, attr, confirmDialog, emptyRow, esc, openDialog, toast } from "../../ui.js";

export default async function sites(c) {
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
