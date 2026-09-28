/**
 * Screen: Widgets — sidebar widgets rendered by the active theme.
 */
import { api } from "../state.js";
import { pageHead, render } from "../shell.js";
import { icon } from "../../icons.js";
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
