/**
 * Screen: URL Manager — redirects and rewrites applied before theme routing.
 */
import { api } from "../state.js";
import { pageHead } from "../shell.js";
import { icon } from "../../icons.js";
import { esc } from "../../ui.js";

export default async function urls(c) {
  const [r, w] = await Promise.all([api("redirects"), api("rewrites")]);
  const list = (rows, kind) => rows.map((x) => `<div class="list-row">
      <div><div class="title">${esc(x.source || x.from || "—")}</div><div class="meta">${kind}</div></div>
      <span style="display:flex;align-items:center;gap:.5rem" class="muted">${icon("arrow-right")}<code>${esc(x.target || x.to || "")}</code></span>
    </div>`).join("") || `<div class="empty">No rules.</div>`;

  c.innerHTML = `${pageHead({
    title: "URL Manager",
    sub: "Redirects and rewrites applied before theme routing",
    crumbs: [{ label: "Tools" }, { label: "URL Manager" }],
  })}
  <div class="grid2" style="grid-template-columns:1fr 1fr">
    <div class="panel"><div class="card-title" style="margin-bottom:.5rem">Redirects</div>${list(r.items || [], "redirect")}</div>
    <div class="panel"><div class="card-title" style="margin-bottom:.5rem">Rewrites</div>${list(w.items || [], "rewrite")}</div>
  </div>`;
}
