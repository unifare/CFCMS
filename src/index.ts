import{Env}from "./shared/types";import{handleApi}from "./api";import{findContent,latestPosts,siteInfo,locales,defaultLocale}from "./platform/frontend";import{robots,sitemap}from "./platform/seo";import{seedBundledExtensions,bootPluginRuntime,doAction,applyFilters,renderShortcodes}from "./extensions/plugin/runtime";import{setPluginTableSync}from "./extensions/plugin/menus";import{syncOwnerTables}from "./extensions/theme/tables";import{setHostHooks}from "./extensions/contract/hooks";import{renderThemePage,runThemeQuery,activeTheme,type ThemeRenderOptions}from "./extensions/theme/runtime-declarative";import{tryRenderWithThemeWorker,handleThemeApi}from "./extensions/theme/runtime-worker";import{processScheduled}from "./shared/scheduler";import{resolveSite,siteListMemo,listSites}from "./platform/sites";import{listRoutes,findPostTypeBySlug,listPostTypes}from "./extensions/theme/capabilities";
import{resolveLocale,langFromUrl,langFromCookie,langCookie}from "./platform/i18n/resolve";import{setPackProviders}from "./platform/i18n/packs";import{themePackProvider}from "./extensions/theme/packs";import{pluginPackProvider}from "./extensions/plugin/packs";
// A theme-owned table is read through the same facade the admin screens use.
// `resolveTableForSite` lives there precisely so that this route and the
// generated admin list cannot disagree about which physical table a logical
// name means — see the comment on it in `table-facade.ts`.
import{resolveTableForSite,tableBySlug,tableById,tableList}from "./extensions/theme/table-facade";

let booted=false;

/**
 * Render a page, preferring the theme's own Worker when it ships one.
 *
 * A worker-runtime theme gets first crack at every front-end page; anything it
 * cannot or should not handle (no LOADER binding, module failed to boot, 5xx,
 * thrown exception) silently falls through to the declarative renderer, so a
 * broken theme never takes the site down.
 */
async function renderPage(env:Env,o:ThemeRenderOptions,request:Request){
  const theme=await activeTheme(env,o.siteId);
  const viaWorker=await tryRenderWithThemeWorker(env,theme,{
    request,
    kind:String(o.kind),
    siteId:o.siteId,
    scope:{title:o.title,description:o.description,path:o.path,locale:o.locale,postType:o.postType,slug:o.slug,extra:o.extra},
  }).catch(()=>null);
  if(viaWorker)return{html:viaWorker.html,template:`worker:${theme.name}`,tried:[] as string[],status:viaWorker.status};
  const r=await renderThemePage(env,o);
  return{html:r.html,template:r.template,tried:r.tried,status:200,error:r.error};
}

async function media(env:Env,u:URL){
  const key=decodeURIComponent(u.pathname.slice(7)),o=await env.MEDIA.get(key);
  if(!o)return new Response("Not found",{status:404});
  const h=new Headers();o.writeHttpMetadata(h);h.set("ETag",o.httpEtag);
  return new Response(o.body,{headers:h});
}

function htmlResponse(html:string,template:string,status:number,siteId:string,setCookie?:string|null){
  const h:Record<string,string>={"Content-Type":"text/html;charset=UTF-8","Cache-Control":"public,max-age=60","X-CFPress-Template":template,"X-CFPress-Site":siteId};
  if(setCookie)h["Set-Cookie"]=setCookie;
  return new Response(html,{status,headers:h});
}

/** Match a theme-declared route against a path. `:param` captures a segment. */
function matchRoute(routePath:string,path:string):{params:Record<string,string>}|null{
  if(routePath===path)return{params:{}};
  const rp=routePath.split("/").filter(Boolean),pp=path.split("/").filter(Boolean);
  if(rp.length!==pp.length)return null;
  const params:Record<string,string>={};
  for(let i=0;i<rp.length;i++){
    const seg=rp[i];
    if(seg.startsWith(":")){
      const name=seg.slice(1);
      if(!pp[i])return null;
      params[name]=decodeURIComponent(pp[i]);
    }else if(seg!==pp[i])return null;
  }
  return{params};
}

/**
 * Front-end router.
 *
 * URL shape (after site resolution, one or many sites per install):
 *   /{locale}                  -> theme route for "/" if declared, else home
 *                                 (front-page | home | index)
 *   /{locale}/blog/{slug}      -> single post
 *   /{locale}/{type}/{slug}    -> single of a theme-declared post type
 *   /{locale}/{slug}           -> static page (page-{slug} | page | single | index)
 *   theme route match          -> theme-declared route
 *   anything unmatched         -> 404 template
 *
 * Everything renders through the theme runtime so templates resolve against
 * the WordPress-style hierarchy in `template-resolver.ts`.
 */
export default{async fetch(request:Request,env:Env,ctx:ExecutionContext){
 if(!booted){booted=true;ctx.waitUntil(seedBundledExtensions(env))}
 // Join the two halves of the extension layer.
 //
 // `index.ts` is the only module allowed to import both `theme/` and
 // `plugin/`; the theme layer depends on the `HostHooks` *interface* in
 // `extensions/contract/hooks.ts` and never on the plugin implementation. This
 // is the single place the two are connected, which is what keeps a theme and
 // a plugin independently installable.
 setHostHooks({
   doAction:(name,c,data)=>doAction(name,c,data),
   applyFilters:(name,c,data)=>applyFilters(name,c,data),
   renderShortcodes:(env2,html,siteId)=>renderShortcodes(env2,html,siteId),
   boot:(env2)=>bootPluginRuntime(env2),
 });
 // Same dependency-inversion trick for the UI dictionary. `platform/i18n`
 // owns the *stack* (core → plugin → theme → DB override) but may not import
 // `extensions/` to fetch layers ② and ③, so the two providers are handed over
 // here — the one module allowed to know every layer. Without them the stack is
 // core + overrides, which reads exactly like "nothing is translating".
 setPackProviders({ theme: themePackProvider, plugin: pluginPackProvider });
 // Third application of the same trick: a plugin *declares* `tables[]`, but the
 // DDL generator lives in `theme/tables.ts` and rule 3 forbids `plugin/` from
 // importing `theme/`. So the plugin layer exposes the hook and this module —
 // the only one allowed to know both — supplies the implementation. It fans out
 // over the active sites because a plugin's tables are per site (the registry
 // is keyed by `site_id`), unlike its menus which are install-wide.
 setPluginTableSync(async(env2,pluginName,manifest)=>{
   let total=0;
   for(const site of await listSites(env2)){
     total+=(await syncOwnerTables(env2,"plugin",pluginName,manifest,site.id)).length;
   }
   return total;
 });
 const u=new URL(request.url);
 if(u.pathname.startsWith("/api/"))return handleApi(env,request);
 // Sandboxed theme Workers read data exclusively through this endpoint.
 if(u.pathname.startsWith("/__cfpress/theme-api/"))return handleThemeApi(env,request);
 if(u.pathname.startsWith("/media/"))return media(env,u);
 // The admin SPA and any other static asset belong to the asset layer. This is
 // stated explicitly rather than left to the locale parser, which previously
 // doubled as the asset bail-out — so that removing the locale prefix from the
 // front-end router did not also take `/admin/` down with it.
 if(u.pathname==="/admin"||u.pathname.startsWith("/admin/"))return env.ASSETS.fetch(request);
 if(request.method!=="GET")return env.ASSETS.fetch(request);

 // Resolve which site this request belongs to (host or path prefix).
 const sites=await siteListMemo(env);
 const resolved=await resolveSite(env,u,sites);
 const siteId=resolved.siteId;
 const path=resolved.path;

 // SEO endpoints are per-site: they must be routed *after* site resolution,
 // otherwise `/sitemap.xml` on a second site lists the default site's URLs.
 // They are also more specific than the locale-prefix rules below, so they are
 // matched here by exact path, not by parsing a locale segment.
 if(path==="/sitemap.xml")return sitemap(env,request,siteId);
 if(path==="/robots.txt")return robots(env,request,siteId);

 // Front-end paths may or may not carry a locale prefix. `/{locale}/...` is
 // explicit; anything else is resolved against the site's *default* locale.
 //
 // This used to be a bare regex that bailed out to `env.ASSETS.fetch()` for
 // any path without a two-letter first segment. That made the site's own root
 // URL unreachable — `/` and `/about` were silently served by the static
 // asset layer instead of the theme, which read as "the theme does not work".
 // A URL prefix is a routing concern, so it is decided here, not by whether
 // an unrelated asset happens to exist at that path.
 //
 // The priority order (path → `?lang=` → cookie → site default) and the
 // "explicit prefix means 404, everything else may fall through" rule now live
 // in `platform/i18n/resolve.ts`, because they are language policy rather than
 // routing and the admin API needs the same answers.
 const known=await locales(env,siteId) as any[];
 const knownCodes=known.map(l=>String(l?.code??"")).filter(Boolean);
 const match=resolveLocale(path,{
   codes:knownCodes,
   defaultLocale:await defaultLocale(env,siteId),
   queryLang:langFromUrl(u),
   cookieLang:langFromCookie(request),
 });
 const locale=match.locale;
 // Only a *path* prefix counts as explicit. That is the one case where a miss
 // must 404 instead of falling through to another language.
 const hasLocale=match.explicit;
 const rest=match.rest;
 // Remember an explicit `?lang=` choice so the next request does not need it.
 // A path prefix is already self-describing and gets no cookie.
 const langSetCookie=match.source==="query"?langCookie(locale,365):null;
 const respond=(html:string,template:string,status:number)=>htmlResponse(html,template,status,siteId,langSetCookie);
 const site=await siteInfo(env,siteId);
 // Attach plugin hooks once per isolate. The `beforeRender` action itself is
 // fired from `buildScope`, which has the fully-built render scope in hand.
 ctx.waitUntil(bootPluginRuntime(env).catch(()=>[]));

 // Home
 // Sits AFTER the theme-route loop, not before it: a theme may declare
 // `path: "/"` and take over the front page (a shop whose home page IS the
 // shop). When no theme claims the root, `matchRoute("","")` never fires and
 // this fallback runs exactly as it always did — latest posts through the
 // home/index template hierarchy.
 const home=async()=>{
   const ps=await latestPosts(env,locale,siteId) as any[];
   const r=await renderPage(env,{
     siteId,locale,path:u.pathname,kind:"home",title:site.title,description:site.description,
     extra:{posts:ps.map((p:any)=>({slug:p.slug,title:p.title,excerpt:p.excerpt,url:`/${locale}/blog/${p.slug}`}))}
   },request);
   return respond(r.html,r.template,r.status);
 };

 // Theme-declared routes take priority over the built-in fallbacks so a theme
 // can own its own URL space (e.g. /properties/:slug).
 const routes=await listRoutes(env,siteId);
 for(const route of routes){
   const rp=String(route.path||"").replace(/^\//,"");
   const rt=matchRoute(rp,rest);
   if(!rt)continue;
   let query:Record<string,unknown>={};
   try{query=JSON.parse(String(route.query_json||"{}"))}catch{/* ignore */}

  // A route may resolve one object (by slug/id) or list many — from either the
  // post store or a theme-owned table.
  let post:any=null,kind:"single"|"archive"="archive",postType:string|undefined;
  let rows:any[]=[];
  // "This URL addressed one specific object" is tracked separately from `post`.
  // The two used to be conflated: `kind` only became "single" *after* a row had
  // been found, so the `!post && kind==="single"` guard that used to sit below
  // could never fire and `/products/no-such-slug` answered with the archive
  // listing and HTTP 200. A miss and a listing are different answers, and only
  // the router is in a position to tell them apart.
  let wantSingle=false;
  const resolve=route.resolve_json?(()=>{try{return JSON.parse(String(route.resolve_json))}catch{return null}})():null;
  const capture=rt.params.slug||rt.params.id||Object.values(rt.params)[0];

  // A route may resolve rows of a theme-owned table instead of posts (§3.4).
  //
  // This is what makes a declared table reachable on the front end. The table
  // is looked up by its *logical* name through the same facade the generated
  // admin screens use, so the shop front and the admin list can never disagree
  // about which physical table "product" means — two copies of that resolution
  // is exactly how the two views would drift apart.
  const resolveTable=resolve?.table?String(resolve.table):"";
  if(resolveTable){
    const def=await resolveTableForSite(env,siteId,resolveTable);
    // A capture means the URL named one row, so a miss is a 404 — whether or
    // not the table itself could be found.
    if(capture)wantSingle=true;
    if(def&&capture){
      post=resolve.by==="id"
        ?await tableById(env,def,String(capture),locale)
        :await tableBySlug(env,def,String(capture),locale);
      if(post)kind="single";
    }
    if(def&&!post)rows=await tableList(env,def,{locale,limit:Number(query.limit??50)||50});
  }

  if(resolve&&resolve.type){
    postType=String(resolve.type);
    const by=resolve.by==="id"?"id":"slug";
    if(capture){
      wantSingle=true;
      post=await env.DB.prepare(
        `SELECT p.*,t.locale,t.title,t.excerpt,t.content FROM posts p JOIN post_translations t ON t.post_id=p.id
         WHERE p.site_id=? AND p.type=? AND p.${by==="id"?"id":"slug"}=? AND t.locale=? AND p.status='published' LIMIT 1`
      ).bind(siteId,postType,capture,locale).first<any>();
      if(post)kind="single";
    }
    // No capture for this route -> it is a listing even if it declares a type.
  }

  // A route that named one object and found nothing renders the 404 template.
  // Doing it here rather than after the render avoids building a whole archive
  // page only to discard it and answer 404 with a listing in the body.
  if(wantSingle&&!post){
    const miss=await renderPage(env,{siteId,locale,path:u.pathname,kind:"404",title:"Not Found"},request);
    return respond(miss.html,miss.template,404);
  }

  // Without an explicit resolver, infer the type from the route's first segment.
  if(!postType){
    const pt=await findPostTypeBySlug(env,String(rp.split("/")[0]),siteId);
    if(pt)postType=pt.name;
  }

  // Run the route's declarative query to populate the listing variable. A table
  // route already filled `rows` from its own table; running the post query on
  // top would replace them with an empty list.
  if(kind==="archive"&&!resolveTable){
    const q:Record<string,string|number>={...query,locale:String(query.locale??locale)};
    // `as` names the binding, it is not a query parameter.
    delete q.as;
    if(postType&&!q.type)q.type=postType;
    rows=await runThemeQuery(env,q,{locale,post} as Record<string,unknown>,siteId);
  }

  // Which scope variable the listing lands in.
  //
  // `query.as` is the route-level spelling of the `as` attribute on
  // `{{@query ... as="x"}}` — one concept, one name, so a theme author learns it
  // once. The default `posts` is what every existing theme template iterates.
  // Before this existed the binding was hard-coded, so a template written for a
  // `property` listing (`{{#each properties}}`) silently rendered its `{{else}}`
  // empty branch with HTTP 200 — the shape of failure this whole area produces.
  const listVar=String(query.as??"posts")||"posts";

  // Item links are built from the route's own path, never from a hard-coded
  // `/blog/`. A route exists precisely because the theme owns that URL space,
  // so linking every row to `/blog/<slug>` sent each visitor of `/writing` or
  // `/products` to a 404. Static segments are kept; captures are not.
  const routeBase="/"+rp.split("/").filter(s=>s&&!s.startsWith(":")).join("/");
  const itemUrl=(slug:string)=>`/${locale}${routeBase==="/"?"":routeBase}/${slug}`;

  const r=await renderPage(env,{
    siteId,locale,path:u.pathname,kind,postType,slug:rt.params.slug,
    // The template the route named outranks the hierarchy. Without this a table
    // route has no post type to derive a name from and can only reach the
    // generic `archive`/`single`.
    template:String(route.template||"")||undefined,
    // Title precedence: the resolved object, then the title the theme gave the
    // route, then the template name. Never fall back to the raw query `type` —
    // that is an internal slug ("post"), and leaking it heads the page "post".
    title:post?.title||String(route.title||route.template||"Archive"),
    description:post?.excerpt||undefined,post:post??undefined,
    extra:{
      route:{path:route.path,params:rt.params,query},
      [listVar]:rows.map(p=>({...p,url:itemUrl(String(p.slug??""))})),
    }
  },request);
  return respond(r.html,r.template,r.status);
 }

 // A theme that declared `path: "/"` already answered above; everything else
 // falls back to the built-in home.
 if(!rest)return home();

 // Built-in post permalink
 if(rest.startsWith("blog/")){
   const slug=rest.slice(5);
   const x=await findContent(env,"post",slug,locale,siteId);
   if(x){
     const r=await renderPage(env,{siteId,locale,path:u.pathname,kind:"single",postType:"post",slug,title:x.title,description:x.excerpt,post:x},request);
     return respond(r.html,r.template,r.status);
   }
 }

 // Theme-declared custom post types: /{locale}/{rewrite-slug}            -> archive
 //                                /{locale}/{rewrite-slug}/{slug}       -> single
 const segs=rest.split("/").filter(Boolean);
 const ptSlug=segs[0]??"";
 const pt=await findPostTypeBySlug(env,ptSlug,siteId);
 if(pt){
   const ptBase=pt.rewrite_slug??pt.name;

   // Single object.
   if(segs.length===2){
     const x=await findContent(env,pt.name,segs[1],locale,siteId);
     if(x){
       const r=await renderPage(env,{siteId,locale,path:u.pathname,kind:"single",postType:pt.name,slug:segs[1],title:x.title,description:x.excerpt,post:x},request);
       return respond(r.html,r.template,r.status);
     }
     // Nested path that is not this CPT -> fall through to pages below.
   }

   // Archive listing (has_archive).
   if(segs.length===1&&pt.has_archive){
     const rows=await runThemeQuery(env,{type:pt.name,limit:50},{locale} as Record<string,unknown>,siteId);
     const r=await renderPage(env,{
       siteId,locale,path:u.pathname,kind:"archive",postType:pt.name,
       title:String(pt.plural_label||pt.label||pt.name),
       extra:{posts:(rows as any[]).map(p=>({...p,url:`/${locale}/${ptBase}/${p.slug}`}))}
     },request);
     return respond(r.html,r.template,r.status);
   }
 }

 // Static page
 const page=await findContent(env,"page",rest,locale,siteId);
 if(page){
   const r=await renderPage(env,{siteId,locale,path:u.pathname,kind:"page",postType:"page",slug:rest,title:page.title,description:page.excerpt,post:page},request);
   return respond(r.html,r.template,r.status);
 }

 // Unprefixed path that missed in the default locale: try the site's other
 // locales rather than 404. `/about` should open the About page whether it was
 // authored in `en` or only in `de` — the visitor never asked to be pinned to
 // one language, so falling through is strictly better than a dead end. An
 // *explicitly* prefixed path (`/de/about`) does not get this treatment, since
 // there the reader has stated which language they want.
 if(!hasLocale&&knownCodes.length>1){
   for(const code of knownCodes){
     if(code===locale)continue;
     const alt=await findContent(env,"page",rest,code,siteId);
     if(alt){
       const r=await renderPage(env,{siteId,locale:code,path:u.pathname,kind:"page",postType:"page",slug:rest,title:alt.title,description:alt.excerpt,post:alt},request);
       return respond(r.html,r.template,r.status);
     }
   }
 }

 const r=await renderPage(env,{siteId,locale,path:u.pathname,kind:"404",title:"Not Found"},request);
 return respond(r.html,r.template,r.status===200?404:r.status);
},async scheduled(_event:ScheduledController,env:Env,_ctx:ExecutionContext){await processScheduled(env)}};

export{listPostTypes};
