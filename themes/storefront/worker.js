/**
 * Storefront — an L3 worker-runtime theme.
 *
 * This file is loaded by the host through the Worker Loader. It runs in its
 * own isolate with a minimal `env`:
 *
 *   env.CFP_THEME          theme name
 *   env.CFP_THEME_VERSION  theme version
 *   env.CFP_SITE           resolved site id
 *   env.HOST               Fetcher -> the host's sandboxed theme API
 *
 * It has **no** database, storage or KV binding, and `globalOutbound` is null
 * so it cannot reach the public internet. Everything it knows about content
 * comes from `env.HOST`.
 *
 * The host prepends these request headers before invoking us:
 *   x-cfpress-kind   "home" | "single" | "archive" | "page" | "404"
 *   x-cfpress-site   resolved site id
 *   x-cfpress-scope  JSON blob with title/locale/postType/slug/extra
 */

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function layout({ title, site, body, locale }) {
  return `<!doctype html>
<html lang="${esc(locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — ${esc(site.title)}</title>
<meta name="description" content="${esc(site.description || "")}">
<style>
  :root{--fg:#16181d;--muted:#6b7280;--line:#e5e7eb;--accent:#2563eb;--bg:#fff}
  *{box-sizing:border-box}
  body{margin:0;font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--fg);background:var(--bg)}
  header{border-bottom:1px solid var(--line);padding:20px 24px}
  header a{color:var(--fg);text-decoration:none;font-weight:600;margin-right:18px}
  header a:hover{color:var(--accent)}
  main{max-width:820px;margin:0 auto;padding:48px 24px}
  h1{font-size:2rem;margin:0 0 8px}
  .grid{display:grid;gap:20px;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));margin-top:28px}
  .card{border:1px solid var(--line);border-radius:10px;padding:18px}
  .card h3{margin:0 0 6px;font-size:1.05rem}
  .card p{margin:0;color:var(--muted);font-size:.92rem}
  .badge{display:inline-block;background:#eff6ff;color:var(--accent);border-radius:999px;padding:2px 10px;font-size:.78rem;font-weight:600}
  .price{font-weight:700;color:var(--accent);margin-top:10px;display:block}
  footer{border-top:1px solid var(--line);margin-top:60px;padding:24px;text-align:center;color:var(--muted);font-size:.85rem}
</style>
</head>
<body>
<header>
  <a href="/${esc(locale)}"><strong>${esc(site.title)}</strong></a>
  <a href="/${esc(locale)}/products">Products</a>
</header>
<main>${body}</main>
<footer>Rendered by the Storefront theme Worker · ${esc(site.title)}</footer>
</body>
</html>`;
}

async function api(env, path, params = {}) {
  const url = new URL(`http://host/__cfpress/theme-api/${path}`);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
  const res = await env.HOST.fetch(
    new Request(url.toString(), {
      headers: {
        "x-cfpress-theme": env.CFP_THEME,
        "x-cfpress-site": env.CFP_SITE,
      },
    })
  );
  if (!res.ok) throw new Error(`theme-api ${path} -> ${res.status}`);
  return res.json();
}

export default {
  async fetch(request, env) {
    const kind = request.headers.get("x-cfpress-kind") ?? "home";
    const locale = new URL(request.url).pathname.match(/^\/([a-z]{2}(?:-[A-Za-z]{2})?)/)?.[1] ?? "en";
    let scope = {};
    try {
      scope = JSON.parse(request.headers.get("x-cfpress-scope") ?? "{}");
    } catch {
      /* malformed scope header — render a generic page */
    }

    // A health probe the host uses to warm-validate this module. Answering
    // cheaply here is what lets the host reject a broken theme once instead of
    // failing on every real request.
    if (new URL(request.url).pathname === "/__health") {
      return new Response("ok", { status: 200 });
    }

    const site = await api(env, "site");

    if (kind === "home") {
      const { items } = await api(env, "content", { type: "product", locale, limit: 6 });
      const cards = (items ?? [])
        .map(
          (p) => `<div class="card">
        <span class="badge">Product</span>
        <h3>${esc(p.title)}</h3>
        <p>${esc(p.excerpt || "")}</p>
        <span class="price">${esc(p.slug)}</span>
      </div>`
        )
        .join("");
      return new Response(
        layout({
          title: "Home",
          site,
          locale,
          body: `<h1>${esc(site.title)}</h1>
                 <p>${esc(site.description || "")}</p>
                 <h2 style="margin-top:40px">Latest products</h2>
                 <div class="grid">${cards || "<p>No products yet.</p>"}</div>`,
        }),
        { status: 200, headers: { "Content-Type": "text/html;charset=UTF-8" } }
      );
    }

    if (kind === "archive") {
      const { items } = await api(env, "content", { type: scope.postType ?? "product", locale, limit: 50 });
      const cards = (items ?? [])
        .map(
          (p) => `<div class="card">
        <h3><a href="/${esc(locale)}/products/${esc(p.slug)}">${esc(p.title)}</a></h3>
        <p>${esc(p.excerpt || "")}</p>
      </div>`
        )
        .join("");
      return new Response(
        layout({
          title: "Products",
          site,
          locale,
          body: `<h1>All products</h1><div class="grid">${cards || "<p>Nothing here.</p>"}</div>`,
        }),
        { status: 200, headers: { "Content-Type": "text/html;charset=UTF-8" } }
      );
    }

    if (kind === "single" && scope.slug) {
      const { item } = await api(env, "content/" + encodeURIComponent(scope.slug), {
        locale,
        type: scope.postType ?? "product",
      });
      return new Response(
        layout({
          title: item.title,
          site,
          locale,
          body: `<h1>${esc(item.title)}</h1>
                 <p style="color:#6b7280">${esc(item.excerpt || "")}</p>
                 <article>${item.content || ""}</article>`,
        }),
        { status: 200, headers: { "Content-Type": "text/html;charset=UTF-8" } }
      );
    }

    // Anything else: hand control back to the host by answering 501, which the
    // host treats as "use the declarative renderer".
    return new Response("not handled by theme worker", { status: 501 });
  },
};
