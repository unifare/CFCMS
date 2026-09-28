/**
 * Screen: content editor — title/slug/status panel, block editor, theme-declared
 * custom fields, autosave and revisions.
 *
 * Everything interactive is wired through document-level delegation so a
 * re-render (which replaces the whole subtree) never drops a handler.
 */
import { api, contentPath, postTypeInfo, scoped, state } from "../state.js";
import { go, pageHead, render } from "../shell.js";
import { icon } from "../../icons.js";
import { alertDialog, attr, confirmDialog, esc, fmtDate, toast } from "../../ui.js";

export function newContent(type) {
  state.editing = { id: null, slug: "", title: "", excerpt: "", locale: "en", status: "draft", content: "[]", meta: {} };
  state.type = type;
  render();
}

export async function editContent(type, id) {
  const d = await api(scoped(contentPath(type) + "/" + id));
  const x = d.items?.[0] || {};
  state.editing = {
    id, slug: x.slug || "", title: x.title || "", excerpt: x.excerpt || "",
    locale: x.locale || "en", status: x.status || "draft", content: x.content || "[]", meta: x.meta || {},
  };
  state.type = type;
  render();
}

/** Custom-field inputs declared by the active theme for this content type. */
function fieldInputs(type) {
  const fields = state.fields.filter((f) => !f.post_types?.length || f.post_types.includes(type));
  if (!fields.length) return "";
  const x = state.editing.meta || {};
  const inputs = fields.map((f) => {
    const val = esc(x[f.meta_key] ?? "");
    const label = esc(f.label || f.meta_key);
    const key = attr(f.meta_key);
    if (f.field_type === "number") return `<div class="field"><label>${label}</label><input data-meta="${key}" type="number" value="${val}"></div>`;
    if (f.field_type === "boolean") return `<div class="field"><label>${label}</label><select data-meta="${key}"><option value="">—</option><option value="1"${x[f.meta_key] === "1" ? " selected" : ""}>Yes</option><option value="0"${x[f.meta_key] === "0" ? " selected" : ""}>No</option></select></div>`;
    if (["textarea", "html", "richtext"].includes(f.field_type)) return `<div class="field"><label>${label}</label><textarea data-meta="${key}">${val}</textarea></div>`;
    if (f.field_type === "date") return `<div class="field"><label>${label}</label><input data-meta="${key}" type="date" value="${val}"></div>`;
    return `<div class="field"><label>${label}</label><input data-meta="${key}" value="${val}"></div>`;
  }).join("");
  return `<div class="panel" style="margin-top:1rem">
    <div class="card-title">Custom fields</div>
    <div class="card-desc" style="margin-bottom:1rem">Declared by the active theme for this content type</div>
    ${inputs}</div>`;
}

export async function editor(c, type) {
  const x = state.editing;
  let blocks = [];
  try { blocks = JSON.parse(x.content || "[]"); } catch { /* keep empty */ }
  state.blocks = Array.isArray(blocks) ? blocks : [];
  const pt = postTypeInfo(type);

  const blockButtons = [
    ["core/paragraph", "Paragraph"], ["core/heading", "Heading"], ["core/list", "List"],
    ["core/image", "Image"], ["core/quote", "Quote"], ["core/code", "Code"],
    ["core/separator", "Separator"], ["core/html", "HTML"], ["core/group", "Group"],
  ].map(([t, label]) => `<button class="btn outline sm" data-block="${attr(t)}">${icon("plus")}${esc(label)}</button>`).join("");

  c.innerHTML = `${pageHead({
    title: `${x.id ? "Edit" : "Add"} ${pt.singular}`,
    sub: x.id ? `Last saved content for ${state.site}` : "New content, saved as draft",
    actions: `<span class="badge secondary" id="saveState">Ready</span>
              <button class="btn outline" data-back="1">${icon("chevron-left")}Back</button>`,
    crumbs: [{ label: "Content" }, { label: pt.plural }, { label: x.id ? "Edit" : "Add" }],
  })}
  <div class="grid2">
    <div>
      <div class="panel">
        <div class="field"><label class="req" for="title">Title</label><input id="title" value="${attr(x.title)}" placeholder="Post title"></div>
        <div class="field">
          <label>Content</label>
          <div id="blocks" class="blocks"></div>
          <div class="toolbar" style="margin-top:.75rem">${blockButtons}</div>
        </div>
        <div class="field" style="margin-bottom:0"><label for="excerpt">Excerpt</label><textarea id="excerpt" placeholder="Short summary shown in listings">${esc(x.excerpt)}</textarea></div>
      </div>
      ${fieldInputs(type)}
    </div>
    <div>
      <div class="panel">
        <div class="field"><label for="locale">Locale</label><input id="locale" value="${attr(x.locale)}"></div>
        <div class="field"><label for="slug">Slug</label><input id="slug" value="${attr(x.slug)}" placeholder="auto from title"></div>
        <div class="field"><label for="status">Status</label><select id="status">
          ${["draft", "published", "private", "scheduled"].map((s) => `<option${x.status === s ? " selected" : ""}>${s}</option>`).join("")}
        </select></div>
        <div class="field"><label for="publishAt">Publish at</label><input id="publishAt" type="datetime-local"><span class="hint">Used when status is scheduled</span></div>
        <button class="btn primary" style="width:100%" data-action="save-content">${icon("save")}Save</button>
        ${x.id ? `<div class="toolbar" style="margin-top:.5rem">
          <button class="btn outline sm" data-action="revisions">${icon("history")}Revisions</button>
          <button class="btn outline danger sm" data-action="delete-content">${icon("trash")}Delete</button>
        </div>` : ""}
      </div>
      ${x.id ? `<div class="panel" id="revisions" style="margin-top:1rem;display:none"></div>` : ""}
    </div>
  </div>`;

  drawBlocks();
  if (x.id) {
    clearInterval(state.autosaveTimer);
    state.autosaveTimer = setInterval(doAutosave, 10000);
  }
}

function blockText(b) { return b.attrs?.text || b.attrs?.html || b.attrs?.url || ""; }

function drawBlocks() {
  const el = document.querySelector("#blocks");
  if (!el) return;
  el.innerHTML = state.blocks.map((b, i) => `<div class="block">
      <div class="blockhead">
        <b>${esc(b.type)}</b>
        <span class="block-tools">
          <button class="btn ghost sm" data-block-move="${i}|-1" title="Move up">${icon("arrow-up")}</button>
          <button class="btn ghost sm" data-block-move="${i}|1" title="Move down">${icon("arrow-down")}</button>
          <button class="btn ghost sm" data-block-dup="${i}" title="Duplicate">${icon("copy")}</button>
          <button class="btn ghost sm" data-block-del="${i}" title="Remove">${icon("trash")}</button>
        </span>
      </div>
      <textarea data-block-input="${i}" placeholder="Block content…">${esc(blockText(b))}</textarea>
    </div>`).join("") || `<div class="empty">Add a block to start writing.</div>`;
}

export function addBlock(t) { state.blocks.push({ type: t, attrs: { text: "" } }); drawBlocks(); markDirty(); }
function moveBlock(i, d) {
  const j = i + d;
  if (j < 0 || j >= state.blocks.length) return;
  [state.blocks[i], state.blocks[j]] = [state.blocks[j], state.blocks[i]];
  drawBlocks(); markDirty();
}
function duplicateBlock(i) { state.blocks.splice(i + 1, 0, JSON.parse(JSON.stringify(state.blocks[i]))); drawBlocks(); markDirty(); }
function removeBlock(i) { state.blocks.splice(i, 1); drawBlocks(); markDirty(); }
function updateBlock(i, v) { state.blocks[i].attrs = state.blocks[i].attrs || {}; state.blocks[i].attrs.text = v; markDirty(); }

function markDirty() {
  const e = document.querySelector("#saveState");
  if (e) { e.textContent = "Unsaved changes"; e.className = "badge warn"; }
}

document.addEventListener("click", (e) => {
  const n = e.target.closest("[data-new]");
  if (n) { newContent(n.dataset.new); return; }
  const ed = e.target.closest("[data-edit]");
  if (ed) {
    const [t, id] = ed.dataset.edit.split("|");
    editContent(t, id);
    return;
  }
  const add = e.target.closest("[data-block]");
  if (add) { addBlock(add.dataset.block); return; }
  const mv = e.target.closest("[data-block-move]");
  if (mv) { const [i, d] = mv.dataset.blockMove.split("|").map(Number); moveBlock(i, d); return; }
  const dup = e.target.closest("[data-block-dup]");
  if (dup) { duplicateBlock(Number(dup.dataset.blockDup)); return; }
  const del = e.target.closest("[data-block-del]");
  if (del) { removeBlock(Number(del.dataset.blockDel)); return; }
  const back = e.target.closest("[data-back]");
  if (back) { clearInterval(state.autosaveTimer); go(state.page); return; }
  const act = e.target.closest("[data-action]");
  if (!act) return;
  if (act.dataset.action === "save-content") saveContent();
  if (act.dataset.action === "revisions") showRevisions();
  if (act.dataset.action === "delete-content") deleteContent();
});

document.addEventListener("input", (e) => {
  const ta = e.target.closest("[data-block-input]");
  if (ta) { updateBlock(Number(ta.dataset.blockInput), ta.value); return; }
  if (e.target.closest("#title, #excerpt, #locale, #slug, #status")) markDirty();
});

async function doAutosave() {
  if (!state.editing?.id) return;
  const body = {
    locale: document.querySelector("#locale")?.value || "en",
    title: document.querySelector("#title")?.value || "",
    excerpt: document.querySelector("#excerpt")?.value || "",
    content: state.blocks,
  };
  try {
    await api(scoped(contentPath(state.type) + "/" + state.editing.id + "/autosave"), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const e = document.querySelector("#saveState");
    if (e) { e.textContent = "Autosaved"; e.className = "badge success"; }
  } catch { /* autosave is best-effort */ }
}

/** Collect theme-declared custom-field values from the editor. */
function collectMeta() {
  const meta = {};
  for (const el of document.querySelectorAll("[data-meta]")) meta[el.dataset.meta] = el.value;
  return meta;
}

export async function saveContent() {
  clearInterval(state.autosaveTimer);
  const titleEl = document.querySelector("#title");
  if (!titleEl.value.trim()) {
    await alertDialog({ title: "Title required", description: "Give this content a title before saving." });
    titleEl.focus();
    return;
  }
  const publishAt = document.querySelector("#publishAt")?.value;
  const body = {
    title: titleEl.value,
    excerpt: document.querySelector("#excerpt").value,
    locale: document.querySelector("#locale").value,
    slug: document.querySelector("#slug").value,
    status: document.querySelector("#status").value,
    publish_at: publishAt ? Math.floor(new Date(publishAt).getTime() / 1000) : null,
    content: state.blocks,
    meta: collectMeta(),
  };
  try {
    await api(scoped(contentPath(state.type) + (state.editing.id ? "/" + state.editing.id : "")), {
      method: state.editing.id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    toast("Saved");
    state.editing = null;
    setTimeout(render, 300);
  } catch (e) {
    toast(e.message, "error");
  }
}

export async function showRevisions() {
  const box = document.querySelector("#revisions");
  box.style.display = "block";
  box.innerHTML = `<div class="card-title">Revision history</div><div class="muted text-sm">Loading…</div>`;
  try {
    const d = await api(scoped(`${state.type}/${state.editing.id}/revisions`));
    const items = d.items || [];
    box.innerHTML = `<div class="card-title" style="margin-bottom:.75rem">Revision history</div>
      ${items.map((r) => `<div class="list-row">
        <div><div class="title">v${esc(r.version)}</div><div class="meta">${esc(r.locale)} · ${esc(fmtDate(r.created_at))}</div></div>
        <button class="btn outline sm" data-restore="${attr(r.id)}">Restore</button>
      </div>`).join("") || `<div class="empty">No revisions yet.</div>`}`;
  } catch (e) {
    box.innerHTML = `<div class="muted text-sm">${esc(e.message)}</div>`;
  }
}

document.addEventListener("click", async (e) => {
  const r = e.target.closest("[data-restore]");
  if (!r) return;
  const ok = await confirmDialog({
    title: "Restore this revision?",
    description: "The current content will be replaced by the selected revision.",
    confirmLabel: "Restore", danger: false,
  });
  if (!ok) return;
  await api(scoped(`${state.type}/${state.editing.id}/revisions/${r.dataset.restore}/restore`), { method: "POST" });
  toast("Revision restored");
  editContent(state.type, state.editing.id);
});

export async function deleteContent() {
  const ok = await confirmDialog({
    title: "Delete this content?",
    description: "This permanently removes the item and its translations. Revisions go with it.",
    confirmLabel: "Delete",
  });
  if (!ok) return;
  clearInterval(state.autosaveTimer);
  await api(scoped(contentPath(state.type) + "/" + state.editing.id), { method: "DELETE" });
  toast("Deleted");
  state.editing = null;
  go(state.page);
}
