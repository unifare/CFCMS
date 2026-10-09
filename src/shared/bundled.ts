/**
 * Themes that ship with the product itself.
 *
 * These are the themes a fresh install renders out of the box. Their files are
 * NOT stored in R2: they live in `content/themes/` in the repo and reach the
 * Worker through the assets pipeline (`scripts/sync-bundled-themes.mjs` copies
 * them into `public/themes/` before deploy; `wrangler dev` serves the same
 * directory straight from disk). Template loading falls back to `env.ASSETS`
 * whenever R2 misses, so a wiped database or a fresh deploy always renders —
 * the operator never has to re-upload a bundled theme by hand.
 *
 * Kept as an explicit list rather than discovered at runtime because a Worker
 * cannot list an assets directory. `tests/suites/architecture.test.mjs` pins
 * every entry to a real `content/themes/<name>/theme.json` on disk, so a
 * renamed or removed theme cannot leave a dangling entry here.
 *
 * Consequences, all deliberate:
 * - `uploadExtension` refuses these names: the repo copy is the authority, and
 *   an uploaded override would be silently shadowed by the assets copy.
 * - `uninstallTheme` refuses these names for the same reason.
 * - `seedBundledExtensions` reads each theme's real `theme.json` from assets
 *   and upserts it into `theme_installs`, so the registry row always matches
 *   what actually renders.
 */
import { Env } from "./types";

export const BUNDLED_THEMES: readonly string[] = ["default", "journal"];

/**
 * Read one file of a bundled theme from the worker assets.
 *
 * This lives in `shared/` — not in `extensions/theme/` — because the seeding
 * path (`extensions/plugin/runtime.ts`) needs it too, and plugin code may not
 * import theme code. The assets layout for themes is defined exactly here:
 * `public/themes/<name>/<path>` maps to `content/themes/<name>/<path>`.
 *
 * Returns null when the file is absent, including when `env.ASSETS` is
 * unavailable — that keeps a unit harness without the binding on the old
 * R2-only behaviour instead of throwing.
 */
export async function bundledThemeFile(env: Env, themeName: string, path: string): Promise<string | null> {
  try {
    const res = await env.ASSETS.fetch(`https://bundled.local/themes/${themeName}/${path}`);
    if (res.ok) return await res.text();
  } catch {
    // No ASSETS binding in this environment; R2 was the only source anyway.
  }
  return null;
}
