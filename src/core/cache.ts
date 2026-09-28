import { Env } from "../types";
import { now } from "./repo";
import { randomId } from "./crypto";

/**
 * Content-cache versioning, per site.
 *
 * The version is a monotonically increasing integer; bumping it invalidates
 * every cached HTML key for that site at once (keys embed the version). Sites
 * are isolated: publishing on `shop` must not drop `default`'s cache.
 */
function versionKvKey(siteId: string) {
  return `cfpress:content-version:${siteId}`;
}
function versionRowId(siteId: string) {
  return `content_version_${siteId}`;
}

export async function bumpContentCache(env: Env, siteId = "default") {
  const id = versionRowId(siteId);
  const row = await env.DB.prepare("SELECT version FROM content_cache_versions WHERE id=?")
    .bind(id)
    .first<any>();
  const version = Number(row?.version || 1) + 1;
  await env.DB.prepare(
    "INSERT INTO content_cache_versions(id,version,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,updated_at=excluded.updated_at"
  )
    .bind(id, version, now())
    .run();
  await env.CACHE.put(versionKvKey(siteId), String(version), { expirationTtl: 86400 });
  return version;
}

export async function cacheVersion(env: Env, siteId = "default") {
  const v = await env.CACHE.get(versionKvKey(siteId));
  if (v) return v;
  const row = await env.DB.prepare("SELECT version FROM content_cache_versions WHERE id=?")
    .bind(versionRowId(siteId))
    .first<any>();
  const version = String(row?.version || 1);
  await env.CACHE.put(versionKvKey(siteId), version, { expirationTtl: 86400 });
  return version;
}

export async function cacheKey(env: Env, path: string, siteId = "default") {
  return `cfpress:html:${siteId}:${await cacheVersion(env, siteId)}:${path}`;
}

export async function purgePath(env: Env, path: string, siteId = "default") {
  await env.CACHE.delete(`cfpress:html:${siteId}:${await cacheVersion(env, siteId)}:${path}`);
  return randomId();
}

/**
 * Drop every cached HTML page for a site by bumping its version. Cheaper and
 * race-free compared to enumerating keys.
 */
export async function purgeSite(env: Env, siteId = "default") {
  return bumpContentCache(env, siteId);
}
