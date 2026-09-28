import { Env } from "../types";
import { now } from "./repo";
import { bumpContentCache } from "./cache";

/**
 * Publish every post whose scheduled time has passed. Only the sites that
 * actually had something published get their cache version bumped, so a busy
 * multi-site install does not invalidate unrelated sites every minute.
 */
export async function processScheduled(env: Env) {
  const due = await env.DB.prepare(
    "SELECT post_id FROM scheduled_posts WHERE processed_at IS NULL AND publish_at<=? LIMIT 50"
  )
    .bind(now())
    .all();

  const touchedSites = new Set<string>();
  let count = 0;
  for (const row of due.results as any[]) {
    const post = await env.DB.prepare("SELECT site_id FROM posts WHERE id=?")
      .bind(row.post_id)
      .first<any>();
    await env.DB.prepare("UPDATE posts SET status='published',updated_at=? WHERE id=?")
      .bind(now(), row.post_id)
      .run();
    await env.DB.prepare("UPDATE scheduled_posts SET processed_at=? WHERE post_id=?")
      .bind(now(), row.post_id)
      .run();
    if (post?.site_id) touchedSites.add(String(post.site_id));
    count++;
  }
  for (const siteId of touchedSites) await bumpContentCache(env, siteId);
  // Legacy rows written before multi-site may have no site_id.
  if (count && touchedSites.size === 0) await bumpContentCache(env);
  return count;
}
