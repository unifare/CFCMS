/**
 * Screen: content list — platform content (posts, pages) and theme-declared
 * custom post types. Delegates to the editor when `state.editing` is set.
 */
import { api, contentPath, postTypeInfo, scoped, state } from "../state.js";
import { pageHead } from "../shell.js";
import { icon } from "../../icons.js";
import { attr, emptyRow, esc, fmtDate, statusBadge } from "../../ui.js";
import { editor } from "./editor.js";

export async function contentList(c, type) {
  const pt = postTypeInfo(type);
  if (state.editing) return editor(c, type);

  const d = await api(scoped(contentPath(type)));
  const rows = (d.items || []).map((x) => `<tr>
      <td><div style="font-weight:500">${esc(x.title || "(untitled)")}</div><div class="muted text-sm">/${esc(x.slug || "")}</div></td>
      <td><span class="badge outline">${esc(x.locale || "—")}</span></td>
      <td>${statusBadge(x.status)}</td>
      <td class="muted text-sm">${esc(fmtDate(x.updated_at))}</td>
      <td class="actions"><button class="btn outline sm" data-edit="${attr(type)}|${attr(x.id)}">${icon("pencil")}Edit</button></td>
    </tr>`).join("");

  c.innerHTML = `${pageHead({
    title: pt.plural,
    sub: `${(d.items || []).length} item${(d.items || []).length === 1 ? "" : "s"} on ${state.sites.find((s) => s.id === state.site)?.name || state.site}`,
    actions: `<button class="btn primary" data-new="${attr(type)}">${icon("plus")}Add ${esc(pt.singular)}</button>`,
    crumbs: [{ label: "Content" }, { label: pt.plural }],
  })}
  <div class="table-wrap"><table class="table">
    <thead><tr><th>Title</th><th>Locale</th><th>Status</th><th>Updated</th><th></th></tr></thead>
    <tbody>${rows || emptyRow(5, `No ${pt.plural.toLowerCase()} yet.`)}</tbody>
  </table></div>`;
}
