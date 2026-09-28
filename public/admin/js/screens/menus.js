/**
 * Screen: Menus — site navigation menus and a preview of their items.
 */
import { api, scoped } from "../state.js";
import { pageHead, render } from "../shell.js";
import { icon } from "../../icons.js";
import { attr, emptyRow, esc, openDialog, toast } from "../../ui.js";

export default async function menus(c) {
  const d = await api(scoped("menus"));
  const items = d.items || [];
  const rows = items.map((m) => `<tr>
      <td><div style="font-weight:500">${esc(m.name)}</div><div class="muted text-sm" id="menu-${attr(m.id)}">Loading…</div></td>
      <td><span class="badge outline">${esc(m.location || "—")}</span></td>
      <td class="actions"><button class="btn outline sm" data-menu-items="${attr(m.id)}">${icon("arrow-right")}View items</button></td>
    </tr>`).join("");

  c.innerHTML = `${pageHead({
    title: "Menus",
    sub: `${items.length} menu${items.length === 1 ? "" : "s"} for this site`,
    actions: `<button class="btn primary" data-action="new-menu">${icon("plus")}New menu</button>`,
    crumbs: [{ label: "Appearance" }, { label: "Menus" }],
  })}
  <div class="table-wrap"><table class="table">
    <thead><tr><th>Menu</th><th>Location</th><th></th></tr></thead>
    <tbody>${rows || emptyRow(3, "No menus for this site yet.")}</tbody>
  </table></div>`;

  for (const m of items) {
    try {
      const x = await api(scoped("menus/" + m.id + "/items"));
      const el = document.querySelector(`#menu-${CSS.escape(m.id)}`);
      if (el) el.textContent = (x.items || []).map((i) => `${i.title} → ${i.url}`).join("  ·  ") || "No items";
    } catch { /* leave the placeholder */ }
  }
}

document.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-action]");
  if (a?.dataset.action !== "new-menu") return;
  const v = await openDialog({
    title: "New menu",
    confirmLabel: "Create menu",
    fields: [
      { name: "name", label: "Menu name", required: true, placeholder: "Primary" },
      { name: "location", label: "Location", type: "select", value: "header", options: ["header", "footer", "sidebar"] },
    ],
  });
  if (!v) return;
  await api(scoped("menus"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(v) });
  toast("Menu created");
  render();
});
