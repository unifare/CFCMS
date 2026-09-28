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

/**
 * Columns the platform owns on every generated table.
 *
 * A theme declaring one of these would produce a `CREATE TABLE` with two
 * columns of the same name — or worse, silently shadow the platform's
 * `site_id` and break multi-site isolation for that table. There is no
 * legitimate use, so it is rejected rather than de-duplicated.
 */
const RESERVED_COLUMNS = [
  "id","site_id","slug","lang_group","status","created_at","updated_at"
];

/** Table names become identifiers in generated DDL, so keep them boring. */
const TABLE_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;

/**
 * Locale codes accepted in a theme's `locales[]`.
 *
 * Deliberately a *shape* check (BCP-47-ish), not a membership check against
 * the `locales` table: a theme ships its language packs before it is
 * installed, and the platform's enabled-locale set is per site and may change
 * afterwards. What matters here is that the code is well-formed enough to be
 * a filename (`zh-CN.json`) and a URL segment.
 */
const LOCALE_CODE_RE = /^[a-z]{2,3}(?:-[A-Za-z]{2,8})*$/;

/** Field types allowed on a theme-declared table (§9 decision 2: basic only). */
const ALLOWED_TABLE_FIELD_TYPES = ["text","longtext","number","boolean","date","datetime"];

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
    // A menu may gate itself behind a capability the theme also declares.
    // Checking it here means an installed-but-unusable menu is impossible.
    if(menu.capability!==undefined&&!CAPABILITIES.includes(String(menu.capability) as Capability)){
      fail(`adminMenu ${menu.id}: unsupported capability "${menu.capability}"`)
    }
    // `args` must be an object when present; entries are read by screen type.
    if(menu.args!==undefined&&(typeof menu.args!=="object"||menu.args===null||Array.isArray(menu.args))){
      fail(`adminMenu ${menu.id}: args must be an object`)
    }
  }

  // -- Theme-owned tables (§3.2 / §9 decisions 2, 3) ------------------------
  //
  // The table name becomes part of a generated identifier
  // (`theme_{owner}_{name}`), so a bad name is not a style problem — it is
  // unrepresentable DDL. Fields and `translatable` are checked against each
  // other because "translate a field that does not exist" is the most likely
  // mistake and produces a silently-empty translation table.
  const declaredTables=new Set<string>()
  for(const t of asArray(m.tables)){
    if(!t||typeof t!=="object") fail("tables entries must be objects")
    const tname=String(t.name||"")
    if(!TABLE_NAME_RE.test(tname)) fail(`Invalid table name: "${tname}" (expected /^[a-z][a-z0-9_]{1,63}$/)`)
    if(declaredTables.has(tname)) fail(`Duplicate table name: ${tname}`)
    declaredTables.add(tname)

    const fieldKeys=new Set<string>()
    for(const f of asArray(t.fields)){
      if(!f||typeof f!=="object") fail(`table ${tname}: fields entries must be objects`)
      const key=String(f.key||"")
      if(!FIELD_KEY_RE.test(key)) fail(`table ${tname}: invalid field key "${key}"`)
      if(RESERVED_COLUMNS.includes(key)) fail(`table ${tname}: field "${key}" collides with a reserved column`)
      if(fieldKeys.has(key)) fail(`table ${tname}: duplicate field key "${key}"`)
      fieldKeys.add(key)
      const ft=String(f.type||"text")
      if(!ALLOWED_TABLE_FIELD_TYPES.includes(ft)){
        fail(`table ${tname}: unsupported field type "${ft}" for field "${key}" (allowed: ${ALLOWED_TABLE_FIELD_TYPES.join(", ")})`)
      }
      if(f.required!==undefined&&typeof f.required!=="boolean"){
        fail(`table ${tname}.${key}: "required" must be a boolean`)
      }
    }

    for(const k of asArray(t.translatable)){
      if(!fieldKeys.has(String(k))) fail(`table ${tname}: marks "${k}" translatable but declares no such field`)
    }

    // Decision 4 (unified menu registry): a `table-list` / `table-edit` screen
    // must point at a table this theme actually declares.
    const listScreen=String(t.admin?.screen||"")
    if(listScreen&&!ALLOWED_ADMIN_SCREENS.includes(listScreen)){
      fail(`table ${tname}: unsupported admin screen "${listScreen}"`)
    }
  }

  // A route resolving against a table must declare that table. Checked here as
  // well as in the architecture test: the test guards the *shipped* themes,
  // this guards anything installed at runtime, including third-party zips.
  for(const r of asArray(m.routes)){
    const tbl=r?.resolve?.table
    if(tbl&&!declaredTables.has(String(tbl))){
      fail(`route ${r?.path}: resolves table "${tbl}" which is not declared in tables[]`)
    }
  }

  for(const code of asArray(m.locales)){
    if(!LOCALE_CODE_RE.test(String(code))){
      fail(`Invalid locale code: "${code}" (expected BCP-47 shape, e.g. "en", "zh-CN")`)
    }
  }

  for(const b of asArray(m.blocks)){
    if(!b||typeof b!=="object") fail("blocks entries must be objects")
    if(!String(b.name||"")) fail("blocks entries need a name")
    if(!IDENT_RE.test(String(b.name))) fail(`Invalid block name: ${b.name}`)
  }

  for(const s of asArray(m.settings)){
    if(!s||typeof s!=="object") fail("settings entries must be objects")
    const skey=String(s.key||"")
    if(!skey) fail("settings entries need a key")
    // Dotted keys are the convention (`shop.currency`); a bare identifier also
    // works. Anything else breaks the settings lookup, which splits on dots.
    if(!/^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)*$/i.test(skey)) fail(`Invalid setting key: "${skey}"`)
    if(s.type!==undefined&&!ALLOWED_FIELD_TYPES.includes(String(s.type))){
      fail(`setting ${skey}: unsupported type "${s.type}"`)
    }
    if(s.options!==undefined&&!Array.isArray(s.options)) fail(`setting ${skey}: options must be an array`)
    if(s.default!==undefined&&typeof s.default==="object"&&s.default!==null){
      fail(`setting ${skey}: default must be a scalar`)
    }
  }

  if(m.runtime!==undefined&&!["declarative","worker"].includes(String(m.runtime))){
    fail(`Unsupported runtime: ${m.runtime}`)
  }

  // A worker-runtime theme renders from code and declares its entry file. Both
  // halves must agree or activation succeeds and the theme never renders.
  if(String(m.runtime)==="worker"&&!String(m.entry||"")){
    fail('runtime "worker" requires an "entry" file name')
  }
}

export async function sha256(data:ArrayBuffer){
  const digest=await crypto.subtle.digest("SHA-256",data);
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
