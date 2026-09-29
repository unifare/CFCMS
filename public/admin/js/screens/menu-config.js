/**
 * Screen: Menu configuration — two clearly separated layers.
 *
 * 1. Site menu (top): a real menu editor for the whole site — rename items and
 *    groups per UI language (en / zh-CN today, any locale the dictionary has),
 *    reorder items (drag the handle or use the arrows), move an item to
 *    another group, reorder groups, and hide an item for everyone. Stored as
 *    one per-site JSON blob (`admin.menu.custom` in the settings table) and
 *    applied by nav.js `applyMenuCustom` — the same definition the sidebar
 *    consumes. Requires `settings.manage`; without it the panel renders
 *    read-only (and the server enforces the permission regardless).
 * 2. My display preferences (bottom): the per-user hide/show toggles. UI-level
 *    only, unchanged from the previous iteration.
 *
 * Every change saves immediately (one PUT per change). The section being
 * edited stays open across the re-render (`openKey` / `openGroup`), so
 * entering an English and a Chinese label does not require reopening.
 *
 * Structural changes (reorder / move between groups) materialize explicit
 * `order` integers for every group and item — mixed implicit/explicit
 * ordering then cannot be misread, while items the editor never touched
 * (a freshly installed plugin's menu, a new CPT) keep their built-in
 * sequence after the ordered ones, per `applyMenuCustom`'s stable sort.
 */
import { api, state } from "../state.js";
import { pageHead, render } from "../shell.js";
import { icon } from "../../icons.js";
import { alertDialog, confirmDialog, esc, attr, toast } from "../../ui.js";
import { t, currentLocale, UI_LANGUAGES } from "../i18n.js";
import { baseGroups, applyMenuCustom } from "../nav.js";

/** Working copy of the customization blob; reset from server state on mount. */
let draft = { items: {}, groups: {} };
/** applyMenuCustom(baseGroups(), draft) — the arrangement the editor shows. */
let applied = [];
/** Item / group whose inline editor is expanded (survives re-render). */
let openKey = null;
let openGroup = null;

function locale() { return currentLocale() || "en"; }

function rebuild() {
  applied = applyMenuCustom(baseGroups(), draft, locale());
}

/** Write explicit orders for every group and item into the draft. */
function materializeAll() {
  applied.forEach((g, gi) => {
    draft.groups[g.id] = { ...(draft.groups[g.id] || {}), order: gi };
    g.items.forEach((it, ii) => {
      draft.items[it.key] = { ...(draft.items[it.key] || {}), order: ii };
    });
  });
}

async function saveCustom() {
  try {
    const d = await api("admin-menus/custom", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });
    if (d.error) throw new Error(d.error);
    state.menuCustom = { items: d.items || {}, groups: d.groups || {} };
    rebuild(); // re-apply from the server-normalized copy
    await render();
  } catch (err) {
    await alertDialog({ title: t("core.menuConfig.title", "Menu configuration"), description: err.message });
  }
}

async function savePrefs() {
  try {
    await api("admin-menus/prefs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hidden: [...state.hiddenMenus] }),
    });
    await render();
  } catch (err) {
    await alertDialog({ title: t("core.menuConfig.title", "Menu configuration"), description: err.message });
  }
}

function moveItem(key, dir) {
  const g = applied.find((gr) => gr.items.some((it) => it.key === key));
  if (!g) return;
  const idx = g.items.findIndex((it) => it.key === key);
  const to = dir === "up" ? idx - 1 : idx + 1;
  if (to < 0 || to >= g.items.length) return;
  [g.items[idx], g.items[to]] = [g.items[to], g.items[idx]];
  materializeAll();
  saveCustom();
}

/** Drop `key` right before `targetKey` — possibly into another group. */
function moveBefore(key, targetKey) {
  if (key === targetKey) return;
  const from = applied.find((gr) => gr.items.some((it) => it.key === key));
  const item = from?.items.find((it) => it.key === key);
  const to = applied.find((gr) => gr.items.some((it) => it.key === targetKey));
  if (!from || !item || !to) return;
  from.items.splice(from.items.indexOf(item), 1);
  to.items.splice(to.items.findIndex((it) => it.key === targetKey), 0, item);
  materializeAll();
  saveCustom();
}

function moveGroup(id, dir) {
  const idx = applied.findIndex((gr) => gr.id === id);
  const to = dir === "up" ? idx - 1 : idx + 1;
  if (idx < 0 || to < 0 || to >= applied.length) return;
  [applied[idx], applied[to]] = [applied[to], applied[idx]];
  materializeAll();
  saveCustom();
}

function itemRow(it, g, canManage) {
  const locked = it.key === "dashboard"; // escape hatch: never hidden, never moved
  const idx = g.items.indexOf(it);
  const badge = it.siteHidden ? ` <span class="muted text-sm">(${esc(t("core.menuConfig.siteHidden", "Hide for everyone"))})</span>` : "";
  const arrows = canManage && !locked
    ? `<button class="icon-btn" data-item-move="up" data-row-key="${attr(it.key)}" ${idx === 0 ? "disabled" : ""} aria-label="Up">${icon("arrow-up")}</button>
       <button class="icon-btn" data-item-move="down" data-row-key="${attr(it.key)}" ${idx === g.items.length - 1 ? "disabled" : ""} aria-label="Down">${icon("arrow-down")}</button>`
    : "";
  const edit = canManage && !locked
    ? `<button class="icon-btn" data-item-edit="${attr(it.key)}" aria-label="Edit">${icon("pencil")}</button>`
    : "";
  const drag = canManage && !locked ? `<span class="muted" draggable="true" style="cursor:grab;user-select:none">≡</span>` : `<span class="muted" style="width:.9rem"></span>`;
  const editor = openKey === it.key && canManage ? itemEditor(it, g) : "";
  return `<div data-row-key="${attr(it.key)}" style="margin-bottom:.35rem">
    <div draggable="${canManage && !locked}" style="display:flex;align-items:center;gap:.5rem;padding:.35rem .5rem;border:1px solid var(--border);border-radius:.5rem;background:var(--card)">
      ${drag}
      <span class="nav-icon" style="display:inline-flex;width:1.2rem">${icon(it.icon)}</span>
      <span style="flex:1">${esc(it.title)}${badge}</span>
      <span class="muted text-sm">${esc(it.key)}</span>
      ${arrows}${edit}
    </div>
    ${editor}
  </div>`;
}

function itemEditor(it, g) {
  const o = draft.items[it.key] || {};
  const label = o.label || {};
  const langInputs = UI_LANGUAGES.map(([code, name]) => `
    <div class="field" style="margin-bottom:.5rem">
      <label>${esc(name)} · ${esc(t("core.menuConfig.label", "Label"))}</label>
      <input data-item-label="${attr(code)}" data-row-key="${attr(it.key)}" value="${attr(typeof label[code] === "string" ? label[code] : "")}" placeholder="${attr(it.title)}">
    </div>`).join("");
  const options = applied
    .map((gr) => `<option value="${attr(gr.id)}" ${gr.id === g.id ? "selected" : ""}>${esc(gr.label)} (${esc(gr.id)})</option>`)
    .join("");
  return `<div style="border:1px dashed var(--border);border-radius:.5rem;padding:.75rem;margin:.25rem 0 .5rem 1.9rem">
    ${langInputs}
    <div class="field" style="margin-bottom:.5rem">
      <label>${esc(t("core.menuConfig.group", "Move to group"))}</label>
      <select data-item-group data-row-key="${attr(it.key)}">${options}</select>
    </div>
    <label style="display:flex;align-items:center;gap:.5rem;margin-bottom:.75rem">
      <input type="checkbox" data-item-hidden data-row-key="${attr(it.key)}" ${o.hidden ? "checked" : ""}>
      <span>${esc(t("core.menuConfig.siteHidden", "Hide for everyone"))}</span>
    </label>
    <button class="btn" data-item-reset="${attr(it.key)}">${icon("refresh")}${esc(t("core.menuConfig.resetItem", "Reset"))}</button>
  </div>`;
}

function groupPanel(g, gi, canManage) {
  const oc = draft.groups[g.id] || {};
  const labelEditor = openGroup === g.id && canManage
    ? `<div style="border:1px dashed var(--border);border-radius:.5rem;padding:.75rem;margin-top:.5rem">
        ${UI_LANGUAGES.map(([code, name]) => `
          <div class="field" style="margin-bottom:.5rem">
            <label>${esc(name)} · ${esc(t("core.menuConfig.label", "Label"))}</label>
            <input data-group-label="${attr(code)}" data-group-id="${attr(g.id)}" value="${attr(typeof (oc.label || {})[code] === "string" ? oc.label[code] : "")}" placeholder="${attr(g.label)}">
          </div>`).join("")}
      </div>`
    : "";
  const arrows = canManage
    ? `<button class="icon-btn" data-group-move="up" data-group="${attr(g.id)}" ${gi === 0 ? "disabled" : ""} aria-label="Up">${icon("arrow-up")}</button>
       <button class="icon-btn" data-group-move="down" data-group="${attr(g.id)}" ${gi === applied.length - 1 ? "disabled" : ""} aria-label="Down">${icon("arrow-down")}</button>`
    : "";
  const name = canManage
    ? `<button data-group-edit="${attr(g.id)}" style="font-weight:600;background:none;border:none;cursor:pointer;color:inherit;padding:0">${esc(g.label)}</button>`
    : `<span style="font-weight:600">${esc(g.label)}</span>`;
  return `<div class="panel" style="margin-bottom:1rem">
    <div style="display:flex;align-items:center;gap:.35rem">
      ${arrows}
      ${name}
      <button data-group-edit="${attr(g.id)}" class="icon-btn" aria-label="Edit">${icon("pencil")}</button>
      <span class="muted text-sm" style="flex:1">${esc(g.id)} · ${g.items.length}</span>
    </div>
    ${labelEditor}
    <div style="margin-top:.5rem">${g.items.map((it) => itemRow(it, g, canManage)).join("")}</div>
  </div>`;
}

export default async function menuConfig(c) {
  const canManage = state.menuCanManage === true;
  draft = JSON.parse(JSON.stringify(state.menuCustom || { items: {}, groups: {} }));
  rebuild();

  const sitePanel = `
    <div class="panel" style="margin-bottom:1rem">
      <div style="font-weight:600;font-size:1rem">${esc(t("core.menuConfig.siteEditor", "Site menu"))}</div>
      <div class="muted text-sm" style="margin:.25rem 0 .75rem">${esc(t("core.menuConfig.siteEditorSub", "Renames, ordering, grouping and hiding below apply to every admin of this site. Permissions are unchanged."))}</div>
      ${canManage ? `<div class="muted text-sm" style="margin-bottom:.75rem">${esc(t("core.menuConfig.dragHint", "Drag the handle or use the arrows to reorder. Click a name to edit it."))}</div>` : `<div class="muted text-sm" style="margin-bottom:.75rem">${esc(t("core.menuConfig.readonlyHint", "You can look but not edit: changing the site menu requires the settings.manage permission."))}</div>`}
    </div>
    ${applied.map((g, gi) => groupPanel(g, gi, canManage)).join("")}`;

  const prefsGroups = navPrefsModel();
  const myPanel = `
    <div class="panel">
      <div style="font-weight:600;font-size:1rem">${esc(t("core.menuConfig.myPrefs", "My display preferences"))}</div>
      <div class="muted text-sm" style="margin:.25rem 0 .75rem">${esc(t("core.menuConfig.myPrefsSub", "Only affects what you see — the site menu above is shared."))}</div>
      <div style="display:flex;gap:.5rem;margin-bottom:.75rem">
        <button class="btn" data-action="menus-show-all">${esc(t("core.menuConfig.showAll", "Show all"))}</button>
        <button class="btn" data-action="menus-hide-all">${esc(t("core.menuConfig.hideAll", "Hide all"))}</button>
      </div>
      ${prefsGroups}
    </div>`;

  c.innerHTML = `${pageHead({
    title: t("core.menuConfig.title", "Menu configuration"),
    sub: t("core.menuConfig.sub", "Choose which items appear in your sidebar. This only affects what you see — permissions stay exactly as they are."),
    actions: canManage ? `<button class="btn" data-action="menus-reset-all">${icon("refresh")}${esc(t("core.menuConfig.resetAll", "Reset to defaults"))}</button>` : "",
    crumbs: [{ label: t("core.menuConfig.title", "Menu configuration") }],
  })}
  ${sitePanel}
  ${myPanel}`;
}

/** The per-user toggle list: every item, with what is hidden for *me*. */
function navPrefsModel() {
  return applyMenuCustom(baseGroups(), state.menuCustom, locale())
    .map((g) => {
      const rows = g.items.map((it) => {
        const locked = it.key === "dashboard";
        const visible = locked || (!it.siteHidden && !state.hiddenMenus.has(it.key));
        return `<label style="display:flex;align-items:center;gap:.6rem;padding:.35rem 0;cursor:pointer">
          <input type="checkbox" data-menu-toggle="${esc(it.key)}" ${visible ? "checked" : ""} ${locked || it.siteHidden ? "disabled" : ""}>
          <span class="nav-icon" style="display:inline-flex;width:1.2rem">${icon(it.icon)}</span>
          <span style="flex:1">${esc(it.title)}${it.siteHidden ? ` <span class="muted text-sm">(${esc(t("core.menuConfig.siteHidden", "Hide for everyone"))})</span>` : ""}</span>
          <span class="muted text-sm">${esc(it.key)}</span>
        </label>`;
      }).join("");
      return `<div style="border-top:1px solid var(--border);padding-top:.5rem;margin-top:.25rem">
        <div style="font-weight:600;margin-bottom:.25rem">${esc(g.label)}</div>${rows}
      </div>`;
    })
    .join("");
}

// -- events (document-level, registered once; the screen re-renders freely) --

let dragKey = null;

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action],[data-item-edit],[data-item-move],[data-item-reset],[data-group-edit],[data-group-move]");
  if (!btn) return;
  const ds = btn.dataset;

  if (ds.action === "menus-reset-all") {
    const yes = await confirmDialog({
      title: t("core.menuConfig.resetAll", "Reset to defaults"),
      description: t("core.menuConfig.resetConfirm", "Reset the menu to defaults? All custom names, ordering and hiding will be cleared."),
      confirmLabel: t("core.menuConfig.resetAll", "Reset to defaults"),
    });
    if (!yes) return;
    try {
      await api("admin-menus/custom", { method: "DELETE" });
      state.menuCustom = { items: {}, groups: {} };
      openKey = openGroup = null;
      await render();
      toast(t("core.msg.saved", "Saved."));
    } catch (err) {
      await alertDialog({ title: t("core.menuConfig.title", "Menu configuration"), description: err.message });
    }
    return;
  }
  if (ds.action === "menus-show-all") {
    state.hiddenMenus.clear();
    await savePrefs();
    toast(t("core.msg.saved", "Saved."));
    return;
  }
  if (ds.action === "menus-hide-all") {
    // Same rule as the sidebar: dashboard stays.
    const all = applyMenuCustom(baseGroups(), state.menuCustom, locale())
      .flatMap((g) => g.items.map((it) => it.key))
      .filter((k) => k !== "dashboard");
    state.hiddenMenus = new Set(all);
    await savePrefs();
    toast(t("core.msg.saved", "Saved."));
    return;
  }
  if (ds.itemEdit !== undefined && ds.itemEdit !== "") {
    openKey = openKey === ds.itemEdit ? null : ds.itemEdit;
    openGroup = null;
    await render();
    return;
  }
  if (ds.itemReset !== undefined && ds.itemReset !== "") {
    delete draft.items[ds.itemReset];
    await saveCustom();
    return;
  }
  if (ds.itemMove && ds.rowKey) {
    moveItem(ds.rowKey, ds.itemMove);
    return;
  }
  if (ds.groupEdit !== undefined && ds.groupEdit !== "") {
    openGroup = openGroup === ds.groupEdit ? null : ds.groupEdit;
    openKey = null;
    await render();
    return;
  }
  if (ds.groupMove && ds.group) {
    moveGroup(ds.group, ds.groupMove);
    return;
  }
});

document.addEventListener("change", async (e) => {
  const el = e.target;
  if (!el || !el.matches) return;

  if (el.matches("[data-menu-toggle]")) {
    const key = el.dataset.menuToggle;
    if (el.checked) state.hiddenMenus.delete(key);
    else state.hiddenMenus.add(key);
    await savePrefs();
    return;
  }
  if (!draft) return;
  const rowKey = el.dataset.rowKey;

  if (el.matches("[data-item-label]") && rowKey) {
    const o = draft.items[rowKey] || (draft.items[rowKey] = {});
    const label = { ...(o.label || {}) };
    const v = el.value.trim();
    if (v) label[el.dataset.itemLabel] = v;
    else delete label[el.dataset.itemLabel];
    if (Object.keys(label).length) o.label = label;
    else delete o.label;
    if (!Object.keys(o).length) delete draft.items[rowKey];
    await saveCustom();
    return;
  }
  if (el.matches("[data-item-group]") && rowKey) {
    draft.items[rowKey] = { ...(draft.items[rowKey] || {}), group: el.value };
    materializeAll();
    await saveCustom();
    return;
  }
  if (el.matches("[data-item-hidden]") && rowKey) {
    draft.items[rowKey] = { ...(draft.items[rowKey] || {}), hidden: el.checked };
    await saveCustom();
    return;
  }
  if (el.matches("[data-group-label]")) {
    const gid = el.dataset.groupId;
    const o = draft.groups[gid] || (draft.groups[gid] = {});
    const label = { ...(o.label || {}) };
    const v = el.value.trim();
    if (v) label[el.dataset.groupLabel] = v;
    else delete label[el.dataset.groupLabel];
    if (Object.keys(label).length) o.label = label;
    else delete o.label;
    if (!Object.keys(o).length) delete draft.groups[gid];
    await saveCustom();
  }
});

document.addEventListener("keydown", (e) => {
  const el = e.target;
  // Enter commits a rename without requiring a click elsewhere — the change
  // event (and thus the save) fires on blur, Enter just gets there faster.
  if (el && el.matches && el.matches("[data-item-label],[data-group-label]") && e.key === "Enter") {
    e.preventDefault();
    el.blur();
  }
});

document.addEventListener("dragstart", (e) => {
  const row = e.target?.closest?.("[data-row-key][draggable='true']");
  if (row) {
    dragKey = row.dataset.rowKey;
    try { e.dataTransfer.setData("text/plain", dragKey); } catch { /* some targets */ }
  }
});
document.addEventListener("dragover", (e) => {
  const row = e.target?.closest?.("[data-row-key]");
  if (row && dragKey && row.dataset.rowKey !== dragKey) e.preventDefault();
});
document.addEventListener("drop", (e) => {
  const row = e.target?.closest?.("[data-row-key]");
  if (!row || !dragKey) { dragKey = null; return; }
  if (row.dataset.rowKey !== dragKey) {
    e.preventDefault();
    moveBefore(dragKey, row.dataset.rowKey);
  }
  dragKey = null;
});
