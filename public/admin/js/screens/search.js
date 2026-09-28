/**
 * Screen: Search — debounced full-text search across this site's content.
 */
import { api, scoped } from "../state.js";
import { pageHead } from "../shell.js";
import { icon } from "../../icons.js";
import { esc } from "../../ui.js";

export default async function search(c) {
  c.innerHTML = `${pageHead({
    title: "Search",
    sub: "Full-text search across published content on this site",
    crumbs: [{ label: "General" }, { label: "Search" }],
  })}
  <div class="panel">
    <div class="header-search" style="max-width:none;height:2.5rem;cursor:text" onclick="this.querySelector('input').focus()">
      ${icon("search")}
      <input id="sq" placeholder="Search titles, slugs and excerpts…" style="flex:1;border:0;background:transparent;min-height:0;padding:0" autofocus>
    </div>
    <div id="searchResults" style="margin-top:1rem"></div>
  </div>`;
  const input = c.querySelector("#sq");
  let t = null;
  input.addEventListener("input", () => { clearTimeout(t); t = setTimeout(runSearch, 250); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); });
}

async function runSearch() {
  const q = document.querySelector("#sq")?.value?.trim();
  const box = document.querySelector("#searchResults");
  if (!box) return;
  if (!q) { box.innerHTML = `<div class="empty">Type to search.</div>`; return; }
  box.innerHTML = `<div class="muted text-sm">Searching…</div>`;
  try {
    const d = await api(scoped("search?q=" + encodeURIComponent(q)));
    const items = d.items || [];
    box.innerHTML = items.map((x) => `<div class="list-row">
        <div>
          <div class="title">${esc(x.title || x.slug)}</div>
          <div class="meta">${esc(x.type)} · ${esc(x.locale)} · /${esc(x.locale)}/${x.type === "post" ? "blog/" : ""}${esc(x.slug)}</div>
          ${x.excerpt ? `<div class="muted text-sm" style="margin-top:.25rem">${esc(x.excerpt)}</div>` : ""}
        </div>
        <span class="badge secondary">${esc(x.type)}</span>
      </div>`).join("") || `<div class="empty">No results for “${esc(q)}”.</div>`;
  } catch (e) {
    box.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}
