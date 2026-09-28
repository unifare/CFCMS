/**
 * Screen: Dashboard — counts, recent content and what the active theme brings.
 */
import { api, scoped, state } from "../state.js";
import { pageHead } from "../shell.js";
import { icon } from "../../icons.js";
import { attr, esc } from "../../ui.js";

export default async function dashboard(c) {
  const d = await api(scoped("dashboard"));
  const site = state.sites.find((s) => s.id === state.site);

  const stat = (label, value, note) => `<div class="card">
    <div class="card-head"><span class="card-title">${esc(label)}</span>${icon("chart", 'class="nav-icon" style="width:1rem;height:1rem;color:var(--muted-foreground)"')}</div>
    <div class="metric">${esc(value ?? 0)}</div>
    ${note ? `<div class="metric-note">${note}</div>` : ""}
  </div>`;

  const cptCards = state.postTypes
    .map((pt) => `<div class="card">
      <div class="card-head"><span class="card-title">${esc(pt.plural_label || pt.label || pt.name)}</span><span class="badge secondary">CPT</span></div>
      <div class="metric-note" style="margin-top:.75rem">Theme-declared content type</div>
      <button class="btn outline sm" style="margin-top:.75rem" data-nav="cpt:${attr(pt.name)}">Open</button>
    </div>`)
    .join("");

  const recent = (d.recent || []).slice(0, 5).map((r) => `<div class="list-row">
      <div><div class="title">${esc(r.title || "(untitled)")}</div><div class="meta">${esc(r.type)} · ${esc(r.locale || "—")}</div></div>
      <span class="badge secondary">${esc(r.status)}</span>
    </div>`).join("");

  c.innerHTML = `${pageHead({
    title: "Dashboard",
    sub: `${site?.name || state.site} · Cloudflare-native CMS`,
    actions: `<button class="btn outline" data-nav="search">${icon("search")}Search</button>
              <button class="btn primary" data-nav="posts">${icon("plus")}New post</button>`,
    crumbs: [{ label: "Home" }, { label: "Dashboard" }],
  })}
  <div class="cards cols-4">
    ${stat("Posts", d.posts, `<span class="up">${esc(d.published ?? 0)}</span> published`)}
    ${stat("Pages", d.pages)}
    ${stat("Media", d.media)}
    ${stat("Drafts", d.drafts, "awaiting review")}
  </div>
  <div class="grid2" style="margin-top:1.25rem;grid-template-columns:minmax(0,1fr) 22rem">
    <div class="panel">
      <div class="card-head" style="margin-bottom:1rem">
        <div><div class="card-title">Recent content</div><div class="card-desc">Latest updates across this site</div></div>
        <button class="btn outline sm" data-nav="posts">View all</button>
      </div>
      ${recent || `<div class="empty">No content yet.</div>`}
    </div>
    <div class="panel">
      <div class="card-title">CFPress 0.8.0</div>
      <p class="muted text-sm" style="margin:.5rem 0 0">
        Multi-site, theme business packages (custom post types, fields, routes, admin menus),
        declarative template engine, revisions, autosave, multilingual content, R2 media and block editor.
      </p>
      <div class="menu-sep" style="margin:1rem -1.25rem"></div>
      <div class="card-title">Active theme</div>
      <div id="dash-theme" class="muted text-sm" style="margin-top:.5rem">Loading…</div>
    </div>
  </div>
  ${cptCards ? `<div class="panel" style="margin-top:1.25rem">
    <div class="card-title" style="margin-bottom:1rem">Content types from the active theme</div>
    <div class="cards">${cptCards}</div>
  </div>` : ""}`;

  // Theme name loads independently so a failure never blanks the dashboard.
  api(scoped("extensions/themes"))
    .then((t) => {
      const active = (t.items || []).find((x) => x.active);
      const el = document.querySelector("#dash-theme");
      if (el) el.textContent = active ? `${active.title} v${active.version}` : "No theme active";
    })
    .catch(() => {
      const el = document.querySelector("#dash-theme");
      if (el) el.textContent = "—";
    });
}
