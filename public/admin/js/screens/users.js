/**
 * Screen: Users — admin accounts and roles.
 */
import { api } from "../state.js";
import { pageHead, render } from "../shell.js";
import { icon } from "../../icons.js";
import { alertDialog, emptyRow, esc, openDialog, toast } from "../../ui.js";

export default async function users(c) {
  const d = await api("users");
  const rows = (d.items || []).map((x) => `<tr>
      <td><div style="display:flex;align-items:center;gap:.6rem">
        <span class="team-logo" style="width:2rem;height:2rem;background:var(--muted);color:var(--muted-foreground);font-weight:600">${esc(String(x.username || "?").slice(0, 2).toUpperCase())}</span>
        <div><div style="font-weight:500">${esc(x.username)}</div><div class="muted text-sm">${esc(x.email || "no email")}</div></div>
      </div></td>
      <td><span class="badge outline">${esc(x.role)}</span></td>
      <td>${x.status === "active" ? `<span class="badge success">active</span>` : `<span class="badge secondary">${esc(x.status)}</span>`}</td>
    </tr>`).join("");

  c.innerHTML = `${pageHead({
    title: "Users",
    sub: `${(d.items || []).length} account${(d.items || []).length === 1 ? "" : "s"} with admin access`,
    actions: `<button class="btn primary" data-action="new-user">${icon("plus")}Add user</button>`,
    crumbs: [{ label: "System" }, { label: "Users" }],
  })}
  <div class="table-wrap"><table class="table">
    <thead><tr><th>User</th><th>Role</th><th>Status</th></tr></thead>
    <tbody>${rows || emptyRow(3, "No users.")}</tbody>
  </table></div>`;
}

document.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-action]");
  if (a?.dataset.action !== "new-user") return;
  const v = await openDialog({
    title: "Add a user",
    confirmLabel: "Create user",
    fields: [
      { name: "username", label: "Username", required: true },
      { name: "password", label: "Password", type: "password", required: true, hint: "At least 8 characters" },
      { name: "role", label: "Role", type: "select", value: "author", options: [
        { value: "admin", label: "Admin" }, { value: "editor", label: "Editor" },
        { value: "author", label: "Author" }, { value: "viewer", label: "Viewer" },
      ] },
    ],
  });
  if (!v) return;
  if (String(v.password).length < 8) { await alertDialog({ title: "Password too short", description: "Use at least 8 characters." }); return; }
  try {
    await api("users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(v) });
    toast("User created");
    render();
  } catch (err) { await alertDialog({ title: "Could not create user", description: err.message }); }
});
