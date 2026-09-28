/**
 * The data facade a theme uses to reach its own tables (`host.table(...)`).
 *
 * A theme never sees SQL, never sees a table name, and never sees a `site_id`.
 * It asks for a logical table and gets rows for the current site, with
 * translatable fields already resolved for the locale it asked for.
 *
 * ## The fallback rule, applied in one place
 *
 * Every multi-language read in the system follows "requested locale → the
 * site's default locale → whatever the row holds". This is implemented as two
 * `LEFT JOIN`s on the translation table and a `COALESCE`, not as a second query
 * from the caller: a missing translation is normal, and the cost of getting it
 * wrong is a product page that 500s because nobody translated its name.
 *
 * ## Why the writes are asymmetric
 *
 * When the site serves one language, translatable fields are written to the
 * main table — that is where they live, because no `_i18n` table exists.
 *
 * When it serves several, a translatable field is written to the `_i18n` table
 * for the requested locale, and the main-table column is only updated if the
 * requested locale *is* the site default. The main column is the default
 * language's mirror; letting an English edit overwrite it would silently
 * rewrite the Chinese product name.
 */
import { Env } from "../../shared/types";
import { now } from "../../shared/repo";
import { randomId } from "../../shared/crypto";
import { siteDefaultLocale } from "../../platform/i18n/locale-registry";
import { type ThemeTableDef } from "./tables";

export interface TableRow {
  id: string;
  slug: string;
  site_id: string;
  lang_group: string;
  status: string;
  created_at: number;
  updated_at: number;
  [field: string]: unknown;
}

export interface TableListOptions {
  locale: string;
  limit?: number;
  offset?: number;
  status?: string | null;
  order?: string;
}

/** ORDER BY is a whitelist, never a template interpolation of caller input. */
const ORDER_WHITELIST = new Set(["created_at", "updated_at", "slug", "status"]);

function orderClause(order: string | undefined): string {
  const parts = String(order ?? "created_at desc").trim().split(/\s+/);
  const col = ORDER_WHITELIST.has(parts[0]) ? parts[0] : "created_at";
  const dir = String(parts[1] ?? "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  return `${col} ${dir}`;
}

/** Fields a caller may write: the declared set, plus the platform's own. */
function writableFields(def: ThemeTableDef): Set<string> {
  const out = new Set<string>(["slug", "status"]);
  for (const f of def.fields) out.add(String(f.key));
  return out;
}

/**
 * Build the read projection.
 *
 * Returns the SQL and the bind list rather than running it, so the same
 * projection can be reused by `list`, `bySlug` and `byId` without three copies
 * of the COALESCE ladder drifting apart.
 */
function readProjection(def: ThemeTableDef): { select: string; join: string } {
  const translatable = new Set(def.translatable);
  const hasI18n = !!def.i18n_table && def.translatable.length > 0;

  // Which declared fields are read straight off the main table.
  //
  // Only the *translatable* ones move out of the main-table projection, and
  // only when a translation table exists to hold them. While the site is
  // monolingual they are ordinary main-table columns — that is where a
  // single-language site stores a product name — so excluding them there would
  // drop most of the row.
  const plain = (hasI18n ? def.fields.filter((f) => !translatable.has(String(f.key))) : def.fields)
    .map((f) => `m.${String(f.key)} AS ${String(f.key)}`);
  const base = ["m.id", "m.site_id", "m.slug", "m.lang_group", "m.status", "m.created_at", "m.updated_at", ...plain];

  if (!hasI18n) {
    return { select: base.join(", "), join: `` };
  }
  const i = def.i18n_table as string;
  const overlaid = def.translatable
    .map((k) => `COALESCE(tr.${k}, dflt.${k}, m.${k}) AS ${k}`)
    .join(", ");
  return {
    select: `${base.join(", ")}, ${overlaid}`,
    join: `LEFT JOIN ${i} tr ON tr.row_id = m.id AND tr.locale = ?
           LEFT JOIN ${i} dflt ON dflt.row_id = m.id AND dflt.locale = ?`,
  };
}

async function defaultLocaleFor(env: Env, def: ThemeTableDef): Promise<string> {
  return await siteDefaultLocale(env, def.site_id);
}

export async function tableList(
  env: Env,
  def: ThemeTableDef,
  opts: TableListOptions
): Promise<TableRow[]> {
  const limit = Math.min(200, Math.max(1, Number(opts.limit ?? 50)));
  const offset = Math.max(0, Number(opts.offset ?? 0));
  const proj = readProjection(def);
  const where: string[] = ["m.site_id = ?"];
  const binds: unknown[] = [];
  if (proj.join) {
    binds.push(opts.locale, await defaultLocaleFor(env, def));
  }
  binds.push(def.site_id);
  if (opts.status) {
    where.push("m.status = ?");
    binds.push(String(opts.status));
  }
  binds.push(limit, offset);
  const sql = `SELECT ${proj.select} FROM ${def.table_name} m ${proj.join}
               WHERE ${where.join(" AND ")}
               ORDER BY m.${orderClause(opts.order)} LIMIT ? OFFSET ?`;
  try {
    const r = await env.DB.prepare(sql).bind(...(binds as any[])).all();
    return ((r.results as any[]) ?? []) as TableRow[];
  } catch {
    // The registry says there is a translation table but it is not there (a
    // hand-edited database). Degrade to the single-language read rather than
    // failing the page.
    return await tableListPlain(env, def, opts);
  }
}

async function tableListPlain(
  env: Env,
  def: ThemeTableDef,
  opts: TableListOptions
): Promise<TableRow[]> {
  const limit = Math.min(200, Math.max(1, Number(opts.limit ?? 50)));
  const offset = Math.max(0, Number(opts.offset ?? 0));
  const where: string[] = ["site_id = ?"];
  const binds: unknown[] = [def.site_id];
  if (opts.status) {
    where.push("status = ?");
    binds.push(String(opts.status));
  }
  binds.push(limit, offset);
  try {
    const r = await env.DB.prepare(
      `SELECT * FROM ${def.table_name} WHERE ${where.join(" AND ")}
       ORDER BY ${orderClause(opts.order)} LIMIT ? OFFSET ?`
    )
      .bind(...(binds as any[]))
      .all();
    return ((r.results as any[]) ?? []) as TableRow[];
  } catch {
    return [];
  }
}

export async function tableBySlug(
  env: Env,
  def: ThemeTableDef,
  slug: string,
  locale: string
): Promise<TableRow | null> {
  return await tableOne(env, def, "m.slug = ?", slug, locale);
}

export async function tableById(
  env: Env,
  def: ThemeTableDef,
  id: string,
  locale: string
): Promise<TableRow | null> {
  return await tableOne(env, def, "m.id = ?", id, locale);
}

async function tableOne(
  env: Env,
  def: ThemeTableDef,
  predicate: string,
  value: string,
  locale: string
): Promise<TableRow | null> {
  const proj = readProjection(def);
  const binds: unknown[] = [];
  if (proj.join) binds.push(locale, await defaultLocaleFor(env, def));
  binds.push(def.site_id, value);
  try {
    const r = await env.DB.prepare(
      `SELECT ${proj.select} FROM ${def.table_name} m ${proj.join}
       WHERE m.site_id = ? AND ${predicate} LIMIT 1`
    )
      .bind(...(binds as any[]))
      .first<any>();
    return r ? (r as TableRow) : null;
  } catch {
    try {
      const r = await env.DB.prepare(
        `SELECT * FROM ${def.table_name} WHERE site_id = ? AND ${predicate} LIMIT 1`
      )
        .bind(def.site_id, value)
        .first<any>();
      return r ? (r as TableRow) : null;
    } catch {
      return null;
    }
  }
}

/**
 * Insert or update one row, keyed by `(site_id, slug)`.
 *
 * Unknown keys are dropped rather than rejected: a theme that sends an extra
 * property should not fail the save, but it must not be able to name a column
 * either — that is what keeps a caller's JSON from becoming DDL.
 */
export async function tableSave(
  env: Env,
  def: ThemeTableDef,
  data: Record<string, unknown>,
  locale: string
): Promise<TableRow> {
  const allowed = writableFields(def);
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data ?? {})) {
    if (allowed.has(k)) clean[k] = v;
  }
  const slug = String(clean.slug ?? "").trim();
  if (!slug) throw new Error("slug is required");

  const defaultLocale = await defaultLocaleFor(env, def);
  const multilingual = !!def.i18n_table && def.translatable.length > 0;
  const translatableSet = new Set(def.translatable);

  const existing = await env.DB.prepare(
    `SELECT id FROM ${def.table_name} WHERE site_id=? AND slug=? LIMIT 1`
  )
    .bind(def.site_id, slug)
    .first<any>();

  const ts = now();
  const id = existing?.id ? String(existing.id) : `ttr_${await randomId()}`;

  // -- main table --------------------------------------------------------
  const mainCols: string[] = [];
  const mainVals: unknown[] = [];
  for (const [k, v] of Object.entries(clean)) {
    if (k === "slug") continue;
    if (multilingual && translatableSet.has(k) && locale !== defaultLocale) continue;
    mainCols.push(k);
    mainVals.push(normaliseValue(v));
  }
  if (existing?.id) {
    const sets = mainCols.map((c) => `${c} = ?`);
    sets.push("updated_at = ?");
    await env.DB.prepare(`UPDATE ${def.table_name} SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...(mainVals as any[]), ts, id)
      .run();
  } else {
    const cols = ["id", "site_id", "slug", "lang_group", "created_at", "updated_at", ...mainCols];
    const vals: unknown[] = [id, def.site_id, slug, id, ts, ts, ...mainVals];
    await env.DB.prepare(
      `INSERT INTO ${def.table_name}(${cols.join(", ")}) VALUES(${cols.map(() => "?").join(", ")})`
    )
      .bind(...(vals as any[]))
      .run();
  }

  // -- translation table -------------------------------------------------
  if (multilingual) {
    const trCols: string[] = [];
    const trVals: unknown[] = [];
    for (const [k, v] of Object.entries(clean)) {
      if (!translatableSet.has(k)) continue;
      trCols.push(k);
      trVals.push(v === undefined || v === null ? null : String(v));
    }
    if (trCols.length) {
      const allCols = ["row_id", "locale", ...trCols];
      const allVals: unknown[] = [id, locale, ...trVals];
      await env.DB.prepare(
        `INSERT INTO ${def.i18n_table}(${allCols.join(", ")},created_at,updated_at)
         VALUES(${allCols.map(() => "?").join(", ")},?,?)
         ON CONFLICT(row_id,locale) DO UPDATE SET
           ${trCols.map((c) => `${c} = excluded.${c}`).join(", ")},
           updated_at = excluded.updated_at`
      )
        .bind(...(allVals as any[]), ts, ts)
        .run();
    }
  }

  const saved = await tableById(env, def, id, locale);
  if (!saved) throw new Error(`saved row could not be read back: ${def.logical_name}/${slug}`);
  return saved;
}

export async function tableDelete(env: Env, def: ThemeTableDef, id: string): Promise<void> {
  if (def.i18n_table) {
    await env.DB.prepare(`DELETE FROM ${def.i18n_table} WHERE row_id = ?`).bind(id).run().catch(() => {});
  }
  await env.DB.prepare(`DELETE FROM ${def.table_name} WHERE id = ? AND site_id = ?`)
    .bind(id, def.site_id)
    .run();
}

function normaliseValue(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "string") return v;
  return JSON.stringify(v);
}
