---
name: acceptance-script-vs-real-dev-server
description: 当需要证明「新做的界面在真实浏览器里真的能用」时使用——用本机 managed playwright-core 驱动真实 dev server（wrangler dev / vite / next dev），写一个可重复执行的验收脚本。覆盖：怎么拿到 playwright-core 而不用装依赖、脚本必须自己清理自己（含**数据库足迹**：声明式注册表通常不随停用清理，留着会污染共享库并让别的套件莫名变红；断言要按自己的属主收窄而非全局计数）、用应用自己的 API 选目标而不是固定行号、以及四个会让脚本说谎的坑（联合选择器命中 Cancel、断言文案被自己满足、按文本匹配代替读控件值、选择器靠猜）。触发词：真实浏览器验收、端到端验收、playwright 验收、跑一遍真实界面、验收脚本、浏览器里点一遍、e2e、冒烟验收、脚本可重复、自清理。
agent_created: true
---

# 对着真实 dev server 写可重复的验收脚本

## 什么时候用

单测（jsdom / 进程内）全绿，但你需要**证明界面真的能用**：按钮点得动、面板真的多出来、
弹窗真的关上。单测驱动不了浏览器的事件路径，所以它是「组件逻辑对」而不是「界面能用」。

和另一条链路的分工：

| | 用哪个 |
|---|---|
| 要量几何 / 布局（偏了几像素、被裁掉、键盘避让） | skill `cdp-probe-real-layout`（CDP + 假后端） |
| 要验真实服务端的交互链路（登录 → 改设置 → 生效 → 撤回） | **本文**（playwright-core + 真 dev server） |

**能起真 server 就别 mock。** mock 只证明「我以为的接口形状是对的」，
真 server 才证明「前后端接得上」。

## 拿到 playwright-core（本机无需 npm install）

managed workspace 里已经有 playwright-core，浏览器在 `%LOCALAPPDATA%\ms-playwright`：

```js
// 必须是 .cjs —— 多数项目 package.json 里有 "type": "module"
const PW = "C:/Users/TF/.workbuddy-ai/binaries/node/workspace/node_modules/playwright-core";
const { chromium } = require(PW);
const BASE = process.env.APP_BASE || "http://127.0.0.1:8787";
const browser = await chromium.launch();
```

用 managed node 跑：`C:/Users/TF/.workbuddy-ai/binaries/node/versions/22.22.2-3/node.exe`
（`node.exe script.cjs`）。**不要** `npx playwright install`——浏览器已经在了。

dev server 另开一个 shell：
`npx wrangler dev --port 8787 --ip 127.0.0.1` / `npm run dev`。
**先 `curl -s -o /dev/null -w "%{http_code}" $BASE` 确认起来了**，否则脚本的失败信息
会指向选择器，而真实原因是 server 没起。

## 四条铁律

### 1. 脚本必须自己清理自己

**这是最容易忽略、代价最大的一条。** 验收脚本会写真实数据；不清理的话第二轮跑起来
数据状态已经变了，断言开始因为「没有可测的数据」而失败——你会去查产品，其实是脚本的问题。

```js
// 用完即删：把这一轮造出来的东西删掉，让 DB 回到脚本开始前的样子
await page.click('[data-action="delete"]');
await page.waitForSelector(".overlay #dlg-ok");
await page.click(".overlay #dlg-ok");
```

顺手在开头做一次**复位**，容忍上一轮留下的残留：

```js
// 上一轮可能把开关留在「开」的位置，先关掉再断言「初始是关的」
if (await page.$('[data-lang-disable="zh-CN"]')) { /* 关掉它 */ }
```

清理动作本身也值得断言（`check("删掉了", ...)`）——顺便就覆盖了删除路径。

#### 「清理干净了」= 界面上看不出来 + 库里真的没留

**最容易漏的是数据库足迹，因为「停用」看起来就像清理。** 实测踩过：脚本停用了自己装的
主题、删掉了自己建的那行数据，界面上一切都复原了 —— 但那张**声明式注册表**里还留着
这个夹具主题的行，因为那张表的设计就是**不随停用消失**（数据要留住，主题切回来还能用）。
后果不在本轮：它让**另一个**套件读到了这个主题的表，报出一个看起来毫无关联的失败
（`expected ["product"] / actual ["product","product"]`），排查方向完全跑偏。

判断方法很直接：**问一句「我刚才写的那些行，谁负责删？」** 如果答案是「停用会自动清」，
去读一眼实现 —— 声明式的东西（菜单注册表、表注册表、字段定义、post types）通常
**故意**不随停用清理。

```js
// 脚本是 Node 进程，可以直接打开本地库把自己造的行删掉
const { DatabaseSync } = require("node:sqlite");
function resetFixture() {
  const dir = join(ROOT, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject");
  const file = readdirSync(dir).find((x) => x.endsWith(".sqlite"));
  const db = new DatabaseSync(join(dir, file));
  for (const s of [
    `DELETE FROM theme_table_defs WHERE theme_name='${THEME}'`,
    `DELETE FROM theme_installs WHERE name='${THEME}'`,
    `DROP TABLE IF EXISTS theme_${THEME}_${TABLE}`,
  ]) { try { db.exec(s); } catch {} }
  db.close();
}
```

**开头也调一次**：上一轮在清理之前崩了，这一轮不该跟着崩。

#### 共享数据库里，断言要按「自己的东西」收窄

同一个本地库被多个套件共用时，`GET /items` 返回的是**全库**的东西，不是「你这个夹具的」。
断言写成全局计数，就会在别的套件留下残留时变红 —— 而那是**测试设计**的问题，不是产品问题。

```js
// ✗ 依赖「库里只有我这一条」
check("table is registered", tt.items.map(d => d.logical_name), ["product"]);
// ✓ 收窄到自己
const mine = tt.items.filter(d => d.theme_name === THEME);
check("table is registered", mine.map(d => d.logical_name), ["product"]);
```

收窄**不会**削弱断言（同属主出现两行依然会红），但把耦合去掉了。
改完做一次反向验证：把过滤条件指向一个不存在的属主名，断言必须 FAIL ——
否则它可能在**空集合上静默通过**。

### 2. 用应用自己的 API 选目标，别依赖固定行号 / 固定文案

列表页的第一行是「最近更新的」——你上一轮刚改过它，这一轮它就不是第一行了。
固定 `page.click("[data-edit]")`（第一个）会让脚本**第二轮开始测错对象**。

让页面自己用它的 API 挑一个符合前置条件的目标，再按 id 点进去：

```js
const target = await page.evaluate(async () => {
  const list = await (await fetch("/api/v1/posts?site=default&limit=50")).json();
  for (const it of list.items ?? []) {
    const g = await (await fetch(`/api/v1/i18n/translations?id=${it.id}`)).json();
    const gap = (g.versions ?? []).find((v) => !v.exists);
    if (gap) return { id: it.id, locale: gap.locale };   // 前置条件确实成立的那个
  }
  return null;
});
check("找到了满足前置条件的目标", !!target, "全都不满足 —— 说明是数据问题，不是代码问题");
if (target) await page.click(`[data-edit$="|${target.id}"]`);
```

`page.evaluate` 里 `fetch` 自动带 cookie，**不用自己传凭据**。

### 3. 断言要读控件的值，不要匹配页面文案

```js
// ❌ 恒真：chip 的文案里本来就有 "zh-CN"，切换没发生也会过
check("切到了 zh-CN", /zh-CN/.test(await page.textContent("#content")));

// ✅ 读控件的真实值
const now = await page.inputValue("#locale").catch(() => "");
check("切到了 zh-CN", now === "zh-CN", `#locale = "${now}"`);
```

同理：`textContent` 读不到表单控件的值（值在 `.value` 里，不在文本节点里）；
`<select>` 也要 `.value` / `page.inputValue()`。

**另一类恒真**：断言「页面里有 X 文字」，而 X 是你正在测的那个按钮的标签。
先问一句「这条断言在不修的情况下会不会也过」。

### 4. 记录每一次写操作的响应状态

**静默 4xx 是最会伪装成 UI bug 的东西**：接口返回 409/400，前端弹了个对话框，
页面看着「什么都没发生」，你去查渲染——查错方向了。

```js
const apiLog = [];
page.on("response", (r) => {
  const m = r.request().method();
  if (m !== "GET" && /\/api\/v1\//.test(r.url())) {
    r.text().then((t) => apiLog.push(`${m} ${new URL(r.url()).pathname} -> ${r.status()} ${t.slice(0,160)}`))
             .catch(() => {});
  }
});
// 然后在关键动作后断言
const made = apiLog.filter((l) => l.includes("translations ->"));
check("请求被接受了（不是静默 4xx）", made.some((l) => /-> 201/.test(l)), made.join("\n  ") || "压根没发请求");
```

`"压根没发请求"` 和 `"发了但被拒"` 是两种完全不同的病，日志直接分开它们。
需要看 GET 的返回体时也把 GET 收进来（临时加，别长期留着刷屏）。

## 四个会让脚本说谎的坑

1. **联合 CSS 选择器按 DOM 顺序命中，不是按你写的顺序。**
   ```js
   // ❌ confirmDialog 的 Cancel 在 OK 之前 —— 这条会点到 Cancel，静默取消对话框
   page.$(".overlay .btn.danger, .overlay #dlg-ok, .overlay .dialog-actions .btn")
   // ✅
   page.click(".overlay #dlg-ok")
   ```
   **凡是有 id 就用 id。**

2. **`waitForSelector` 超时会抛，抛了就整个脚本退出**（别把它塞进没有 try 的分支，
   否则你看到的是一句 `TimeoutError`，而不是「第 4 段失败」这种有用信息）。

3. **选择器先读源码再写。** 我这次猜 `input[name="username"]`，实际是 `#u`/`#p`/`#signin`，
   白等 30 秒超时。**grep 一下模板/组件里的 id 和 `data-*`**，比猜快得多。

4. **`page.textContent` 拿到的是渲染后的文本**，SVG 图标读不出来（只剩空白）。
   靠图标区分状态时，断言 `data-*` 属性而不是文本。

## 收尾：健康检查那一段最有价值

```js
const problems = [];
page.on("console", (m) => { if (m.type() === "error") problems.push(`console.error: ${m.text()}`); });
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("requestfailed", (r) => problems.push(`requestfailed: ${r.url()}`));
page.on("response", (r) => { if (r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.url()}`); });

// 登录前的 401 是设计内的，别去"修"
const real = problems.filter((p) => !/401/.test(p));
check("零 console 错误 / 页面异常 / 失败请求 / 5xx", real.length === 0, real.join("\n  "));
```

**「界面看着对」不等于「界面是干净的」。** 这一条经常抓出前几条断言看不见的东西
（某个接口 500 被 catch 掉了、某个资源 404 但 fallback 上了）。

## 跑几遍再说它稳定

跑**三遍**。第二遍是验证「自清理 + 动态选目标」有没有写对，第三遍确认不是巧合。
然后才是「验收通过」。

## 范例

`cfpress` 仓库的 `tests/_i18n-browser.cjs`（22 条断言）：登录 → 语言开关 → 编辑器
语言版本条 → 建翻译 → 删翻译 → 停用语言 → 健康检查。它清理自己、用 API 选目标，
所以能重复跑。**写新脚本时直接抄它。**
