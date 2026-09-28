import { Env } from "../shared/types";
import { parseBlocks } from "../rendering/blocks";

export function esc(v:unknown){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!))}
/**
 * Read one `settings` row for a site.
 *
 * `siteId` is required. It used to default to `"default"`, which made a
 * forgotten argument silently read the wrong site's settings — invisible on a
 * single-site install and wrong the moment a second site exists.
 */
export async function setting(env:Env,key:string,fallback:string,siteId:string){const r=await env.DB.prepare("SELECT value FROM settings WHERE site_id=? AND key=?").bind(siteId,key).first<any>();return r?.value??fallback}
export async function locales(env:Env,siteId:string){
  try{
    const r=await env.DB.prepare("SELECT * FROM locales ORDER BY is_default DESC,code").all();
    if(r.results.length)return r.results;
  }catch{/* table absent on very old databases */}
  void siteId;
  return [{code:"en",name:"English",is_default:1}];
}
/**
 * The site's default locale code.
 *
 * Front-end URLs may omit the locale segment (`/about` instead of
 * `/en/about`), and those paths must resolve against *some* locale. The
 * `is_default` flag in the `locales` table is the single source of truth for
 * which one; ordering already puts it first, but we look it up explicitly so
 * the intent survives a future change to the query's ORDER BY.
 */
export async function defaultLocale(env:Env,siteId:string):Promise<string>{
  const all=await locales(env,siteId) as any[];
  const def=all.find(l=>Number(l?.is_default)===1)??all[0];
  return String(def?.code??"en");
}
export async function siteInfo(env:Env,siteId:string){return {title:await setting(env,"site.title","CFPress",siteId),description:await setting(env,"site.description","",siteId),robots:await setting(env,"seo.robots","index,follow",siteId)}}
/**
 * Load one published object by slug (or any column matched by `type`).
 *
 * The stored `content` column is a raw block-JSON string; templates should not
 * have to parse that, so we also expose `html` — the rendered form of the same
 * blocks — mirroring what `@query` results carry. Without this, a template
 * that reads `post.html` on a single-object page silently renders its empty
 * branch while listings work fine, which is a confusing failure mode.
 */
/**
 * Estimate reading time from rendered HTML at a long-form 220 wpm.
 *
 * Done server-side rather than in the theme's runtime because the template
 * language has no arithmetic, and a JS-only estimate shows the reader a
 * placeholder glyph on first paint. Returning a ready-to-print string keeps
 * the template free of both problems.
 */
export function readingTime(html:string, wpm=220){
  const text=String(html).replace(/<[^>]*>/g," ").replace(/&[a-z]+;|&#\d+;/gi," ");
  const words=text.split(/\s+/).filter(Boolean).length;
  return Math.max(1,Math.round(words/wpm))+" min read";
}
export async function findContent(env:Env,type:string,slug:string,locale:string,siteId:string){
  const row=await env.DB.prepare(`SELECT p.*,t.locale,t.title,t.excerpt,t.content FROM posts p JOIN post_translations t ON t.post_id=p.id WHERE p.site_id=? AND p.type=? AND p.slug=? AND t.locale=? AND p.status='published' LIMIT 1`).bind(siteId,type,slug,locale).first<any>();
  if(row){row.html=row.content?renderBlocks(String(row.content)):"";row.reading_time=readingTime(row.html);}
  return row;
}
export async function latestPosts(env:Env,locale:string,siteId:string){const r=await env.DB.prepare(`SELECT p.slug,t.title,t.excerpt FROM posts p JOIN post_translations t ON t.post_id=p.id WHERE p.site_id=? AND p.type='post' AND p.status='published' AND t.locale=? ORDER BY p.created_at DESC LIMIT 10`).bind(siteId,locale).all();return r.results as any[]}
/**
 * Header navigation for a site. Menus are looked up by `site_id` when the
 * schema supports it, falling back to the legacy global lookup so pre-0008
 * installs keep working.
 */
export async function menu(env:Env,locale:string,siteId:string){
  let m:any=null;
  try{
    m=await env.DB.prepare("SELECT id FROM menus WHERE location='header' AND site_id=? LIMIT 1").bind(siteId).first<any>();
  }catch{/* menus has no site_id column */}
  if(!m) m=await env.DB.prepare("SELECT id FROM menus WHERE location='header' LIMIT 1").first<any>();
  if(!m)return[];
  const r=await env.DB.prepare("SELECT * FROM menu_items WHERE menu_id=? AND (locale IS NULL OR locale=?) ORDER BY sort_order,id").bind(m.id,locale).all();
  return r.results as any[];
}
export function renderBlocks(content:string){
 return parseBlocks(content).map((b:any)=>{const a=b.attrs||{};switch(b.type){
 case"core/paragraph":return`<p>${esc(a.text||"")}</p>`;case"core/heading":return`<h2>${esc(a.text||"")}</h2>`;case"core/list":return`<ul>${String(a.text||"").split(/\n/).filter(Boolean).map((x:string)=>`<li>${esc(x)}</li>`).join("")}</ul>`;
 case"core/image":return a.url?`<figure><img src="${esc(a.url)}" alt="${esc(a.alt||"")}" loading="lazy"></figure>`:"";
 case"core/gallery":return`<div class="gallery">${(Array.isArray(a.items)?a.items:[]).map((x:any)=>`<img src="${esc(x.url||"")}" alt="${esc(x.alt||"")}" loading="lazy">`).join("")}</div>`;
 case"core/quote":return`<blockquote>${esc(a.text||"")}</blockquote>`;case"core/code":return`<pre><code>${esc(a.text||"")}</code></pre>`;
 case"core/button":return`<p><a class="wp-button" href="${esc(a.url||"#")}">${esc(a.text||"Button")}</a></p>`;case"core/separator":return`<hr>`;
 case"core/html":return String(a.html||"");case"core/group":return`<div class="wp-group">${(b.content||[]).map((x:any)=>renderBlocks(JSON.stringify([x]))).join("")}</div>`;
 case"core/columns":return`<div class="wp-columns">${(b.content||[]).map((x:any)=>`<div>${renderBlocks(JSON.stringify([x]))}</div>`).join("")}</div>`;default:return"";}}).join("");
}
