/**
 * Screen: Users — admin accounts and roles.
 */
import { api } from "../state.js";
import { pageHead, render } from "../shell.js";
import { icon } from "../../icons.js";
import { t } from "../i18n.js";
import { alertDialog, emptyRow, esc, openDialog, toast } from "../../ui.js";

export default async function users(c) {
  const d = await api("users");
  const rows = (d.items || []).map((x) => `<tr>
      <td><div style="display:flex;align-items:center;gap:.6rem">
        <span class="team-logo" style="width:2rem;height:2rem;background:var(--muted);color:var(--muted-foreground);font-weight:600">${esc(String(x.username || "?").slice(0, 2).toUpperCase())}</span>
        <div><div style="font-weight:500">${esc(x.username)}</div><div class="muted text-sm">${esc(x.email || t("core.users.noEmail", "no email"))}</div></div>
      </div></td>
      <td><span class="badge outline">${esc(x.role)}</span></td>
      <td>${x.status === "active" ? `<span class="badge success">${esc(t("core.users.active", "active"))}</span>` : `<span class="badge secondary">${esc(x.status)}</span>`}</td>
    </tr>`).join("");

  c.innerHTML = `${pageHead({
    title: t("core.nav.users", "Users"),
    sub: t("core.users.sub", "{n} account(s) with admin access", { n: (d.items || []).length }),
    actions: `<button class="btn primary" data-action="new-user">${icon("plus")}${esc(t("core.users.add", "Add user"))}</button>`,
    crumbs: [{ label: t("core.nav.system", "System") }, { label: t("core.nav.users", "Users") }],
  })}
  <div class="table-wrap"><table class="table">
    <thead><tr>
      <th>${esc(t("core.users.colUser", "User"))}</th>
      <th>${esc(t("core.users.colRole", "Role"))}</th>
      <th>${esc(t("core.users.colStatus", "Status"))}</th>
    </tr></thead>
    <tbody>${rows || emptyRow(3, t("core.users.none", "No users."))}</tbody>
  </table></div>`;
}

document.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-action]");
  if (a?.dataset.action !== "new-user") return;
  const v = await openDialog({
    title: t("core.users.addTitle", "Add a user"),
    confirmLabel: t("core.users.createUser", "Create user"),
    fields: [
      { name: "username", label: t("core.users.fieldUsername", "Username"), required: true },
      { name: "password", label: t("core.users.fieldPassword", "Password"), type: "password", required: true, hint: t("core.users.passwordHint", "At least 8 characters") },
      { name: "role", label: t("core.users.fieldRole", "Role"), type: "select", value: "author", options: [
        { value: "admin", label: t("core.users.roleAdmin", "Admin") }, { value: "editor", label: t("core.users.roleEditor", "Editor") },
        { value: "author", label: t("core.users.roleAuthor", "Author") }, { value: "viewer", label: t("core.users.roleViewer", "Viewer") },
      ] },
    ],
  });
  if (!v) return;
  if (String(v.password).length < 8) { await alertDialog({ title: t("core.users.tooShort", "Password too short"), description: t("core.users.tooShortDesc", "Use at least 8 characters.") }); return; }
  try {
    await api("users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(v) });
    toast(t("core.users.created", "User created"));
    render();
  } catch (err) { await alertDialog({ title: t("core.users.createFailed", "Could not create user"), description: err.message }); }
});
