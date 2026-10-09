/**
 * Screen: content list — platform content (posts, pages) and theme-declared
 * custom post types. Delegates to the editor when `state.editing` is set.
 */
import { api, contentPath, postTypeInfo, scoped, state } from "../state.js";
import { pageHead } from "../shell.js";
import { icon } from "../../icons.js";
import { t } from "../i18n.js";
import { attr, emptyRow, esc, fmtDate, statusBadge } from "../../ui.js";
import { editor } from "./editor.js";

export async function contentList(c, type) {
  const pt = postTypeInfo(type);
  if (state.editing) return editor(c, type);

  const d = await api(scoped(contentPath(type)));
  const items = d.items || [];
  const rows = items.map((x) => `<tr>
      <td><div style="font-weight:500">${esc(x.title || t("core.content.untitled", "(untitled)"))}</div><div class="muted text-sm">/${esc(x.slug || "")}</div></td>
      <td><span class="badge outline">${esc(x.locale || "—")}</span></td>
      <td>${statusBadge(x.status)}</td>
      <td class="muted text-sm">${esc(fmtDate(x.updated_at))}</td>
      <td class="actions"><button class="btn outline sm" data-edit="${attr(type)}|${attr(x.id)}">${icon("pencil")}${esc(t("core.editor.edit", "Edit"))}</button></td>
    </tr>`).join("");

  c.innerHTML = `${pageHead({
    title: pt.plural,
    sub: t("core.content.countOn", "{n} on {site}", {
      n: items.length,
      site: state.sites.find((s) => s.id === state.site)?.name || state.site,
    }),
    actions: `<button class="btn primary" data-new="${attr(type)}">${icon("plus")}${esc(t("core.content.add", "Add {type}", { type: pt.singular }))}</button>`,
    crumbs: [{ label: t("core.nav.content", "Content") }, { label: pt.plural }],
  })}
  <div class="table-wrap"><table class="table">
    <thead><tr>
      <th>${esc(t("core.content.title", "Title"))}</th>
      <th>${esc(t("core.content.locale", "Locale"))}</th>
      <th>${esc(t("core.content.status", "Status"))}</th>
      <th>${esc(t("core.content.updated", "Updated"))}</th>
      <th></th>
    </tr></thead>
    <tbody>${rows || emptyRow(5, t("core.content.noneYet", "No {type} yet.", { type: pt.plural.toLowerCase() }))}</tbody>
  </table></div>`;
}
