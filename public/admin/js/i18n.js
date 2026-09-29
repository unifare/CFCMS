/**
 * Admin SPA — interface language.
 *
 * Leaf module: imports nothing, so every other module (including `ui.js`,
 * which sits below `state.js`) can depend on it without a cycle.
 *
 * The strings come from `GET /api/v1/i18n/messages`, which returns the whole
 * merged four-layer dictionary (core → plugin → theme → DB overrides) for the
 * resolved UI locale — one request per session, not one per string. The last
 * response is cached in localStorage so the *login* screen renders in the
 * language the user chose previously, before any authenticated request is
 * possible. A fresh browser falls back to the English `fallback` argument
 * every `t()` call carries, which reads correctly everywhere.
 *
 * Menu labels are NOT translated here: the admin-menus API already returns
 * labels translated server-side (see `api.ts`), so switching language
 * re-fetches the context rather than re-translating markup.
 */

let messages = {};
let locale = null;

const LS_KEY = "cfpress.admin.messages";

/**
 * The interface languages the admin offers in its switcher. Mirrors
 * `CORE_PACKS` server-side: a UI language without a bundled core pack would
 * render mostly as keys, so it must not be offered until one exists.
 */
export const UI_LANGUAGES = [
  ["en", "English"],
  ["zh-CN", "简体中文"],
];

/** Look up a dictionary key. `fallback` is the English source string; when
 *  both are missing the key itself is shown (never an empty node). */
export function t(key, fallback) {
  const v = messages[key];
  if (typeof v === "string" && v) return v;
  return fallback !== undefined ? fallback : key;
}

/** The locale the current dictionary came in for, or null before loading. */
export function currentLocale() {
  return locale;
}

/** Install a dictionary (and remember it for the next session). */
export function setMessages(msgs, loc) {
  messages = msgs && typeof msgs === "object" ? msgs : {};
  locale = typeof loc === "string" && loc ? loc : null;
  try { localStorage.setItem(LS_KEY, JSON.stringify({ locale, messages })); } catch { /* storage full / blocked */ }
}

/** Restore the previous session's dictionary, if any. Called before the
 *  first render so the login screen is translated immediately. */
export function cachedMessages() {
  try {
    const d = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    if (d && d.messages && typeof d.messages === "object") {
      messages = d.messages;
      locale = typeof d.locale === "string" ? d.locale : null;
    }
  } catch { /* corrupt cache — fall back to English */ }
}

/**
 * Fetch the merged dictionary for the resolved UI locale (the server honours
 * the user's saved preference). Returns true when something was loaded.
 */
export async function loadMessages() {
  try {
    const d = await fetch("/api/v1/i18n/messages").then((r) => r.json());
    if (d && d.messages && typeof d.messages === "object") {
      setMessages(d.messages, d.locale);
      return true;
    }
  } catch { /* offline / 401 — keep whatever we had */ }
  return false;
}

/**
 * Switch the interface language: persist the preference server-side, load the
 * dictionary for it, and remember it locally. The caller re-renders (and
 * re-fetches the menu context, because labels are translated server-side).
 */
export async function setUiLocale(loc) {
  try {
    await fetch("/api/v1/i18n/ui-locale", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: loc }),
    });
  } catch { /* the GET below still switches this session */ }
  await loadMessages();
}
