/**
 * sync-bundled-themes.mjs — copy `content/themes/*` into `public/themes/*`.
 *
 * WHY THIS EXISTS (the "no patching" decision, 2026-10):
 *
 * Bundled themes (see `src/shared/bundled.ts`, `BUNDLED_THEMES`) are shipped
 * with the product and read at runtime through the Worker's ASSETS binding —
 * the same pipeline that serves `public/admin/`. `wrangler deploy` uploads
 * everything under `public/` automatically, so a database wipe followed by a
 * plain `wrangler deploy` (or migrations + deploy) renders the homepage with
 * no manual "upload 13 R2 objects one by one" step. R2 is left for themes the
 * user uploads and builds themselves.
 *
 * The assets root is `public/`, but theme sources live in `content/themes/`
 * (content = things that get LOADED; src = code). Those two trees must agree
 * byte for byte, and the agreement is produced here, mechanically, before
 * every deploy (`predeploy` in package.json) and before dev serves them.
 * The architecture test pins the mapping in both directions, so drift — a
 * template edited in `content/` but never synced, or a stale file left in
 * `public/` — fails the suite instead of quietly serving old markup.
 *
 * `public/themes` is therefore COMMITTED: CI and other machines get a correct
 * checkout without running this script first, and any hand edit is visible as
 * a normal diff.
 */
import { cpSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./_scaffold.mjs";

export const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "content", "themes");
export const TARGET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public", "themes");

/**
 * Walk a directory and return every file path relative to `root`, sorted.
 * Directories without a single file yield nothing (an empty theme dir is not
 * an error here — the architecture test is the one that demands a theme.json).
 */
export function listThemeFiles(root) {
  if (!existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else out.push(relative(root, abs).split("\\").join("/"));
    }
  };
  walk(root);
  return out;
}

/**
 * Pure decision half of the sync: given the source root, target root and the
 * file list (as source-relative paths), return the planned copies. Unsafe
 * paths — absolute, escaping the root, containing `..` — throw, because a
 * path like that here would mean we are about to write outside `public/`.
 *
 * Kept side-effect free (no fs, no process) so a test can import it and pin
 * the plan without touching the disk, the same reason the generators keep
 * their content builders pure (`scripts/_scaffold.mjs` header).
 */
export function copyPlan(sourceRoot, targetRoot, relPaths) {
  const plan = [];
  for (const rel of relPaths) {
    if (typeof rel !== "string" || rel.length === 0) {
      throw new Error(`unsafe theme file path: ${JSON.stringify(rel)}`);
    }
    const norm = rel.split("\\").join("/");
    if (norm.startsWith("/") || /^[A-Za-z]:/.test(norm)) {
      throw new Error(`unsafe theme file path (absolute): ${norm}`);
    }
    const parts = norm.split("/");
    if (parts.some((p) => p === ".." || p.length === 0)) {
      throw new Error(`unsafe theme file path (escapes source root): ${norm}`);
    }
    plan.push({ from: join(sourceRoot, ...parts), to: join(targetRoot, ...parts), rel: norm });
  }
  return plan;
}

/**
 * One full sync: wipe `public/themes`, copy `content/themes` over, return what
 * happened. Wipe-then-copy (rather than diffing) keeps the invariant trivially
 * true — no stale file can survive from a deleted template — and the tree is
 * small (a handful of themes), so the cost is negligible next to a deploy.
 */
export function syncBundledThemes(sourceRoot = SOURCE_ROOT, targetRoot = TARGET_ROOT) {
  if (!existsSync(sourceRoot)) {
    throw new Error(`bundled theme source missing: ${sourceRoot} (expected content/themes/)`);
  }
  const files = listThemeFiles(sourceRoot);
  if (files.length === 0) {
    throw new Error(`no theme files found under ${sourceRoot} — refusing to wipe ${targetRoot} for nothing`);
  }
  const plan = copyPlan(sourceRoot, targetRoot, files);
  rmSync(targetRoot, { recursive: true, force: true });
  for (const { from, to, rel } of plan) {
    cpSync(from, to);
  }
  return { count: plan.length, files: plan.map((p) => p.rel) };
}

function main() {
  const { count } = syncBundledThemes();
  console.log(`sync-bundled-themes: ${count} file(s) content/themes -> public/themes (assets pipeline)`);
}

if (isMain(import.meta.url)) main();
