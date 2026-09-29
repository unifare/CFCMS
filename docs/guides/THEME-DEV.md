# 主题开发指南

面向要写一个 CFPress 主题的人。先读 [`ARCHITECTURE.md`](../ARCHITECTURE.md) §3.2（前台路由）、
§5.3（清单校验）、§5.5（脚手架）；多语言细节见 [`I18N.md`](I18N.md)。

> **最省力的开始方式**：
> ```bash
> npm run make:theme -- my-shop
> npm run make:table -- my-shop product --fields name:text,price:number,sku:text --write
> npm run theme:deploy -- my-shop
> ```
> 骨架已经是对的（模板语言、语言包前缀、`{{/section}}` 全部正确），你只需要改**内容**。

---

## 1. 一个主题长什么样

```
themes/my-shop/
├── theme.json                 清单（唯一能"出错"的地方，见 §5.3）
├── templates/
│   ├── parts/
│   │   ├── layout.html        布局：提供 `content` 插槽
│   │   ├── header.html
│   │   └── footer.html
│   ├── index.html             首页 / 归档
│   ├── single.html            单篇
│   ├── page.html              页面
│   └── 404.html
└── langs/
    ├── en.json                界面文案（后台用），key 必须带 theme.my-shop. 前缀
    └── zh-CN.json
```

⚠️ `langs/` 是**界面文案**，不是前台内容。前台文字要么写进模板，要么是内容。

---

## 2. 模板语言

### 2.1 输出与转义

| 写法 | 含义 |
|---|---|
| `{{expr}}` | 求值并 **HTML 转义**（默认） |
| `{{{expr}}}` | 求值并**原样输出**——正文 HTML 走这里 |
| `{{! 注释 }}` | 注释，不输出 |
| `{{#if}}` `{{#unless}}` `{{#each}}` | 块 |

### 2.2 五条硬约束（写错都会**静默**出问题）

| # | 规则 | 写错的症状 |
|---|---|---|
| 1 | helper 用 `f(a, b)` **调用**：`{{len(posts)}}` ✅ / `{{len posts}}` ❌ | 抛 `Trailing tokens` → **整页降级成空白壳层** |
| 2 | **不支持 `../`**。`{{#each}}` 内部父级变量**按名字直接可见** | 取到 `undefined`，静默 |
| 3 | `@first` / `@last` / `@index` 绑在**迭代作用域**，不在 item 上。裸写 `{{#if @first}}` | 分支**永不渲染**，静默 |
| 4 | **`{{/section}}` 是必须的** | 布局渲染**空 `<main>`，200、零异常** |
| 5 | `@extends` 的插槽是 `{{@section "content"}}`（不是 `{{@block}}`） | 内容不出现，静默 |

**helper 一共 9 个**：`len` `default` `lower` `upper` `truncate` `join` `number` `date` `contains`。
**没有算术运算符**——需要计算的值让服务端算好（见 §2.5）。

### 2.3 规则 4 详解：最贵的那个坑

引擎要区分一个 `{{@section "x"}}` 是**定义**（子模板，有 body）还是**插槽**（布局，无 body），
判据是**向后扫描有没有配对的 `{{/section}}`**：

```html
<!-- parts/layout.html —— 故意不闭合，它是「插槽」 -->
<main>{{@section "content"}}</main>

<!-- index.html —— 「定义」，必须闭合 -->
{{@extends "parts/layout"}}
{{@section "content"}}
  <h1>{{page.title}}</h1>
{{/section}}
```

漏掉 `{{/section}}` → 子模板的 section 被判成插槽 → 不进 `@sections` → **空白页，HTTP 200，无异常**。

**引擎现在会直接拒绝**这种写法（判据是文件事实：`@extends` 了的文件是子模板，子模板永不提供插槽）：

```
Template @extends "parts/layout" but leaves section(s) unclosed: content
```

### 2.4 上下文里有什么

| 键 | 内容 |
|---|---|
| `site` | `title` `description` `robots` `locale` |
| `page` | `title` `description` `path` `kind` `document_title` |
| `locale` / `locales[]` | 当前语言 / 全部语言（`code` `name` `is_default`） |
| `menu.primary[]` | `title` `url` `target`；`primary_html` 是拼好的 `<a>` |
| `post` | 当前对象（单篇/页面时有）；`post.html` 是**渲染后的正文**，`post.meta` 是自定义字段 |
| `theme` | `name` `version` `title` |
| `posts[]` | 列表页注入的数组 |

`page.document_title` 是**算好的 `<title>` 文本**。模板语言不能比较两个字符串，
所以"别把站名重复两遍"这条规则由服务端做掉了——直接用，别自己拼。

### 2.5 派生值让服务端算

模板里没有算术、没有函数定义、不能比较字符串。所以：

- 价格要显示成 `1,200` → 用 `{{number(price)}}`（有千分位），**不要**自己拼
- 阅读时长、字数统计 → 在模板里算不出来，用 `@query` 拿数据或让插件算
- 条件性 `<title>` → 用 `page.document_title`

### 2.6 `@query`：取内容

```html
{{@query type="post" limit=5 order="created_at desc" as="recent"}}
  {{#each recent as p}}
    <a href="{{p.url}}">{{p.title}}</a>
  {{/each}}
{{/query}}
```

可用参数（**白名单**，模板永远碰不到任意 SQL）：

| 参数 | 说明 |
|---|---|
| `type` | 内容类型，默认 `post` |
| `limit` / `offset` | 默认 10 / 0（上限 100） |
| `order` | `列 方向`，列在 `created_at` `updated_at` `title` `slug` `published_at` 白名单内 |
| `status` | 默认 `published` |
| `slug` / `ids` | 精确取 |
| `exclude_current="true"` | 排除当前对象（"相关文章"用） |
| `as` | 变量名，默认 `results` |

---

## 3. `theme.json` 清单

```jsonc
{
  "name": "my-shop",              // 必须与目录名一致
  "title": "My Shop",
  "version": "0.1.0",             // 语义化版本
  "supports": ["blocks", "menus", "widgets"],
  "templates": ["index", "single", "page", "404"],   // 必须真的有对应文件
  "parts": ["layout", "header", "footer"],
  "locales": ["en", "zh-CN"],     // 声明了就必须有 langs/<locale>.json

  // 前台路由（见 §3.2.2）
  "routes": [
    { "path": "/shop",       "template": "archive-product", "resolve": { "table": "product" }, "query": { "as": "products" } },
    { "path": "/shop/:slug", "template": "single-product",  "resolve": { "table": "product", "by": "slug" } }
  ],

  // 自有表（见 §4）
  "tables": [
    { "name": "product", "label": "Product", "translatable": ["name"],
      "fields": [ { "key": "name", "type": "text", "label": "Name" },
                  { "key": "price", "type": "number", "label": "Price" } ] }
  ],

  // 后台菜单（零后台代码，表单由声明生成）
  "adminMenus": [
    { "id": "product-list", "label": "Products", "icon": "box",
      "screen": "table-list", "args": { "table": "product" } }
  ],

  "settings": [ { "key": "tagline", "label": "Tagline", "type": "text", "default": "" } ]
}
```

### 3.1 清单就是唯一能出错的地方

清单放行的问题会变成**渲染期的报错**，而那个报错指向渲染器、不指向清单——排查成本高一个数量级。
所以校验在**安装时**抛错、让安装失败：**一个装不上的主题胜过半个能跑的主题**。

| 规则 | 内容 |
|---|---|
| `templates[]` | 每个都必须真的有 `templates/<name>.html`（`runtime:"worker"` 豁免） |
| `routes[].template` | 必须**列在 `templates[]` 里**且文件存在 |
| `routes[].resolve` | 必须**恰好**声明 `type` 或 `table` **之一**（都写/都不写都抛错） |
| `routes[].resolve.by` | 只能是 `"slug"` 或 `"id"` |
| `query.as` | 必须是合法**模板作用域名**：`[A-Za-z_$][A-Za-z0-9_$]*`，**不能带连字符** |
| `tables[].translatable` | 每个 key 都必须是该表声明过的字段 |
| 字段名 | 不得用保留列：`id` `site_id` `slug` `lang_group` `status` `created_at` `updated_at` |
| `langs{}` | key 必须带 `theme.my-shop.` 前缀 |

**`query.as` 为什么不能带连字符**：它成为模板里的变量名，而分词器按
`[A-Za-z_$][A-Za-z0-9_$]*` 切标识符。`my-list` 是合法 JS 属性名，但 `{{#each my-list}}`
会被解析成 `my` 减 `list`——引擎没有算术——于是得到一个**谁都读不到**的绑定。

### 3.2 路由：两条约定

1. **单条未命中返回 404**，不是列表页。`/shop/no-such` 应该 404，而不是渲染 `/shop` 的列表。
2. **条目链接来自路由自己的路径**，不是 `/blog/`。`/shop/:slug` 的条目应链到 `/shop/<slug>`。

---

## 4. 主题自有表

主题可以声明自己的表，**不写任何 SQL，不写任何后台代码**：

```jsonc
"tables": [{ "name": "product", "translatable": ["name"], "fields": [...] }],
"adminMenus": [{ "id": "product-list", "label": "Products", "screen": "table-list", "args": { "table": "product" } }]
```

平台会：

1. 生成 `CREATE TABLE theme_my_shop_product`（名字由平台生成，**不要硬编码**）
2. 在 `theme_table_defs` 登记 `product → theme_my_shop_product`
3. 生成后台列表 / 编辑表单（**列来自 `fields[]`，控件来自 `field.type`**）

**两半必须同时声明**：只声明表 → 后台没有入口；只声明菜单 → 安装被拒（"引用了未声明的表"）。
`npm run make:table` 一次把两半都加上，就是因为这个。

**建表发生在「激活主题」时**（`applyThemeCapabilities` → `syncThemeTables`），
DDL 由平台生成、`CREATE TABLE IF NOT EXISTS` 保证幂等。
`_i18n` 伴生表**只有当本站提供多于一种语言时**才建。

### 字段类型只有 6 种

`text` `longtext` `number` `boolean` `date` `datetime`

比内容类型的自定义字段（13 种，含 `media` / `select` / `color`）少得多，
因为**每个类型必须有恰好一个后台控件**——表单是**从声明生成的**，
一个没有控件的类型会渲染成空输入框，看起来像数据问题。

### `translatable` 怎么划

- **要**：`name` `description` `title` —— 内容性文字
- **不要**：`price` `sku` `stock` —— **数字与标识符**

一个"翻译了价格"的商店，会在不同语言下**收不同的钱**。

读写走后端 facade：`tableList` / `tableBySlug` / `tableById` / `tableSave` / `tableDelete`。
**主题不得直接写 SQL**（架构测试会拦）。可翻译字段的读写规则见 [`I18N.md`](I18N.md) §3.4–§3.5。

### 手动操作

```bash
curl "$BASE/api/v1/theme-tables/product?locale=zh-CN" -b cookies.txt          # 列表
curl "$BASE/api/v1/theme-tables/product/oak-desk" -b cookies.txt             # 单条
curl -X POST "$BASE/api/v1/theme-tables/product?locale=zh-CN" \
     -b cookies.txt -H 'content-type: application/json' \
     -d '{"slug":"oak-desk","name":"橡木书桌","price":1200}'                  # 保存
```

⚠️ 建表在**激活主题**时完成。改了 `tables[]` 之后要**重新激活**才会同步新字段
（`syncThemeTables` 只 `ADD COLUMN`，从不删列——见 `I18N.md` §3.3）。

---

## 5. 多语言主题

1. **声明语言**：`"locales": ["en", "zh-CN"]`，并为每个语言提供 `langs/<locale>.json`
2. **用 `locale` 变量**拼链接，别硬编码：`href="/{{locale}}/shop"`
3. **可翻译字段**列进 `tables[].translatable`
4. **显式语言未命中返回 404**，不回退（`I18N.md` §2）

---

## 6. 本地开发与调试

```bash
npm run make:theme -- my-shop          # 生成骨架
npm run theme:deploy -- my-shop        # 上传文件到本地 R2
npx wrangler dev                       # 起服务
```

### 出问题时先看这个表

| 症状 | 成因（优先查上面那个） |
|---|---|
| 页面**空白但页头页脚都在** | **`{{/section}}` 没闭合**；或 helper 用了 `{{len posts}}` |
| 页面完全是另一种外壳 | `__fallback__`：① **`theme.active` 设置行缺失**（更隐蔽）② 本地 R2 是空的（`wrangler dev` 重启后）→ 先 `npm run theme:deploy` |
| `__fallback__` 但文件明明在 | **URL 少了 locale 前缀**（`/` 返回的是后台外壳） |
| 主题"激活了"但没生效 | `theme_installs` 有行 ≠ R2 里有文件，**两边对照** |
| 改样式没反应 | 主题从 R2 读，改完要**重新 upload** |

**响应头 `X-CFPress-Template` 就是答案**：它告诉你**实际选中了哪个模板**。

```bash
curl -sI "$BASE/en" | grep -i x-cfpress-template
```

解析顺序由 `template-resolver.ts` 决定；`routes[].template` **优先级最高**。

### 读库不要猜

```js
// node:sqlite 的 DatabaseSync
// D1: .wrangler/state/v3/d1/<db>/*.sqlite
// R2: .wrangler/state/v3/r2/<bucket>/*.sqlite  → 表 _mf_objects
```

---

## 7. 上线前自检

```bash
npx tsc --noEmit                 # 若有 worker 运行时主题
node tests/suites/scaffold.test.mjs     # 生成器与模板形状
node tests/suites/theme-fixture.test.mjs # 真主题渲染快照
```

手动过一遍：

1. `/` 与 `/zh-CN` 都能渲染，且 `X-CFPress-Template` 是你期望的那个
2. 一条**不存在的**路径 → 404（不是列表页）
3. 路由条目的链接指向**路由自己的路径**
4. 后台"外观"里能看到主题设置
5. 用 `zshop`/`theme.json` 里的语言包 key 前缀检查一遍（`theme.my-shop.`）

---

## 8. Worker 运行时主题（进阶）

需要真正的服务端逻辑（外部 API、复杂计算）时，用 `runtime: "worker"` + `entry` 指向一个文件：

```jsonc
{ "runtime": "worker", "entry": "worker.js", "capabilities": ["content.read", "site.read"] }
```

平台把该文件部署成一个 Worker，通过 `WorkerStub` 调用。可用的宿主能力见 `THEME_API_CAPABILITIES`。
**能声明式解决的就别用 worker**——声明式主题零部署、零沙箱、零冷启动。

参考实现：`themes/storefront/`。
