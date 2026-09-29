---
name: author-cfpress-theme
description: 当要为 CFPress（Cloudflare Workers 无构建 CMS）编写或改造一个前台主题，或排查「主题不生效」时使用。覆盖模板语言的硬约束（helper 调用形式、helper 可嵌套子表达式、无上级作用域、@first 绑定位置、@section 插槽）、上下文可用字段、派生值应服务端算、主题自带文案的 langs/ 与 key 前缀规则、tables[] 自有表声明与 translatable 划分（字段类型只有 6 种、安装期校验）、adminMenus 指向生成式 table-list/table-edit 屏幕（后台零代码，args.table 必须是已声明的逻辑名）、路由的 locale 前缀语义（无前缀按默认语言解析，/admin 属静态资源层）、通过 API 播种内容（直写库会留下旧缓存）、activeTheme 解析与 theme.active 缺失导致 __fallback__、本地 R2 重启后清空、以及上线前的渲染自检。触发词：写主题、新建主题、主题模板、theme.json、templates/index.html、前台样式、主题不生效、首页没变、根路径、__fallback__、__none__、X-CFPress-Template、模板报错、主题自有表、translatable、langs、语言包、主题文案、adminMenus、table-list、后台菜单、{{/section}}、section 没闭合、空白页、main 是空的。
agent_created: true
---

# 为 CFPress 写主题

## 先做这件事：确认现状，别信「已经有主题了」

如果是「把主题做得更好看」这类需求，**先核实现有主题到底长什么样**：

```bash
find themes -type f | sort
# 逐字比较两个模板 —— 很多「主题」其实是同一个骨架的副本
diff themes/default/templates/index.html themes/magazine/templates/index.html
```

实测过：某项目声称有 3 个主题，其中 magazine 的 `index.html` 与 `single.html`
**逐字相同**，都是 6 行骨架。所谓「多个主题」不成立。
**先 diff 再动手**，否则会在错误的基线上做增量修改。

## 模板语言的四条硬约束

**这四条都会让整页抛错或静默走错分支，没有编译期提示。**

### 1. helper 必须写 `f(a, b)`，不能写空格参数

```
{{len(posts)}}                  ✅
{{len posts}}                   ❌ Trailing tokens in expression → 整页渲染失败
{{truncate(post.excerpt, 240)}} ✅
```

只有 10 个 helper：`len / default / lower / upper / truncate / join /
number / date / contains`，加上指令 `@extends @section @include @query`。
**没有算术运算符**（`+` `-` 不支持，别写 `{{a + 1}}`）。

**helper 可以嵌套进子表达式**（实测可用，很适合做条件分类）：

```
{{#if (contains(post.type, "page"))}}Page{{else}}Article{{/if}}   ✅
{{#if (contains(join(r.tags, ","), "featured"))}}…{{/if}}          ✅
```

**但 helper 不能拿来做算术。** 需要「读 X 分钟」这类派生值，
别硬塞进模板 —— 到 TS 侧算完挂到对象上（见下「派生值服务端算」）。

### 2. 不支持 `../` 父作用域

`{{#each}}` 用 `Object.create(scope)` 建子作用域，
**父级变量按名字直接可见**，不需要也不能写 `../`：

```
{{#each related as r}}
  <a href="/{{locale}}/blog/{{r.slug}}">   ✅ locale 穿透可访问
{{/each}}
```

写 `{{../locale}}` 直接抛 `Unexpected character in expression: /`。

### 3. `@first` / `@last` / `@index` 绑在迭代作用域，不在 item 上

```
{{#if post["@first"]}}  ❌ 恒为空 —— 首条永远进不了这个分支
{{#if @first}}          ✅
```

这个坑特别隐蔽：**模板不报错，只是「头条」区域永远空着**，
列表其余部分完全正常，很容易以为是数据处理问题。

### 4. `@extends` 的插槽是 `{{@section "name"}}`，不是 `{{@block}}`；**`{{/section}}` 不能省**

```html
<!-- parts/layout.html -->
<main>{{@section "content"}}</main>

<!-- index.html -->
{{@extends "parts/layout"}}
{{@section "content"}}
  ...页面内容...
{{/section}}
```

同一个标签两种含义：**有配对的 `{{/section}}` 就是「定义」，没有就是「插槽」**。

⚠️ **子模板里漏掉 `{{/section}}` 是本仓库最贵的一个坑**（2026-09-29 实测）：
引擎向后扫描找不到闭合标签 → 把子模板的 section 判成**插槽** → 它不进 `@sections` →
布局渲染**空的 `<main>`**。症状是 **HTTP 200、零异常、零日志、页面基本空白但页头页脚都在**，
而且清单校验器与架构测试**都会说它没问题**——**只有真的渲染一遍才现形**。

- 现在引擎会直接抛错（不再静默）：
  `Template @extends "…" but leaves section(s) unclosed: content`。
  判据是文件事实（`@extends` 了的文件是子模板，子模板永不提供插槽），不是文本匹配。
- **`scripts/make-theme.mjs` 生成的骨架曾经四个子模板全漏**。改模板后请务必渲染一次，
  或用 `node tests/scaffold.test.mjs` 的方式对生成物跑真实引擎。
- 相关：`@extends` 链的 section 合并**从根向子遍历、后来者覆盖**（最派生者胜）。
  两层继承看不出问题，**三层**才暴露（曾把根当赢家）。目前没有主题嵌套布局，别假设它一定对。

## 上下文里有什么

`buildScope` 提供：

| 键 | 内容 |
|---|---|
| `site` | `title` `description` `robots` `locale` |
| `page` | `title` `description` `path` `kind` `document_title` |
| `locale` `locales[]` | 当前与全部语言 |
| `menu.primary[]` | `title` `url` `target`；`primary_html` 是拼好的 `<a>` |
| `post` | 当前对象（单篇/页面时有） |
| `theme` | `name` `version` `title` |
| `posts[]` | 列表页（home/archive/route）注入 |
| `route` | 路由页注入：`path` `params` `query` |

**列表项字段**：`slug` `title` `excerpt` `content` `created_at` `updated_at`
`meta{}`（主题声明的自定义字段）、**`html`（已渲染的正文 HTML）**。

**`<title>` 直接渲染 `page.document_title`。** 模板语言没有字符串比较，
所以「首页标题等于站点名时不要再拼一次」这条规则由 runtime 代劳 ——
自己拼 `{{page.title}} | {{site.title}}` 会在首页得到 `My Shop | My Shop`。

**正文一定要用 `{{{post.html}}}`（三花括号）** —— 双花括号会转义，
你会看到满页 `<p>` 标签源码。

### 派生值在服务端算，不要在模板里凑

模板没有算术，而 JS 运行时会在首屏闪一个占位符（先渲染 `&mdash;` 再改成真值，
用户能看到跳变）。正确做法是在 TS 侧算完挂到对象上：

```ts
// src/platform/frontend.ts —— findContent 里顺手挂上
export function readingTime(html: string, wpm = 220) {
  const text = String(html).replace(/<[^>]*>/g, " ").replace(/&[a-z]+;|&#\d+;/gi, " ");
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / wpm)) + " min read";
}
// row.html = …; row.reading_time = readingTime(row.html);
```

模板直接 `{{post.reading_time}}`，运行时只在**没有数字时**才兜底：

```js
if (rt && !/\d/.test(rt.textContent || '')) { /* 兜底重算 */ }
```

### 路由必须带 locale 前缀吗？看版本

**旧行为**（已修）：前台路由只匹配 `/^\/([a-z]{2}(?:-[A-Za-z]{2})?)(?:\/(.*))?$/`，
不匹配就 `env.ASSETS.fetch()`。于是**不带 locale 的路径返回后台/静态外壳**，
现象就是「整个页面变成后台的样子」。

**现行行为**：无前缀路径**按站点默认语言解析**，与带前缀的等价：

```
/                      ✅ 主题首页（默认语言）
/about                 ✅ 主题页面
/blog/hello-world      ✅ 单篇
/en/about              ✅ 显式指定语言
```

所以现在 `/` 和 `/en` 都能进主题。**但你仍要先确认 URL 落到了主题** ——
看 `X-CFPress-Template` 头，有值才是主题渲染的。

`/admin/*` 属于静态资源层，**不经主题**（它的响应没有 `X-CFPress-Template` 头）。

⚠️ **如果你在改路由**：注意「语言前缀解析」绝不能兼任「静态资源兜底」。
历史上 `if(!m) return env.ASSETS.fetch(request)` 同时干了两件事，
去掉它会让 `/admin/` 直接变成主题 404。静态资源的归属要**显式**写在
路由最前面，别寄生在语言判断里。

## 主题自带文案：`langs/` 与 key 前缀

声明式主题的界面文案放在 **`themes/<name>/langs/<locale>.json`**，运行时从 R2 读。
`theme.json` 的 `locales[]` 只声明「支持哪些语言」，不是文案本身。

**key 必须带前缀 `theme.<name>.`**（插件用 `plugin.<name>.`，覆盖平台内置文案用 `core.`）：

```json
// themes/aurora/langs/zh-CN.json
{ "theme.aurora.nav.home": "首页" }
```

写成 `"nav.home"` 会让**架构测试直接失败**，这不是风格要求：两个扩展都定义 `nav.home` 时，
谁生效取决于加载顺序，而且**没有正确的修复位置**——前缀让 key 全局唯一，冲突时一眼看出该改谁。

插件**没有 `langs/` 目录可读**（上传的包是 zip，平台从不解包），只能把语言包**内联在
`plugin.json` 的 `langs{}` 里**。主题两种都可以用，但 `langs/` 目录更清晰。

## 主题自有表：`tables[]` 声明

需要真正的业务表（产品、房源、宠物）时，在 `theme.json` 里**声明**，平台负责建表。
**主题永远不写 `CREATE TABLE`，也看不到物理表名**——它只用逻辑名（`product`）。

```json
"tables": [{
  "name": "product",
  "label": "Product",
  "translatable": ["name", "description"],
  "fields": [
    { "key": "name",        "type": "text",     "label": "Name" },
    { "key": "description", "type": "longtext", "label": "Description" },
    { "key": "price",       "type": "number",   "label": "Price" },
    { "key": "sku",         "type": "text",     "label": "SKU" }
  ]
}]
```

四条会在**安装时**被拒（400，不会等到渲染）的硬规则：

1. **`fields[].type` 只有 6 种**：`text` / `longtext` / `number` / `boolean` / `date` / `datetime`。
   **没有 `integer`**——`number` 就够了。
2. **`translatable` 里的每个 key 都必须在同一张表的 `fields[]` 里声明过**。
3. **`name` 是逻辑名**：小写标识符、≥2 字符、不带斜杠。物理名由平台拼成
   `theme_{theme}_{name}`。
4. **字段名不得与平台保留列冲突**：`id` / `site_id` / `slug` / `lang_group` / `status` /
   `created_at` / `updated_at`。

**`translatable` 的划分是这个模型最重要的价值，不是可选项。**
`price` 不该多语言，`name` 该。一股脑把所有字段都做多语言，会出现「英文站打八折」这种灾难。

机制上：可翻译字段**同时存在于主表和 `{table}_i18n`**（主表那列是站点默认语言的值，
所以单语言站点也能存产品名，且**启用第二种语言不需要数据迁移**）；
`_i18n` 表**只在站点服务 ≥2 种语言时才建**——「我们不做多语言」因此是数据库里
可验证的事实，而不是代码里的承诺。停用语言**只隐藏，不 drop**（WordPress 在这里丢数据）。

在主题 Worker 里通过宿主 facade 访问，**不要自己拼 SQL**：
`table/{logical}`（GET 列表 / POST 存）、`table/{logical}/{slug}`（GET 单条）。
只读**自己声明过**的表——`resolveThemeTable()` 按主题名过滤，访问别人的表是 404。

### 声明了表，后台就自动有了：`adminMenus` + `table-list` / `table-edit`

**你不需要写任何后台代码。** 在 `theme.json` 里挂一个菜单，指向生成的屏幕：

```json
"adminMenus": [{
  "id": "products", "label": "Products", "icon": "box",
  "screen": "table-list", "args": { "table": "product" }
}]
```

列表的每一列来自 `fields[]`，新增/编辑表单的控件来自 `field.type`（六种类型各对应一个
控件，`datetime` 列在库里是 **INTEGER 秒**，前端负责本地时区往返）。所以
**`fields[]` 写对了，后台就对**——这也是为什么字段类型只有六种：每个类型都要有唯一控件。

三条会**安装失败**（400）的规则：

1. `args.table` 必须是**本主题 `tables[]` 里声明过的逻辑名**（不是物理表名）。
2. `id` 是纯标识符、同一主题内不得重复；`screen` 必须是已知屏幕。
3. **插件用不了 `table-list` / `table-edit`**，也**不能声明 `tables[]`**（校验器直接拒绝）。
   这两个屏幕渲染的是**主题声明的表**，插件没有表可依赖。

**切主题不会丢数据**：物理表与「逻辑名 → 物理表名」的注册表**都不随主题停用清理**，
只有**菜单**跟着当前主题走。切回来菜单就回来，数据一直在——这是刻意与 WordPress 分道扬镳
的地方。（顺带一个测试上的后果：夹具主题必须在收尾时自己删掉注册表里的行，见 skill
`acceptance-script-vs-real-dev-server`。）

## 写模板：从 harness 开始，不要直接部署

模板抛错时**整页静默降级成无样式的空壳**，浏览器里只看到一排裸文字，
极难反推是哪一行。所以先写一个离线渲染 harness：

```js
// tests/theme-<name>.test.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// 引擎是 TS 且无构建步骤；Node 自带类型擦除不支持参数属性
// （constructor(private x: T)），所以用 esbuild 转译。
const esbuild = require("esbuild");
const out = esbuild.transformSync(readFileSync("src/rendering/template-engine.ts", "utf8"),
  { loader: "ts", format: "esm", target: "es2022" });
const E = await import("data:text/javascript;base64," + Buffer.from(out.code).toString("base64"));

const DIR = "themes/<name>/templates";
const load = (n) => { try { return readFileSync(`${DIR}/${n}.html`, "utf8"); } catch { return null; } };

const html = await E.renderTemplateSource(readFileSync(`${DIR}/index.html`, "utf8"), scope,
  { loadTemplate: load, runQuery: async (p) => rows });
```

**断言这四件事**，它们能抓住绝大多数事故：

```js
if (!html.includes("<html"))   issues.push("壳层没渲染出来（插槽没填）");
if (html.includes("{{"))       issues.push("有未解析的模板语法残留");
if (html.includes("undefined"))issues.push("输出里出现了 undefined");
if (html.includes("Aurora"))   /* 品牌/站点名渲染出来了 */
```

**边界用例比happy path更能抓 bug**，至少覆盖：
空文章（`post.html = ""`）、空列表（`posts = []`）、空菜单、无描述。

想快速定位是哪条表达式出错，直接喂给解析器：

```js
for (const e of ["len posts", "truncate post.excerpt 240", "../local"]) {
  try { E.parseExpression(e); } catch (err) { console.log("FAIL", e, err.message); }
}
```

## 播种内容：必须走 API

**不要直接写 SQLite。** 内容写入要通过 `PUT /api/v1/posts/:id`，
因为 `savePost` 内部会调 `bumpContentCache()` —— 那是唯一让**缓存 HTML 失效**
的机制。绕过 API 直写库，页面会继续吐旧 HTML，你会以为改动没生效而反复排查。

```js
await api(`posts/${id}`, { method: "PUT", body: JSON.stringify({
  locale: "en",
  slug,            // ⚠️ 必须显式传！省略会让 savePost 用 post id 当 slug，
                   //    所有既有固定链接静默失效（返回 404）
  title, excerpt, content, status: "published",
})});
```

正文是块 JSON 字符串：

```js
const b = (type, text) => ({ type, attrs: { text } });
const content = JSON.stringify([
  b("core/paragraph", "…"),
  b("core/heading", "A section"),
  b("core/quote", "…"),
  b("core/list", "Item one\nItem two"),   // 换行分隔
  b("core/code", "const x = 1;"),
]);
```

可用块类型：`core/paragraph` `core/heading` `core/list` `core/image`
`core/gallery` `core/quote` `core/code` `core/button` `core/separator`
`core/html` `core/group` `core/columns`。**未列出的类型渲染为空字符串**。

## 部署与验证

```bash
npm run theme:deploy themes/<name>   # 登录 → 打包 ZIP → 上传 R2 → 激活
curl -sD- -o /dev/null http://127.0.0.1:8787/en | grep -i cfpress-template
```

`X-CFPress-Template` 头告诉你**实际命中了哪个模板**，这是最快的自检：

| 值 | 含义 |
| --- | --- |
| `home` / `single` / `page` / `archive` / `404` | 正常 |
| `__fallback__` | 主题包没被加载出来（下面第 1 条） |
| `__none__` | 连 `index` 都没有，模板链全空 |
| `index` | 路由没匹配上，回落到了 index |
| `worker:<name>` | 命中了 L3 独立 Worker 主题（不是你的模板主题） |

⚠️ **`deploy-theme` 之后别立刻 `curl` 下结论。** `wrangler dev` 有一个
热重载窗口，此时可能返回**陈旧 Worker stub** 的残留（曾抓到
`worker:storefront` 而实际激活的是 aurora），看起来像「新主题没生效」。
**等 1~3 秒，或连续探测两次都一致**再判定。

## 四个会让「主题不生效」的假象

1. **`__fallback__` 最常见的原因不是 R2 被清空，而是 `theme.active` 设置行缺失。**
   `activeTheme()` 读的是 `setting(env,"theme.active", <兜底>, siteId)`。
   缺失时那个兜底字符串会被**当成主题名**去查 `theme_installs` ——
   而内置 `default` 主题**在 R2 里没有文件**，于是每页渲染成裸壳层。
   `theme.active` 是**按站点**存的（`settings` 表 `site_id` 列），
   某站点从没激活过主题就会缺行。
   **先读库确认，别急着重新 deploy**（重新 deploy 恰好会写这行，所以「deploy 就好了」
   会让人误以为是 R2 问题）：

   ```bash
   # D1 和 R2 各是一个 sqlite 文件，用 node:sqlite 的 DatabaseSync 读（本机常无 sqlite3 CLI）
   # D1:  .wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite
   #      SELECT site_id,value FROM settings WHERE key='theme.active';
   #      SELECT name,version,active FROM theme_installs;
   # R2:  .wrangler/state/v3/r2/miniflare-R2BucketObject/*.sqlite
   #      SELECT key FROM _mf_objects WHERE key LIKE 'extensions/themes/%';
   ```

   **两边必须对照**：`theme_installs` 有行 ≠ 有文件；只有 `_mf_objects`
   里存在 `extensions/themes/<name>/<version>/files/templates/index.html`
   才是真的可渲染。

   ⚠️ 不要用 `theme_installs.active` 排序去猜「哪个主题在用」：
   它是**全局多站点标志**（被任一站点用过就是 1），不是本站在用谁。
   `activeTheme()` 现在的兜底是**真的去 R2 探针** `index.html` 是否存在。

2. **`wrangler dev` 重启后本地 R2 是空的**（第二大原因）。
   同样表现为 `__fallback__`。**这是本地开发的正常现象，不是 bug** ——
   所以「改了模板没生效」「刚才还好好的」先重新 deploy。

3. **缓存 HTML 还在。** 见上面「走 API 播种」。也可以在终端重新
   `PUT` 一次同样的内容来触发 bump。

4. **改的是 `public/` 下的文件却期待主题变化。**
   后台静态资源直接托管、改完即生效；**主题在 R2 里，必须重新部署**。
   两者刷新语义不同，别混淆。

5. **主题路由突然全 404（`/shop`、`/journal` 等），而 `/` 与 `/en` 还活着 ——
   `theme_routes` 表被清空了。** 前台路由**不是**每次从 manifest 解析，
   而是读**持久化的 `theme_routes` 表**（激活时从 manifest 先清后插写入）。
   任何在共享 D1 上激活别的主题的流程（包括测试套件激活自己的测试主题）
   都会把真主题的路由行删掉；若收尾只恢复 `settings.theme.active`，
   路由就悬空了。**症状极具迷惑性**：404 页也算「卡片数 0」，
   `grep -c` 会把它误读成「列表是空的」；而 `/` 撞上内置 home fallback
   返回 200，掩盖了路由丢失。修法是**重新激活主题**（重放声明），
   根治是套件开头快照、结尾恢复（theme_routes / admin_menu_registry /
   site_locales / locales / theme.active 五样一起）。

## 写样式时注意

主题最终被**内联进一个 HTML 响应**（引擎没有资源管线），所以：

- **每个模板自己的 `<style>` 只作用于该页。** 多个页面共用的规则
  （卡片、栅格、按钮）**必须放 `parts/tokens.html` 这类共享片段**，
  否则会出现「首页卡片正常、相关文章卡片巨大」这种 bug ——
  实测踩过：`.arrow` 的尺寸规则只写在 `index.html`，`single.html` 里
  的同一个卡片 SVG 就撑满了整屏。
- **SVG 必须显式给宽高**，`<svg>` 默认 `width:100%` 会撑满容器。
- 令牌用 `oklch()` 成对定义 `:root` / `.dark` 两套；暗色不是反色。
- **`<head>` 里放绘制前主题引导脚本**，否则暗色用户会看到一帧白闪。
  同时设 `document.documentElement.style.colorScheme`，
  让滚动条等原生控件跟着变暗。

## 收尾自检清单

| 项 | 怎么验 |
| --- | --- |
| 每个模板都能渲染 | harness 跑全部模板 + 边界用例 |
| 路由命中正确 | 逐条查 `X-CFPress-Template` |
| 零 JS 错误 | 浏览器 console + `pageerror` |
| 明暗两套都正常 | 截图对比，确认 `--accent` 等令牌真的换了 |
| 不横向溢出 | 遍历元素量 `getBoundingClientRect().width > innerWidth` |
| 移动端断点 | 390 / 768 / 1440 各跑一遍，确认导航折叠、多列变单列 |
| 声明能装得上 | 上传后必须 200；被拒就去读 400 的 `error`，别猜（清单校验是安装期硬门） |
| 语言包 key 带前缀 | `node tests/architecture.test.mjs`（前缀写错这条会红） |
| 自有表真的建了 | 读库 `SELECT name FROM sqlite_master WHERE name LIKE 'theme_<name>_%'`；**单语言站点上不该有 `_i18n` 表** |
| 类型与测试 | `tsc --noEmit`（只 grep `src/`）+ `npm test` |

⚠️ **本机 `npm test` 会整体报 SKIP（`EBUSY`）** —— Windows 沙箱锁 node 二元文件，
**不是失败**。逐个 `node tests/<name>.test.mjs` 才可靠。
⚠️ **`src/` 下旧路径 `src/core/*` 已不存在**：引擎在 `src/rendering/`，平台在 `src/platform/`，
扩展在 `src/extensions/`。照旧路径找文件会找不到。
