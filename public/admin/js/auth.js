/**
 * Admin SPA — authentication: the login screen, sign-in and sign-out.
 *
 * `render()` lives in the shell, which must not import this module (that would
 * be a cycle: auth needs `render`, the shell needs the login screen). So the
 * login screen is *injected* into the shell here, once, at import time.
 */
import { api, app, loadContext, state } from "./state.js";
import { render, setLoginScreen } from "./shell.js";
import { icon } from "../icons.js";
import { alertDialog, setTheme } from "../ui.js";

export function renderLogin() {
  app.innerHTML = `<div class="login"><div class="loginbox">
    <span class="brand-mark">${icon("layers")}</span>
    <h1>Sign in to CFPress</h1>
    <p class="muted">Manage content, themes and sites.</p>
    <div class="login-shell">
      <div class="field"><label for="u">Username</label><input id="u" value="admin" autocomplete="username"></div>
      <div class="field" style="margin-bottom:0"><label for="p">Password</label><input id="p" type="password" value="change-me-now" autocomplete="current-password"></div>
    </div>
    <button class="btn primary" style="width:100%" id="signin">Sign in</button>
    <p class="muted text-sm" style="margin-top:1rem">First login default: <b>admin / change-me-now</b>. Change it before production use.</p>
  </div></div>`;

  const submit = () => doLogin();
  app.querySelector("#signin").onclick = submit;
  app.querySelector("#p").addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
}

export async function doLogin() {
  const u = document.querySelector("#u").value;
  const p = document.querySelector("#p").value;
  try {
    const d = await api("auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: u, password: p }) });
    state.user = d.user;
    await loadContext();
    render();
  } catch (e) {
    await alertDialog({ title: "Sign-in failed", description: e.message });
  }
}

export async function logout() {
  try { await api("auth/logout", { method: "POST" }); } catch { /* ignore */ }
  state.user = null;
  renderLogin();
}

/**
 * Force a theme without touching the UI. Used by the verification harness and
 * handy when debugging contrast; not linked from the interface.
 */
export function setThemeForTest(pref) {
  setTheme(pref);
}

document.addEventListener("click", (e) => {
  if (e.target.closest('[data-action="logout"]')) logout();
});

setLoginScreen(renderLogin);
