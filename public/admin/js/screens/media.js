/**
 * Screen: media library — R2 objects for the current site, plus upload.
 */
import { api, scoped } from "../state.js";
import { pageHead, render } from "../shell.js";
import { icon } from "../../icons.js";
import { mediaUrl } from "../media-picker.js";
import { attr, emptyRow, esc, toast } from "../../ui.js";

export default async function media(c) {
  const d = await api(scoped("media"));
  const items = d.items || [];
  const isImg = (t) => String(t || "").startsWith("image/");
  const rows = items.map((x) => `<tr>
      <td>
        <div style="display:flex;align-items:center;gap:.75rem">
          <span class="team-logo" style="width:2.25rem;height:2.25rem;background:var(--muted);color:var(--muted-foreground)">
            ${isImg(x.mime_type)
              ? `<img src="${attr(mediaUrl(x.object_key))}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">`
              : icon("file-text")}
          </span>
          <div><div style="font-weight:500">${esc(x.filename)}</div><div class="muted text-sm">${esc(x.mime_type)}</div></div>
        </div>
      </td>
      <td class="muted text-sm">${esc(formatBytes(x.size))}</td>
      <td class="muted text-sm">${esc(x.alt_text || "—")}</td>
      <td class="actions">
        <a class="btn outline sm" href="${attr(mediaUrl(x.object_key))}" target="_blank" rel="noopener">${icon("external")}Open</a>
        <button class="btn outline sm" data-copy="${attr(mediaUrl(x.object_key))}">${icon("copy")}URL</button>
      </td>
    </tr>`).join("");

  c.innerHTML = `${pageHead({
    title: "Media",
    sub: `${items.length} file${items.length === 1 ? "" : "s"} in R2 for this site`,
    actions: `<label class="btn primary">${icon("upload")}Upload<input id="upload" type="file" hidden></label>`,
    crumbs: [{ label: "Content" }, { label: "Media" }],
  })}
  <div class="table-wrap"><table class="table">
    <thead><tr><th>File</th><th>Size</th><th>Alt text</th><th></th></tr></thead>
    <tbody>${rows || emptyRow(4, "No media uploaded yet.")}</tbody>
  </table></div>`;

  document.querySelector("#upload").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const fd = new FormData();
    fd.append("file", f);
    try {
      await api(scoped("media"), { method: "POST", body: fd });
      toast("Uploaded");
      render();
    } catch (err) { toast(err.message, "error"); }
  };
}

function formatBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

document.addEventListener("click", async (e) => {
  const cp = e.target.closest("[data-copy]");
  if (!cp) return;
  try {
    await navigator.clipboard.writeText(new URL(cp.dataset.copy, location.origin).href);
    toast("URL copied");
  } catch { toast("Could not copy", "error"); }
});
