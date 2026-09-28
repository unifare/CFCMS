/**
 * Screen: SEO — title template, meta description, robots and the endpoints
 * they drive.
 */
import { api, scoped } from "../state.js";
import { pageHead } from "../shell.js";
import { icon } from "../../icons.js";
import { attr, esc, toast } from "../../ui.js";

export default async function seo(c) {
  const d = await api(scoped("settings"));
  const v = Object.fromEntries((d.items || []).map((x) => [x.key, x.value]));
  c.innerHTML = `${pageHead({
    title: "SEO",
    sub: "Titles, descriptions and crawl directives for this site",
    actions: `<button class="btn primary" data-action="save-seo">${icon("save")}Save</button>`,
    crumbs: [{ label: "Tools" }, { label: "SEO" }],
  })}
  <div class="grid2">
    <div class="panel">
      <div class="field"><label for="st">Title template</label><input id="st" value="${attr(v["seo.titleTemplate"] || "%title% | %site%")}"><span class="hint">%title% and %site% are replaced at render time</span></div>
      <div class="field"><label for="sd">Meta description</label><textarea id="sd">${esc(v["seo.description"] || "")}</textarea></div>
      <div class="field" style="margin-bottom:0"><label for="sr">Robots</label><input id="sr" value="${attr(v["seo.robots"] || "index,follow")}"><span class="hint">e.g. index,follow or noindex,nofollow</span></div>
    </div>
    <div class="panel">
      <div class="card-title">Generated endpoints</div>
      <div class="list-row"><div class="title">Sitemap</div><a class="btn outline sm" href="/sitemap.xml" target="_blank" rel="noopener">${icon("external")}/sitemap.xml</a></div>
      <div class="list-row"><div class="title">Robots</div><a class="btn outline sm" href="/robots.txt" target="_blank" rel="noopener">${icon("external")}/robots.txt</a></div>
      <div class="list-row"><div class="title">hreflang</div><span class="muted text-sm">Emitted on frontend pages</span></div>
    </div>
  </div>`;
}

document.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-action]");
  if (a?.dataset.action !== "save-seo") return;
  for (const [key, id] of [["seo.titleTemplate", "st"], ["seo.description", "sd"], ["seo.robots", "sr"]]) {
    await api(scoped("settings"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, value: document.querySelector("#" + id).value }) });
  }
  toast("SEO saved");
});
