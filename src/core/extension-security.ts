export const CAPABILITIES = [
  "content.read", "content.write", "settings.read", "settings.write",
  "media.read", "media.write", "routes.register", "admin.register"
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export function validExtensionName(name:string){return /^[a-z0-9][a-z0-9-_]{1,63}$/.test(name)}
export function validVersion(v:string){return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v)}
export function safeZipPath(path:string){
  return !!path && path.length<=240 && !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes("..") && !path.includes("\0")
}

const IDENT_RE = /^[a-z][a-z0-9_-]{0,63}$/i;
const FIELD_KEY_RE = /^[a-z0-9_][a-z0-9_-]{0,63}$/i;
/**
 * Template names are not identifiers: WordPress-style names may be numeric
 * (`404`), nested with a slash (`parts/card`) and contain dots (`single-post.v2`).
 * Reject only the things that would let a name escape the R2 prefix.
 */
function validTemplateName(name: unknown): boolean {
  if (typeof name !== "string" || !name || name.length > 120) return false;
  if (name.startsWith("/") || name.includes("..") || name.includes("\\") || name.includes("\0")) return false;
  return /^[a-z0-9][a-z0-9._/-]*$/i.test(name);
}
const ALLOWED_FIELD_TYPES = [
  "text","textarea","number","boolean","select","date","datetime",
  "media","media-multiple","color","url","email","richtext"
];
const ALLOWED_ADMIN_SCREENS = [
  "dashboard","content-list","content-edit","settings","media","custom","theme-settings"
];

// Intentionally `any[]`: manifest blocks are validated field by field below,
// and the strict object type would make every property probe an error.
function asArray(v:unknown):any[]{return Array.isArray(v)?v:[]}
function fail(msg:string):never{throw new Error(msg)}

/**
 * Validate an extension manifest. Themes carry a much larger declaration
 * surface than plugins (post types, taxonomies, fields, routes, menus, blocks),
 * so each block is checked and normalised here rather than failing later at
 * activation time with a vague error.
 */
export function validateManifest(manifest:any,type:"plugin"|"theme"){
  if(!manifest || typeof manifest!=="object") fail("Invalid manifest")
  if(!validExtensionName(String(manifest.name||""))) fail("Invalid extension name")
  if(!validVersion(String(manifest.version||""))) fail("Invalid extension version")
  if(type==="plugin" && manifest.permissions && !Array.isArray(manifest.permissions)) fail("permissions must be an array")
  if(type==="theme" && manifest.supports && !Array.isArray(manifest.supports)) fail("supports must be an array")
  const perms=asArray(manifest.permissions)
  for(const p of perms) if(!CAPABILITIES.includes(p as Capability)) fail(`Unsupported capability: ${p}`)

  if(type==="theme") validateThemeManifest(manifest)

  return {name:String(manifest.name),title:String(manifest.title||manifest.name),version:String(manifest.version),manifest}
}

function validateThemeManifest(m:any){
  // `templates` / `parts` are now actually honoured by the resolver, so reject
  // nonsense names instead of silently ignoring them as the old code did.
  for(const key of ["templates","parts"] as const){
    if(m[key]===undefined) continue;
    for(const t of asArray(m[key])){
      if(!validTemplateName(t)) fail(`Invalid ${key} entry: ${t}`)
    }
  }

  for(const pt of asArray(m.postTypes)){
    if(!pt||typeof pt!=="object") fail("postTypes entries must be objects")
    if(!IDENT_RE.test(String(pt.name||""))) fail(`Invalid post type name: ${pt?.name}`)
    if(pt.supports!==undefined&&!Array.isArray(pt.supports)) fail(`postType ${pt.name}: supports must be an array`)
  }

  for(const tax of asArray(m.taxonomies)){
    if(!tax||typeof tax!=="object") fail("taxonomies entries must be objects")
    if(!IDENT_RE.test(String(tax.name||""))) fail(`Invalid taxonomy name: ${tax?.name}`)
    if(tax.postTypes!==undefined&&!Array.isArray(tax.postTypes)) fail(`taxonomy ${tax.name}: postTypes must be an array`)
  }

  for(const f of asArray(m.fields)){
    if(!f||typeof f!=="object") fail("fields entries must be objects")
    if(!FIELD_KEY_RE.test(String(f.key||""))) fail(`Invalid field key: ${f?.key}`)
    const ft=String(f.type||"text")
    if(!ALLOWED_FIELD_TYPES.includes(ft)) fail(`Unsupported field type "${ft}" for key ${f.key}`)
    if(f.postTypes!==undefined&&!Array.isArray(f.postTypes)) fail(`field ${f.key}: postTypes must be an array`)
  }

  const seenPaths=new Set<string>()
  for(const r of asArray(m.routes)){
    if(!r||typeof r!=="object") fail("routes entries must be objects")
    const path=String(r.path||"")
    if(!path||!path.startsWith("/")) fail(`Route path must start with "/": ${path}`)
    if(path.includes("..")) fail(`Route path may not contain "..": ${path}`)
    if(seenPaths.has(path)) fail(`Duplicate route path: ${path}`)
    seenPaths.add(path)
    if(!String(r.template||"")) fail(`Route ${path} must declare a template`)
  }

  for(const menu of asArray(m.adminMenus)){
    if(!menu||typeof menu!=="object") fail("adminMenus entries must be objects")
    if(!String(menu.id||"")) fail("adminMenus entries need an id")
    const screen=String(menu.screen||"")
    if(!ALLOWED_ADMIN_SCREENS.includes(screen)) fail(`Unsupported admin screen "${screen}" for menu ${menu.id}`)
  }

  for(const b of asArray(m.blocks)){
    if(!b||typeof b!=="object") fail("blocks entries must be objects")
    if(!String(b.name||"")) fail("blocks entries need a name")
  }

  for(const s of asArray(m.settings)){
    if(!s||typeof s!=="object") fail("settings entries must be objects")
    if(!String(s.key||"")) fail("settings entries need a key")
  }

  if(m.runtime!==undefined&&!["declarative","worker"].includes(String(m.runtime))){
    fail(`Unsupported runtime: ${m.runtime}`)
  }
}

export async function sha256(data:ArrayBuffer){
  const digest=await crypto.subtle.digest("SHA-256",data);
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
