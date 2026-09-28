import {Env} from "../types";
import {siteInfo,locales} from "./frontend";
export async function sitemap(env:Env,request:Request){
 const url=new URL(request.url),ls=await locales(env),rows=await env.DB.prepare(`SELECT p.type,p.slug,t.locale,p.updated_at FROM posts p JOIN post_translations t ON t.post_id=p.id WHERE p.status='published' LIMIT 5000`).all();
 const out:string[]=(ls as any[]).map(l=>`<url><loc>${url.origin}/${l.code}</loc></url>`);
 for(const r of rows.results as any[])out.push(`<url><loc>${url.origin}/${r.locale}/${r.type==="post"?"blog/":""}${r.slug}</loc><lastmod>${new Date(r.updated_at*1000).toISOString()}</lastmod></url>`);
 return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${out.join("")}</urlset>`,{headers:{"Content-Type":"application/xml;charset=UTF-8"}})
}
export async function robots(env:Env,request:Request){const u=new URL(request.url),s=await siteInfo(env);return new Response(`User-agent: *\nAllow: /\nDisallow: /admin/\nDisallow: /api/\nSitemap: ${u.origin}/sitemap.xml\n`,{headers:{"Content-Type":"text/plain;charset=UTF-8"}})}
