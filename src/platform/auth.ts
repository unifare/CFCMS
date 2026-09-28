import { Env, SessionUser } from "../shared/types";
import { cookieValue, hashPassword, randomId, verifyPassword } from "../shared/crypto";

const SESSION_COOKIE = "cfpress_session";
const SESSION_TTL = 60 * 60 * 24 * 14;

export async function bootstrapAdmin(env: Env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM site_users").first<{ count: number }>();
  if ((row?.count ?? 0) > 0) return;
  const username = "admin";
  const password = "change-me-now";
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT INTO site_users (id, username, email, password_hash, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    "user_" + await randomId(),
    username,
    null,
    await hashPassword(password),
    "admin",
    "active",
    now,
    now
  ).run();
}

export async function login(env: Env, username: string, password: string): Promise<Response> {
  const user = await env.DB.prepare(
    "SELECT id, username, email, password_hash, role, status FROM site_users WHERE username = ? LIMIT 1"
  ).bind(username).first<any>();

  if (!user || user.status !== "active" || !(await verifyPassword(password, user.password_hash))) {
    return Response.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const sessionId = await randomId(24);
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL;
  await env.DB.prepare(
    "INSERT INTO admin_sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
  ).bind(sessionId, user.id, expires, Math.floor(Date.now() / 1000)).run();

  return new Response(JSON.stringify({ ok: true, user: {
    id: user.id, username: user.username, email: user.email, role: user.role, status: user.status
  }}), {
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${SESSION_TTL}`
    }
  });
}

export async function logout(env: Env, request: Request): Promise<Response> {
  const sid = cookieValue(request, SESSION_COOKIE);
  if (sid) await env.DB.prepare("DELETE FROM admin_sessions WHERE id = ?").bind(sid).run();
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`
    }
  });
}

/**
 * The signed-in admin, plus their own UI language.
 *
 * `ui_lang` is a personal preference and is deliberately part of the session
 * identity rather than a site setting: two admins on the same site may read the
 * admin in different languages, and a Chinese owner managing an English-only
 * site must still get a Chinese admin (§2.4 — UI language ≠ content language).
 */
export async function currentUser(env: Env, request: Request): Promise<SessionUser | null> {
  const sid = cookieValue(request, SESSION_COOKIE);
  if (!sid) return null;
  const row = await env.DB.prepare(`
    SELECT u.id, u.username, u.email, u.role, u.status, u.ui_lang, s.id AS sessionId
    FROM admin_sessions s JOIN site_users u ON u.id = s.user_id
    WHERE s.id = ? AND s.expires_at > ? AND u.status = 'active'
    LIMIT 1
  `).bind(sid, Math.floor(Date.now() / 1000)).first<any>();
  return row ?? null;
}

/** Persist an admin's interface language. `null` clears it back to the site default. */
export async function setUserUiLang(env: Env, userId: string, lang: string | null): Promise<void> {
  await env.DB.prepare("UPDATE site_users SET ui_lang=?, updated_at=? WHERE id=?")
    .bind(lang, Math.floor(Date.now() / 1000), userId)
    .run();
}

export async function requireAdmin(env: Env, request: Request): Promise<SessionUser | Response> {
  const user = await currentUser(env, request);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!["admin", "editor", "author"].includes(user.role)) return Response.json({ error: "Forbidden" }, { status: 403 });
  return user;
}
