/**
 * Screen: Widgets — sidebar widgets rendered by the active theme.
 */
import { api } from "../state.js";
import { pageHead, render } from "../shell.js";
import { icon } from "../../icons.js";
import { t } from "../i18n.js";
import { emptyRow, esc, openDialog, toast } from "../../ui.js";

export default async function widgets(c) {
  const d = await api("widgets");
  const rows = (d.items || []).map((x) => `<tr>
      <td><span class="badge outline">${esc(x.sidebar)}</span></td>
      <td>${esc(x.widget_type)}</td>
      <td style="font-weight:500">${esc(x.title || "—")}</td>
      <td class="muted text-sm">${esc(x.sort_order)}</td>
    </tr>`).join("");

  c.innerHTML = `${pageHead({
    title: t("core.nav.widgets", "Widgets"),
    sub: t("core.widgets.sub", "Sidebar widgets rendered by the active theme"),
    actions: `<button class="btn primary" data-action="new-widget">${icon("plus")}${esc(t("core.widgets.add", "Add widget"))}</button>`,
    crumbs: [{ label: t("core.nav.appearance", "Appearance") }, { label: t("core.nav.widgets", "Widgets") }],
  })}
  <div class="table-wrap"><table class="table">
    <thead><tr>
      <th>${esc(t("core.widgets.colSidebar", "Sidebar"))}</th>
      <th>${esc(t("core.widgets.colType", "Type"))}</th>
      <th>${esc(t("core.widgets.colTitle", "Title"))}</th>
      <th>${esc(t("core.widgets.colOrder", "Order"))}</th>
    </tr></thead>
    <tbody>${rows || emptyRow(4, t("core.widgets.none", "No widgets."))}</tbody>
  </table></div>`;
}

document.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-action]");
  if (a?.dataset.action !== "new-widget") return;
  const v = await openDialog({
    title: t("core.widgets.addTitle", "Add a widget"),
    confirmLabel: t("core.widgets.add", "Add widget"),
    fields: [
      { name: "title", label: t("core.widgets.fieldTitle", "Widget title"), placeholder: "About this site" },
      { name: "widget_type", label: t("core.widgets.fieldType", "Type"), type: "select", value: "text", options: [
        { value: "text", label: t("core.widgets.typeText", "Text") }, { value: "html", label: t("core.widgets.typeHtml", "HTML") },
        { value: "recent-posts", label: t("core.widgets.typeRecent", "Recent posts") }, { value: "menu", label: t("core.widgets.typeMenu", "Menu") },
      ] },
      { name: "sidebar", label: t("core.widgets.fieldSidebar", "Sidebar"), type: "select", value: "sidebar", options: ["sidebar", "footer", "header"] },
    ],
  });
  if (!v) return;
  await api("widgets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(v) });
  toast(t("core.widgets.added", "Widget added"));
  render();
});
