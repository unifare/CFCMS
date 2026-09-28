/**
 * Screen: Settings — every key stored for the current site, grouped by prefix.
 */
import { api, scoped, state } from "../state.js";
import { pageHead } from "../shell.js";
import { icon } from "../../icons.js";
import { attr, esc, toast } from "../../ui.js";

export default async function settings(c) {
  const d = await api(scoped("settings"));
  const site = state.sites.find((s) => s.id === state.site);
  const items = d.items || [];

  // Group keys by their prefix (e.g. "seo.titleTemplate" -> "seo").
  const groups = {};
  for (const x of items) {
    const g = String(x.key).includes(".") ? String(x.key).split(".")[0] : "general";
    (groups[g] ||= []).push(x);
  }
  const sections = Object.entries(groups).map(([g, rows]) => `<div class="panel" style="margin-bottom:1rem">
      <div class="card-title" style="text-transform:capitalize">${esc(g)}</div>
      <div class="card-desc" style="margin-bottom:1rem">${rows.length} setting${rows.length === 1 ? "" : "s"}</div>
      ${rows.map((x) => `<div class="field"><label>${esc(x.key)}</label><input data-key="${attr(x.key)}" value="${attr(x.value)}"></div>`).join("")}
    </div>`).join("");

  c.innerHTML = `${pageHead({
    title: "Settings",
    sub: `Stored per site · ${site?.name || state.site}`,
    actions: `<button class="btn primary" data-action="save-settings">${icon("save")}Save all</button>`,
    crumbs: [{ label: "Tools" }, { label: "Settings" }],
  })}
  ${sections || `<div class="panel"><div class="empty">This site has no settings yet.</div></div>`}
  <p class="muted text-sm">Settings are stored per site. Switch sites from the sidebar to edit another one.</p>`;
}

document.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-action]");
  if (a?.dataset.action !== "save-settings") return;
  for (const el of document.querySelectorAll("[data-key]")) {
    await api(scoped("settings"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: el.dataset.key, value: el.value }) });
  }
  toast("Settings saved");
});
