/**
 * Real-browser acceptance for the multi-language admin surfaces.
 *
 * Drives the running `wrangler dev` host with a real Chromium: logs in, opens
 * Languages, enables a second language through the dialog, then opens a post
 * and checks the editor's language-version bar appeared. Collects console
 * errors, page errors, failed requests and 5xx responses.
 *
 * Usage:
 *   npx wrangler dev --port 47913 --ip 127.0.0.1   (in another shell)
 *   node tests/tools/_i18n-browser.cjs
 */
const PW = "C:/Users/TF/.workbuddy-ai/binaries/node/workspace/node_modules/playwright-core";
const { chromium } = require(PW);

const BASE = process.env.CFPRESS_BASE || "http://127.0.0.1:47913";

const problems = [];
/** Every write the script performs, with its status — so a silent 4xx cannot
 *  masquerade as a UI bug. */
const apiLog = [];
let checks = 0;
let failed = 0;
function check(name, cond, detail = "") {
  checks++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console.error: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  page.on("response", (r) => {
    if (r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.url()}`);
    const m = r.request().method();
    if (m !== "GET" && /\/api\/v1\/(i18n|posts|pages)/.test(r.url())) {
      r.text()
        .then((t) => apiLog.push(`${m} ${new URL(r.url()).pathname.replace("/api/v1/", "")} -> ${r.status()} ${t.slice(0, 160)}`))
        .catch(() => apiLog.push(`${m} ${r.url()} -> ${r.status()} (body unreadable)`));
    }
    if (m === "GET" && /\/api\/v1\/i18n\/translations/.test(r.url())) {
      r.text()
        .then((t) => apiLog.push(`GET i18n/translations -> ${r.status()} ${t.slice(0, 400)}`))
        .catch(() => {});
    }
  });

  console.log("\n1. Log in");
  await page.goto(`${BASE}/admin/`, { waitUntil: "networkidle" });
  await page.fill("#u", "admin");
  await page.fill("#p", "change-me-now");
  await page.click("#signin");
  await page.waitForSelector("#app-header", { timeout: 15000 });
  check("logged in and shell rendered", true);

  console.log("\n2. Languages screen");
  await page.click('[data-nav="languages"]');
  await page.waitForTimeout(800);

  // Make the run repeatable: a previous run may have left a second language
  // enabled, which would make the "starts monolingual" precondition fail for a
  // reason that has nothing to do with this run.
  if (await page.$('[data-lang-disable="zh-CN"]')) {
    await page.click('[data-lang-disable="zh-CN"]');
    await page.waitForSelector(".overlay #dlg-ok", { timeout: 5000 }).catch(() => {});
    await page.click(".overlay #dlg-ok").catch(() => {});
    await page.waitForTimeout(1200);
  }

  const h1 = await page.textContent("h1").catch(() => "");
  check("heading is Languages", /Languages/i.test(h1 || ""), `got "${h1}"`);
  const body = await page.textContent("#content");
  check("site languages panel is present", /Site languages/i.test(body || ""));
  check("english is listed", /\ben\b/.test(body || ""));
  check("interface language panel is present", /interface language/i.test(body || ""));
  check("the four layers are explained", /L0/.test(body || "") && /L3/.test(body || ""));

  const multilingualBefore = /More than one is enabled/.test(body || "");
  check("site starts monolingual", !multilingualBefore, "expected the single-language note");

  console.log("\n3. Enable a second language through the dialog");
  await page.click('[data-action="add-language"]');
  await page.waitForSelector("#dlg-form", { timeout: 5000 });
  await page.fill('#dlg-form [name="code"]', "zh-CN");
  await page.fill('#dlg-form [name="native_name"]', "简体中文");
  await page.fill('#dlg-form [name="name"]', "Simplified Chinese");
  await page.click("#dlg-ok");
  await page.waitForTimeout(1500);

  const body2 = await page.textContent("#content");
  check("zh-CN now listed for the site", /zh-CN/.test(body2 || ""));
  check("the site is now described as multilingual", /More than one is enabled/.test(body2 || ""), (body2 || "").slice(0, 200));
  check("native name is shown, not just the English one", /简体中文/.test(body2 || ""));

  console.log("\n4. Editor language-version bar");
  await page.click('[data-nav="posts"]');
  await page.waitForTimeout(900);

  // Pick the post to work on through the app's own API rather than guessing:
  // we need one whose translation group is genuinely incomplete, so the
  // "create the missing version" path is exercised. A previous run leaves its
  // result behind (disabling a language keeps content), so a fixed row would
  // stop testing the interesting branch after the first run.
  const target = await page.evaluate(async () => {
    const list = await (await fetch("/api/v1/posts?site=default&limit=50")).json();
    for (const it of list.items ?? []) {
      const g = await (await fetch(`/api/v1/i18n/translations?id=${encodeURIComponent(it.id)}&site=default`)).json();
      const gap = (g.versions ?? []).find((v) => !v.exists);
      if (gap) return { id: it.id, title: it.title, locale: gap.locale, group: g.group };
    }
    return null;
  });
  check("found a post whose translations are incomplete", !!target, "every post already has all languages — nothing to exercise");

  if (target) {
    console.log(`  [target] ${target.id} (${target.title}) is missing ${target.locale}`);
    await page.click(`[data-edit$="|${target.id}"]`);
    await page.waitForSelector("#blocks", { timeout: 8000 });
    await page.waitForTimeout(900);

    const ed = await page.textContent("#content");
    check("language versions panel rendered", /Language versions/i.test(ed || ""));
    check(`${target.locale} chip offered`, ed.includes(target.locale));
    check("the missing language is called out", /still missing/.test(ed || ""), (ed || "").slice(0, 300));
    check("locale picker is a select, not free text", !!(await page.$("#locale")) && (await page.evaluate(() => document.querySelector("#locale")?.tagName)) === "SELECT");

    // Create the missing version through the bar.
    const chip = await page.$(`[data-lang-version="${target.locale}"]`);
    check("the missing chip is present and marked as missing", !!chip && (await chip.getAttribute("data-version-exists")) === "0");
    if (chip) {
      await chip.click();
      await page.waitForSelector("#dlg-form", { timeout: 5000 });
      await page.click("#dlg-ok");
      await page.waitForTimeout(2000);

      const made = apiLog.filter((l) => l.includes("i18n/translations ->"));
      check("the version request was accepted (not a silent 4xx)", made.some((l) => /-> 201/.test(l)), made.join("\n       ") || "no request seen");

      const after = await page.textContent("#content");
      // Read the picker's value rather than matching the locale anywhere on the
      // page: the chip label itself contains it, so a text match would pass even
      // if the switch never happened.
      const nowLocale = await page.inputValue("#locale").catch(() => "");
      check("the editor switched to the new version", nowLocale === target.locale, `#locale = "${nowLocale}"`);
      check("no language is reported missing any more", !/still missing/.test(after || ""), (after || "").slice(0, 300));

      // Leave the database as we found it. Without this the script accumulates
      // drafts until no post has an incomplete group left to exercise, and the
      // run would start failing for a reason unrelated to the code. Deleting the
      // version we just made also exercises the editor's delete path.
      await page.click('[data-action="delete-content"]');
      await page.waitForSelector(".overlay #dlg-ok", { timeout: 5000 });
      await page.click(".overlay #dlg-ok");
      await page.waitForTimeout(1500);
      const removed = apiLog.filter((l) => /^DELETE posts\//.test(l));
      check("the created version was deleted again", removed.some((l) => /-> 200/.test(l)), removed.join("\n       ") || "no DELETE seen");
    }
  }

  console.log("\n5. Clean up the language switch");
  await page.click('[data-nav="languages"]');
  await page.waitForTimeout(800);
  const disable = await page.$('[data-lang-disable="zh-CN"]');
  if (disable) {
    await disable.click();
    await page.waitForSelector(".overlay #dlg-ok", { timeout: 5000 }).catch(() => {});
    // `confirmDialog` renders Cancel *before* OK, so a union selector would
    // resolve to Cancel and silently cancel the dialog. Target the id.
    await page.click(".overlay #dlg-ok").catch(() => {});
    await page.waitForTimeout(1200);
    const b3 = await page.textContent("#content");
    check("zh-CN disabled again", /Only one is enabled/.test(b3 || ""), (b3 || "").slice(0, 200));
  } else {
    check("disable control present", false, "no disable button");
  }

  await browser.close();

  console.log("\n6. Console / network health");
  const real = problems.filter((p) => !/401/.test(p));
  check("no console errors, page errors, failed requests or 5xx", real.length === 0, real.join("\n       "));
  if (problems.length && real.length === 0) {
    console.log(`  (ignored ${problems.length} expected pre-auth 401s)`);
  }

  console.log(`\n${checks - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
