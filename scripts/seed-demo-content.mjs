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
    "Journal is a reading-first theme. A single centred column, a serif body " +
    "against a sans-serif chrome, and light and dark palettes that were designed " +
    "separately rather than inverted from each other. There is no build step, no " +
    "external font request, and no JavaScript beyond the theme toggle."),
);

const EDGE = body(
  b("core/paragraph",
    "A request for a page reaches a data centre that may be a hundred kilometres " +
    "from the reader, or ten. It is answered there, in one pass, and nothing is " +
    "kept warm between requests. That single constraint — no process to reuse, no " +
    "warm cache to lean on — is what makes the rest of this system look the way " +
    "it does."),
  b("core/heading", "What you give up"),
  b("core/list",
    "A long-lived connection to a database you control.\n" +
    "The freedom to run a background job whenever you feel like it.\n" +
    "The assumption that the same machine will answer the next request."),
  b("core/heading", "What you get back"),
  b("core/paragraph",
    "Latency that does not depend on where the reader happens to be standing, and " +
    "a deployment that is a single atomic upload rather than a rolling restart. " +
    "The trade is real and worth naming: you are exchanging the ability to keep " +
    "state in memory for the guarantee that every request starts from the same " +
    "known place."),
  b("core/quote",
    "Every design decision in this codebase can be traced back to a runtime that " +
    "forgets you between requests."),
);

const TEMPLATES = body(
  b("core/paragraph",
    "The template language has no arithmetic, no loops you can build yourself, and " +
    "no way to call out to anything. It is deliberately too small to be a " +
    "programming language, because the moment it becomes one, every theme becomes " +
    "an application that has to be maintained."),
  b("core/heading", "Ten helpers, and that is the whole vocabulary"),
  b("core/code",
    "len  default  lower  upper  truncate\n" +
    "join  number  date  contains"),
  b("core/paragraph",
    "Anything that needs a computation happens on the server, before the template " +
    "is handed a value. Reading time, formatted dates, resolved URLs — all of them " +
    "arrive ready to print. The template's only job is to decide what goes where."),
  b("core/heading", "Why this is a feature"),
  b("core/paragraph",
    "A theme that can compute is a theme that can be wrong in ways nobody can see. " +
    "A theme that can only place values can be wrong in exactly one way, and that " +
    "way shows up the first time you render it."),
);

const I18N = body(
  b("core/paragraph",
    "Content is stored once per language, side by side with the language it is " +
    "written in. Adding a second language is not a migration: the columns for it " +
    "already exist, holding the default language's text until something replaces " +
    "them."),
  b("core/heading", "The rule that keeps it honest"),
  b("core/list",
    "A translation table is never dropped and never emptied.\n" +
    "A main table only ever gains columns; it never loses one.\n" +
    "A field holding prose is translatable; a field holding a number is not."),
  b("core/paragraph",
    "That last rule is the one people argue about, and it is the one that matters " +
    "most. A price is not a sentence. Translating it is not a feature, it is a bug " +
    "waiting to happen at three in the morning."),
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
  "post_EDGE01aaaaaaaaaaaaaaaa": {
    kind: "posts",
    slug: "rendering-at-the-edge",
    title: "Rendering at the edge, one pass at a time",
    excerpt: "A runtime that forgets you between requests is not a limitation to work around. It is the design.",
    content: EDGE,
  },
  "post_TMPL02bbbbbbbbbbbbbbbb": {
    kind: "posts",
    slug: "a-template-language-small-enough-to-reason-about",
    title: "A template language small enough to reason about",
    excerpt: "Ten helpers, no arithmetic, and no way to call out. That is the whole vocabulary, on purpose.",
    content: TEMPLATES,
  },
  "post_I18N03cccccccccccccccc": {
    kind: "posts",
    slug: "two-languages-one-row",
    title: "Two languages, one row",
    excerpt: "Adding a language should not be a migration, and a price should never be translated.",
    content: I18N,
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
