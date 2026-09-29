/**
 * Seed realistic demo content through the *API* rather than by writing SQLite
 * directly.
 *
 * Why it matters: `savePost` calls `bumpContentCache`, which is what retires
 * the cached HTML for a site. Writing to the database behind the API's back
 * leaves the old render in place and you end up staring at stale pages
 * wondering why your content edit had no effect.
 *
 * Local dev only. Usage: node scripts/seed-demo-content.mjs
 */
const BASE = process.env.CFP_BASE || "http://127.0.0.1:47913";
const USER = process.env.CFP_USER || "admin";
const PASS = process.env.CFP_PASS || "change-me-now";

const b = (type, text) => ({ type, attrs: { text } });
const body = (...items) => JSON.stringify(items);

const HELLO = body(
  b("core/paragraph",
    "There is a particular kind of quiet that settles over a project once the " +
    "architecture stops fighting you. For two years this site ran on a stack " +
    "where every meaningful change meant negotiating with a framework that had " +
    "its own opinions about how a page should come into being. The publishing " +
    "platform you are reading this on was built to end that negotiation. It " +
    "renders in a single pass, on the edge, in tens of milliseconds, and it " +
    "asks nothing of you but the words."),
  b("core/heading", "Why the edge changes the shape of a CMS"),
  b("core/paragraph",
    "Traditional content management systems assume a machine that stays warm. A " +
    "request arrives, a process wakes, a template is loaded from disk, a " +
    "database connection is borrowed from a pool, and the result is cached in " +
    "memory for the next visitor. The whole design leans on the assumption that " +
    "the server was already there, waiting."),
  b("core/paragraph",
    "An edge runtime inverts that. There is no warm process and no connection " +
    "to borrow. Every request is a cold start that must assemble its own world, " +
    "answer, and disappear. That constraint sounds hostile until you notice " +
    "what it buys: the answer is produced in the city where the reader is " +
    "sitting, and no single machine is holding the whole site hostage."),
  b("core/quote",
    "The fastest request is the one that never had to wake a server to serve it."),
  b("core/heading", "The three constraints that shaped this engine"),
  b("core/paragraph",
    "Everything about the template language follows from three rules, and once " +
    "you accept them the design becomes almost inevitable."),
  b("core/list",
    "No evaluation of user-supplied code. The runtime forbids it, so templates " +
    "are parsed into a syntax tree and interpreted, never executed.\n" +
    "No hidden I/O. A template cannot reach for the network, so every piece of " +
    "data it needs is placed in scope before rendering begins.\n" +
    "No shared mutable state. A render touches only what it was handed, so two " +
    "requests never interfere."),
  b("core/paragraph",
    "The cost is that templates are less expressive than JavaScript, and the " +
    "benefit is that a template can never take the site down. That is a trade " +
    "worth making for something whose entire job is to be reliably available."),
  b("core/heading", "What this means for the people writing"),
  b("core/paragraph",
    "The most interesting consequence is not technical. When rendering is cheap " +
    "and predictable, the shape of the writing changes. You stop thinking about " +
    "the page as a resource to be optimised and start thinking about it as a " +
    "thing to be read. Long-form prose comes back, because there is no longer a " +
    "penalty for it."),
  b("core/code",
    "// A theme is a folder, not an application.\n" +
    "themes/fixture/\n" +
    "  theme.json\n" +
    "  templates/\n" +
    "    index.html    // the home page\n" +
    "    single.html   // one article\n" +
    "    archive.html  // a list of them"),
  b("core/paragraph",
    "That folder is the whole contract. Drop it in, activate it, and the site " +
    "changes shape without a deploy pipeline, a build step, or a single line of " +
    "JavaScript that anyone has to maintain. The platform handles the rest."),
  b("core/heading", "Where this goes next"),
  b("core/paragraph",
    "Themes that can compile themselves. Templates that can call into a " +
    "sandboxed worker for genuinely dynamic behaviour. A plugin surface that " +
    "lets a third party extend the engine without ever asking for trust. None " +
    "of it is speculative; each piece is a small step from where the code " +
    "already sits."),
  b("core/paragraph",
    "But the foundation matters more than the roadmap. A publishing platform " +
    "earns its keep by being boring in the right places: fast where it should " +
    "be fast, predictable where it should be predictable, and quiet everywhere " +
    "else. Everything else is decoration."),
);

const SECOND = body(
  b("core/paragraph",
    "A shorter note, included mainly so the archive and the related-articles " +
    "strip have more than one real entry to work with. The engine treats it " +
    "exactly like the longer piece, which is rather the point."),
  b("core/heading", "Small pieces, same machinery"),
  b("core/paragraph",
    "There is no separate code path for a short post. The same template, the " +
    "same scope, the same rendering pass. Whatever the theme does to a long " +
    "article it does to a short one, and if that ever stops being true the " +
    "theme has a bug."),
  b("core/quote", "Uniformity of mechanism, variety of output."),
);

const ABOUT = body(
  b("core/paragraph",
    "This site is a demonstration of a publishing platform built entirely on " +
    "Cloudflare Workers, D1 and R2. There is no origin server and no container " +
    "anywhere in the request path: a page is assembled at the edge, from data " +
    "that lives next to it."),
  b("core/heading", "What is running here"),
  b("core/list",
    "A declarative template engine that interprets themes rather than executing " +
    "them.\nA per-site content model with custom post types and fields declared " +
    "by the theme itself.\nA sandboxed runtime for themes that genuinely need to " +
    "run code."),
  b("core/heading", "About this theme"),
  b("core/paragraph",
    "Aurora is a long-form editorial theme. It exists to show that a theming " +
    "layer built for constrained runtimes does not have to look constrained: " +
    "warm paper tones, real typographic hierarchy, a drop cap on the opening " +
    "paragraph, and an automatic table of contents that appears only when an " +
    "article is long enough to need one."),
);

const CONTENTS = {
  "post_Qps_LsNapf22VhSW9bFxTA": {
    kind: "posts",
    slug: "hello-world",
    title: "Hello World",
    excerpt: "A publishing platform built to end the negotiation with its own framework.",
    content: HELLO,
  },
  "post_4E_VfYU_rSAnepUdteAqew": {
    kind: "posts",
    slug: "second-post",
    title: "Second Post",
    excerpt: "A shorter note about uniformity of mechanism and variety of output.",
    content: SECOND,
  },
  "page_JJEanMucBzmj-l6Lmju3VQ": {
    kind: "pages",
    slug: "about",
    title: "About",
    excerpt: "What this site is, and what it is running on.",
    content: ABOUT,
  },
};

let cookie = "";
async function api(path, init = {}) {
  const res = await fetch(BASE + "/api/v1/" + path, {
    ...init,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(init.headers || {}) },
  });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

const login = await api("auth/login", {
  method: "POST",
  body: JSON.stringify({ username: USER, password: PASS }),
});
if (login.status >= 400) {
  console.error("login failed", login.status, login.json);
  process.exit(1);
}
console.log("login ok");

for (const [id, c] of Object.entries(CONTENTS)) {
  const r = await api(`${c.kind}/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      locale: "en",
      // `slug` must be sent explicitly: omitting it makes savePost fall back to
      // the post id, which silently breaks every existing permalink.
      slug: c.slug,
      title: c.title,
      excerpt: c.excerpt,
      content: c.content,
      status: "published",
    }),
  });
  const okFlag = r.status < 400;
  console.log(`${okFlag ? "ok  " : "FAIL"} ${id} (${c.title}) -> ${r.status} ${okFlag ? "" : JSON.stringify(r.json)}`);
}
