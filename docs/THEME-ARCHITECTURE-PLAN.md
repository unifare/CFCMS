# CFPress 主题架构改造方案

> 目标：把主题从「4 个 HTML 文件 + 6 个占位符」升级为 **WordPress 级主题 = 完整业务包**，
> 主题内可写任意 JS 逻辑、自带 CPT / 自定义字段 / 路由 / 后台菜单 / 区块。

> ### ⚠️ 这是一份**历史方案**，不是当前状态
>
> 本文的批次 1–6（模板引擎 → 主题业务能力 → 示例主题 → 多站点 → 插件 hook → L3 沙箱）
> **已全部完成**，因此文中「现状诊断」里列的问题都已不复存在。
> **当前架构与进度看 [`ARCHITECTURE.md`](ARCHITECTURE.md)**（多语言 §2、防错 §5、
> 路线图与批次 1–4 的真实进度 §8）；**改代码的硬规则看 [`../AGENTS.md`](../AGENTS.md)**。
>
> 两点阅读提示：
> 1. 文中出现的 `src/core/*` 路径**已不存在**——批次 1 的分层重构把 `src/` 拆成了
>    `shared/` / `platform/` / `rendering/` / `extensions/`。
> 2. 本文的「批次 N」是**主题改造的批次**，与 `ARCHITECTURE.md` §8 的
>    「批次 1–4」（架构防错 / 多语言 / 后台菜单 / 脚手架）**编号不同、不要混淆**。
>
> 保留本文的价值在于**设计理由**：为什么 Workers 上不能跑任意 JS、为什么选
> 「声明式 + 独立 Worker」两层形态、为什么 `translatable` 要显式声明。
> 这些论证仍然是当前实现的依据。

---

## 0. 现状诊断（实测结论）

| 维度 | 现状 | 证据 |
|---|---|---|
| 模板能力 | 6 个占位符 `replaceAll` | `src/core/theme-templates.ts:21-27` |
| 条件/循环 | 无 | 同上 |
| 模板继承 | 无（硬编码 index/single/page/404） | `getTemplate()` L9-20 |
| manifest.templates | **装饰性，代码不读** | `themes/default/theme.json:6` vs 代码只认 4 个名字 |
| manifest.parts | **装饰性，代码不读** | 同上 L7 |
| 主题注册路由 | 无 | `src/index.ts:17` 硬编码 `/^\/[a-z]{2}.../` |
| 主题注册 CPT | 无（`posts.type` 只有 post/page） | `src/api.ts` listPosts/savePost |
| 主题执行代码 | **禁止**（安全设计） | README L32，`extensions.ts` 无 eval/import |
| 插件 hook | 有注册表但**从未被安装包调用** | `addAction/addFilter` 无任何外部调用点 |
| 后台菜单 | 硬编码 15 个 | `public/admin/admin.js:14` |

**核心矛盾**：项目的其他部分（角色矩阵、多版本、定时发布、搜索、修订）都做得不错，
唯独主题层是「静态占位符替换」，而 manifest 里却已经声明了 WordPress 式的
`templates` / `parts` 字段——**声明与实现脱节**。这就是"主题不符合要求"的根因。

---

## 1. 三条你必须先知道的硬约束

### 约束 A：Cloudflare Workers 不能执行动态代码

Workers 禁用 `eval` / `new Function` / 动态 `import()` 用户代码。这是 V8 isolate 的平台限制，
不是本项目的偷懒。`README.md:32` 已经明说："Uploaded extension JavaScript is **not executed in
the main Worker**. This is intentional."

**结论**：在当前 `wrangler.jsonc` 的**单 Worker** 形态下，"主题里写任意 JS 并在主进程执行"
**物理上做不到**。必须改变运行时形态才能实现。

### 约束 B：D1 是 SQLite，schema 变更必须走 migration

代码量为零的 schema 改动也要新增 `migrations/0008_*.sql`，不能只改代码。

### 约束 C：主题是"数据"，不是"代码"

现在主题上传后存到 R2：
```
extensions/themes/{name}/{version}/files/templates/*.html
extensions/themes/{name}/{version}/files/*.css|js
```
JS 被存下来但从不执行。改造后要么执行它（需要 B 之外的沙箱），要么把它喂给模板引擎
当 DSL 解释（约束 A 下唯一安全解）。

---

## 2. 全自由度 JS 主题的三个实现选项

你选了「主题里能写任意 JS 并在运行时执行」。在 Cloudflare 生态里，真正能做到这一点的
只有三条路，**代价差异极大**：

### 选项 1：Cloudflare Worker Loader / Dynamic Worker（`worker_loaders` binding）

Workers 提供动态加载并隔离执行用户 JS 的能力：主 Worker 把主题代码作为新模块注入一个
独立 isolate，通过 RPC 调用，**isolate 级隔离**，崩溃/死循环不会拖垮主站，且有 CPU 限制。

- **能实现你要的全部**：主题写任意 JS、注册路由、CPT、后台菜单
- **代价**：需要 Worker Loader binding（可能要付费 plan / beta 白名单）；主-子 Worker 间只能传
  **结构化可序列化数据**（不能传 Request/DB 句柄，必须用 RPC 包装）
- **风险**：API 较新，稳定性与配额需实测

### 选项 2：Service Binding 多 Worker —— 一个主题 = 一个 Worker

把"主题"做成独立 Worker，通过 `service binding` 挂到主站。主题 Worker 自己
`export default { fetch }`，主站把 `/xx/*` 转发过去。

- **能实现你要的全部**，且隔离最干净、是 Cloudflare 的**官方正统做法**
- **代价**：主题不再是"上传 ZIP 就生效"，而是"部署一个 Worker"；需要改造 CLI / 部署流程；
  D1/R2/KV binding 要显式共享给主题 Worker
- **最接近 WordPress 的"主题是完整业务包"语义**

### 选项 3：换运行时（Node / VPS）

跑真正的 `import()` 或 `vm` 沙箱，甚至直接跑 PHP。

- **自由度最高**，但**等于放弃 Cloudflare 技术栈**，前期所有工作（D1/R2/KV/Cron/Static Assets）
  都要重写或桥接

### 选项 4（不推荐，但要知道）：模板 DSL 解释器

不是"任意 JS"，而是我在 Workers 内实现一个安全的模板语言（if/each/include/继承/query）。
**在约束 A 下唯一能"上传 ZIP 即生效"的方案**，但主题不能说"任意 JS"。

---

## 3. 推荐路线：分层架构（选项 2 为主，选项 4 为辅）

务实做法不是二选一，而是**分层**——让 80% 的主题需求用安全方式解决，
只有真的需要任意 JS 的主题才付"部署 Worker"的成本。

```
┌─────────────────────────────────────────────────────────┐
│  L1 声明式模板层（安全，上传即生效）                        │
│  · 模板继承：single-{type} → single → index              │
│  · 条件 / 循环 / include / 自定义字段 / query 文章         │
│  · 主题带 CSS/静态资源                                     │
│  → 覆盖大多数"换外观 + 简单业务"的需求                      │
├─────────────────────────────────────────────────────────┤
│  L2 声明式业务层（主题 manifest 声明，运行时落实）            │
│  · postTypes   自定义文章类型（CPT）                       │
│  · taxonomies  分类法                                     │
│  · fields      自定义字段 schema                          │
│  · routes      前端路由（/xx/:slug）                      │
│  · adminMenus  后台菜单                                   │
│  · blocks      主题自带区块                               │
│  → 这就是你要的"主题 = 完整业务包"                          │
├─────────────────────────────────────────────────────────┤
│  L3 代码执行层（可选，主题 = 独立 Worker）                  │
│  · 只有需要任意 JS 的主题才走这条路                         │
│  · service binding 挂载，自带隔离                          │
│  → 真正的"全自由度 JS 主题"                                │
└─────────────────────────────────────────────────────────┘
```

**为什么这样分**：WordPress 主题 99% 的代码是模板 + 数据查询 + 字段展示，
L1+L2 就能覆盖。真正需要"任意 JS"的（比如主题带一个实时地图、一个支付流程）
本来就该是独立进程——这也正是 Cloudflare 的模型比 monolith PHP 更安全的地方。

---

## 4. L1 详细设计：模板引擎

### 4.1 语法草案

```html
<!-- 模板继承 -->
{{@extends "base"}}
{{@section "content"}}

  <!-- 条件 -->
  {{#if post.type == "product"}}
    <span class="price">{{post.meta.price}}</span>
  {{else}}
    <span>{{post.excerpt}}</span>
  {{/if}}

  <!-- 循环 -->
  {{#each posts}}
    <article>
      <a href="/{{locale}}/blog/{{this.slug}}">{{this.title}}</a>
      <!-- 嵌套循环 + 自定义字段 -->
      {{#each this.terms.category}}
        <em>{{this.name}}</em>
      {{/each}}
    </article>
  {{/each}}

  <!-- 引入 partial -->
  {{@include "parts/card"}}

  <!-- 数据查询（受控，不是任意 SQL） -->
  {{@query type="product" limit=6 order="created_at desc" as="products"}}
    ...products 可用...
  {{/query}}

  <!-- 语言切换 / 菜单 / 站点信息 保持现有占位符 -->
  {{site.title}} {{menu.primary}} {{locale}}

{{/section}}
```

### 4.2 模板层级解析（WordPress 式）

按优先级**从上到下取第一个存在的文件**：

| 页面类型 | 解析顺序 |
|---|---|
| 首页 | `front-page.html` → `home.html` → `index.html` |
| 单篇 post | `single-post-{slug}.html` → `single-post.html` → `single.html` → `index.html` |
| 单篇 CPT `product` | `single-product-{slug}.html` → `single-product.html` → `single.html` → `index.html` |
| 单页 page | `page-{slug}.html` → `page.html` → `single.html` → `index.html` |
| 归档(按 CPT) | `archive-product.html` → `archive.html` → `index.html` |
| 分类 | `category-{slug}.html` → `category.html` → `archive.html` → `index.html` |
| 搜索 | `search.html` → `archive.html` → `index.html` |
| 404 | `404.html` → `index.html` |

### 4.3 实现文件

- 新增 `src/core/template-engine.ts` —— 词法/语法解析 + 渲染（纯函数，零依赖）
- 新增 `src/core/template-resolver.ts` —— 层级解析 + 缓存
- 改写 `src/core/theme-templates.ts` —— 从"replaceAll"变为"引擎渲染"
- 保留 `src/core/frontend.ts` 的 `renderPage` 作为引擎失败时的**降级渲染**

### 4.4 缓存策略

模板编译结果缓存到 `CACHE` (KV)：
```
tpl:{theme}:{version}:{template}:{mtime} → 编译后 AST
```
主题更新时按 `{name}/{version}` 前缀整体失效。渲染结果沿用现有 60s 公共缓存。

---

## 5. L2 详细设计：主题 = 业务包

### 5.1 theme.json 扩展 schema

```jsonc
{
  "name": "realestate",
  "title": "Real Estate",
  "version": "1.0.0",

  // 已有字段，改造后真正生效
  "templates": ["index","home","single","archive","search","404"],
  "parts": ["header","footer","sidebar"],

  // 新增：自定义文章类型
  "postTypes": [
    {
      "name": "property",
      "label": "Property",
      "labels": { "singular": "Property", "plural": "Properties" },
      "supports": ["title","editor","excerpt","thumbnail","custom-fields"],
      "hasArchive": true,
      "rewrite": { "slug": "properties" }
    }
  ],

  // 新增：分类法
  "taxonomies": [
    { "name": "city", "label": "City", "postTypes": ["property"], "hierarchical": true }
  ],

  // 新增：自定义字段
  "fields": [
    { "key": "price", "label": "Price", "type": "number", "postTypes": ["property"], "required": true },
    { "key": "area",  "label": "Area",  "type": "number", "postTypes": ["property"] },
    { "key": "gallery", "label": "Gallery", "type": "media-multiple", "postTypes": ["property"] }
  ],

  // 新增：前端路由
  "routes": [
    { "path": "/properties", "template": "archive-property", "query": { "type": "property" } },
    { "path": "/properties/:slug", "template": "single-property", "resolve": { "type": "property", "by": "slug" } }
  ],

  // 新增：后台菜单
  "adminMenus": [
    { "id": "properties", "label": "Properties", "icon": "home", "screen": "content-list", "args": { "type": "property" } },
    { "id": "theme-settings", "label": "Theme Options", "screen": "theme-settings" }
  ],

  // 新增：主题自带区块
  "blocks": [
    { "name": "theme/property-card", "title": "Property Card", "template": "blocks/property-card.html" }
  ],

  // 新增：主题设置项（后台可视化编辑）
  "settings": [
    { "key": "accent", "label": "Accent color", "type": "color", "default": "#0b5fff" },
    { "key": "hero_image", "label": "Hero image", "type": "media", "default": "" }
  ],

  // 新增：主题声明需要的运行时能力
  "capabilities": ["content.read", "content.write", "media.read", "routes.register", "admin.register"],
  "settingsSchema": { /* 同上方 settings */ }
}
```

### 5.2 运行时落实点

| manifest 字段 | 落点 | 改动文件 |
|---|---|---|
| `postTypes` | 写入 `post_types` 表；`listPosts`/`savePost` 支持任意 type | `api.ts` (listPosts/savePost 已支持 kind 参数) |
| `taxonomies` | 新增 `taxonomies` / `term_relationships` 表 | migration |
| `fields` | 新增 `post_meta` 表；编辑器和前端可读 | `api.ts` + `admin.js` |
| `routes` | 路由表写 KV，`index.ts` 前置匹配，转发到主题模板 | `index.ts` + 新 `route-resolver.ts` |
| `adminMenus` | API 返回菜单，`admin.js` 动态渲染替代硬编码 | `api.ts` + `admin.js` |
| `blocks` | 区块注册表 += 主题区块，`renderBlocks` 支持模板 | `blocks.ts` + `frontend.ts` |
| `settings` | 复用现有 `plugin_setting_defs` 模式 → 新增 `theme_setting_defs` | migration + `api.ts` |

### 5.3 关键：主题切换 = 业务切换

激活主题时：
1. 从新主题 manifest 生成 CPT / taxonomy / fields / routes / menus（写库）
2. **旧主题声明的 CPT 数据保留但隐藏**（不删数据，避免不可逆丢失）
3. 标记 `belongs_to_theme` 字段，切回旧主题时恢复可见

这是 WordPress 没有做好的地方（换主题数据就丢），我们做对。

---

## 6. L3 详细设计：主题 = 独立 Worker（全自由度 JS）

只有当主题需要"任意 JS 逻辑"时才启用。

### 6.1 形态

```
主 Worker (cfpress)                    主题 Worker (cfpress-theme-realestate)
  /api/*                                  export default { fetch(req, env, ctx) }
  /media/*
  /admin/*                          ←── service binding ──→  /properties/*
  /{locale}/{theme-route}                 /properties/:slug
                                          主题自己的 D1 查询 / R2 / KV
```

主题 Worker 自己实现路由、渲染、甚至可以有自己的 HTML 模板引擎，
主站只负责把匹配到的路径转发过去。

### 6.2 需要改的东西

- `wrangler.jsonc` 增加 `services` binding 声明（每个主题一个，或用一个总主题 Worker 内部分发）
- 主题包新增 `worker.js` 入口 + `theme.json` 里 `"runtime": "worker"`
- 部署流程：主题不再是纯上传，需要 `wrangler deploy`（CLI 或一键脚本）
- 数据共享：主题 Worker 通过 binding 拿到同一个 D1/R2/KV（或独立库）

### 6.3 与 L2 的关系

L2 主题可以直接跳过 L3。L3 是 L2 的**超集**——L3 主题可以同时用 L1 模板引擎
渲染静态部分，只把需要算力的路由交给自己的 JS。

---

## 7. 改造工作量清单（进度）

### 批次 1 —— 模板引擎骨架（L1）· 已完成
- [x] `src/core/template-engine.ts` 引擎实现（if/each/include/extends/section/query）
- [x] `src/core/template-resolver.ts` 层级解析
- [x] 改写 `theme-templates.ts` 接入引擎
- [x] `index.ts` 路由接入层级解析
- [x] **删除** `renderPage` 硬编码渲染（决策 4）
- [x] 单测：47 条（语法/转义/循环/继承/查询/安全/布局语义）

### 批次 2 —— 主题业务能力（L2）· 已完成
- [x] `migrations/0008_v080_theme_business.sql`（post_types/taxonomies/terms/post_meta/theme_routes/theme_admin_menus/theme_blocks/theme_setting_defs）
- [x] `theme.json` schema 扩展 + `validateManifest` 校验
- [x] 主题激活时生成业务结构 + 数据归属标记（切换主题＝隐藏而非删除）
- [x] CPT 打通 `listPosts`/`savePost`/前端路由（`/{locale}/{rewrite}/{slug}` 与 `/{locale}/{rewrite}` 归档）
- [x] 自定义字段 API + 编辑器 UI（`post_meta` 白名单写入）
- [x] 动态后台菜单 API + `admin.js` 渲染（CPT 导航 + 主题设置页）
- [x] 主题区块注册
- [x] 集成测试：40 条（ZIP 上传 → 校验 → 激活 → 落库 → 层级解析 → 渲染 → HTTP 响应）

### 批次 3 —— 示例主题（验证 L1+L2）· 已完成（以测试主题验证）
- [x] 测试主题 `realestate`：1 CPT + 2 自定义字段 + 2 路由 + 2 后台菜单 + 1 区块 + 完整继承层级
- [x] 跑通"装完即整套业务可用"

### 批次 4 —— 多站点支持 · 已完成
- [x] `migrations/0009_v080_multisite.sql`：`sites` 表、menus/menu_items/media 加 `site_id`、
      按 `(site_id, id)` 重建主键（SQLite 不能就地删 UNIQUE，必须重建表）
- [x] `src/core/sites.ts`：按 **路径前缀（最长优先）→ host → 默认站** 解析 `siteId`
- [x] 全链路贯穿 `site_id`：`api.ts` / `frontend.ts` / `cache.ts` / `scheduler.ts` / `index.ts`
- [x] 缓存按站点分代（`cfpress:html:{site}:{version}:{path}`），站点间互不失效
- [x] 主题激活改为**按站点**（`theme.active` 设置表为唯一事实源，`theme_installs.active` 不再决定路由）
- [x] 声明表合成主键加站点前缀，避免跨站 UNIQUE 冲突
- [x] 站点 CRUD API + 后台站点切换器
- [x] 多站点测试：63 条；后台契约测试：32 条

### 批次 5 —— 插件 hook 补齐（✅ 已完成）
- [x] `bootPluginRuntime(env)`：读 `plugin_installs WHERE enabled=1`，把 manifest 声明的 hook 挂到注册表
- [x] 只注册**宿主真正实现了**的 hook（未知名字忽略，而不是假装修好）
- [x] `ctx.api` 能力门面注入每个 hook，权限按 manifest 声明执行
- [x] 6 个真实调用点：`beforeRender`(action) / `html`(filter) / `beforeSavePost`(filter) / `afterSavePost`(action) / `beforeDeletePost`(action) / `shortcode`(filter)
- [x] `renderShortcodes` 真正接进渲染管线（此前是被 import 但从不调用的死代码）
- [x] enable/disable 后 `resetPluginRuntime()` 重建注册表，立即生效
- [x] 插件抛异常绝不拖垮请求（每个 stage 独立 try/catch）
- [x] `extensions/plugins` GET 增加 `hooks_wired` 字段，后台可见实际挂载情况
- [x] 插件 hook 测试：25 条

### 批次 6 —— L3 主题沙箱

#### 6.0 Worker Loader 可行性实测（✅ 已完成，结论明确）

在独立探针 Worker（`worker_loaders: [{binding:"LOADER"}]`）上实测了 12 项能力。
**结论：Worker Loader 在本地 `wrangler dev` 完全可用，L3 不需要退到 Service Binding。**

| 探测项 | 结果 | 对 L3 的设计含义 |
|---|---|---|
| Loader binding 可用 | ✅ | 不必退到 Service Binding |
| 内联 JS 模块加载执行 | ✅ 返回正确的 body 与响应头 | 主题代码（R2 取出即字符串）可直接 `load()` |
| 自定义 `env` 注入（纯值） | ✅ `string/number/bool/array/object/null` 全部通过 | 主题配置、站点信息可直传 |
| **KV / D1 / R2 绑定直传** | ❌ `A KV namespace binding cannot be serialized.` | **绑定不可直传**，数据必须走别的路 |
| **Fetcher（service binding）透传** | ✅ 子 Worker 成功回调宿主并读到 JSON | **数据通路 = 回调宿主 API** |
| 网络隔离 `globalOutbound: null` | ✅ `This worker is not permitted to access...` | 可真正切断主题的外网访问 |
| 子 Worker 抛异常 | ⚠️ **异常冒泡到宿主** | 宿主**必须**包 try/catch（同批次 5 原则） |
| 模块语法错误 | ⚠️ `load()` 不抛，**首次 fetch 才炸** | **必须预热校验**，否则每请求吃一次失败 |
| `env` 隔离 | ✅ 默认 `{}`，不继承宿主绑定 | 必须显式注入，天然最小权限 |
| 模块级状态 | ✅ 每个 stub 各自独立（`n=1`） | 主题之间天然隔离 |
| `limits.cpuMs` | ⚠️ 本地**不强制**（死循环跑完） | 只用于生产防护，本地别指望 |
| `getEntrypoint(name)` 命名入口 | ❌ `internal error` | 统一走**默认导出** |
| **`WorkerStub` 跨请求复用** | ❌ `Cannot perform I/O on behalf of a different request. (I/O type: WorkerStubChannel)` | **stub 绝不可缓存**，见下方第 3 条 |

**三条硬结论**：

1. **数据通路是"回调宿主 API"，不是"共享绑定"。** 这是整个 L3 架构的支点 ——
   宿主向主题 Worker 传入一个 Fetcher（指向自身或专用内部 API），主题通过
   `env.HOST.fetch(...)` 读取内容。权限边界就是**这个 API 暴露了哪些端点**，
   而不是"注入了哪些绑定"。这比共享 D1 更安全，也更可控。
2. **`load()` 的失败是延迟的。** 语法错误要到第一次 `fetch` 才暴露，所以必须有
   **预热校验**（加载后立即打一次探针请求）才能确认主题真的可用。
3. **`WorkerStub` 是"请求作用域"的，绝不能跨请求缓存。** stub 内部持有
   `WorkerStubChannel` 这个 I/O 对象，它绑定在**创建它的那个请求上下文**上。
   缓存 stub 的后果是：第 1 个请求正常渲染，第 2 个及以后全部抛上面那条
   I/O 错误，然后被 try/catch 吞掉、静默降级回声明式渲染器 —— **看起来能用，
   实际半坏**，比直接 500 更难发现。

   **正确做法**：缓存 R2 里的**源码字符串**（纯值，可安全共享），每次请求在
   当前上下文里重新 `loader.load()`。`load()` 很便宜 —— 源码逐字节相同时
   workerd 会复用已编译的 isolate，所以这个开销接近于零。实测：每页 1 次
   `load()`，20 次混合请求 worker 命中 20/20。

   > 这个坑值得单独记一笔：它**不会**在单请求测试里暴露，所以回归测试必须
   > 用**同一个 env 连续发多次请求**（见 `tests/theme-worker.test.mjs` 第 9 节，
   > 该节会主动递增假请求上下文来模拟真实的请求边界）。

- [x] Worker Loader 可行性实测（本地完全可用）
- [x] 结论：**不走 Service Binding**，走 Worker Loader + Fetcher 回调
- [x] 主题 Worker 模板（`export default { fetch(req, env) }`，env 含 `HOST` Fetcher）
- [x] 宿主侧：`theme-worker-runtime.ts`（load + 预热校验 + try/catch 降级）
- [x] 内部数据 API（`/__cfpress/theme-api/*`，按主题能力授权）
- [x] stub 跨请求复用的坑（改为缓存源码、每请求重新 `load()`）
- [x] manifest `runtime: "worker"` 的分发与部署脚本（`npm run theme:deploy`）
- [ ] 文档：把上面的能力边界表写进开发者指南

---

## 8. 遗留问题（已决策）

1. **主题包分发形态**：L3 可以走部署流程（决策：允许 CLI/部署，不要求"上传 ZIP 即部署"）
2. **数据归属**：换主题时旧 CPT 数据**隐藏保留**，不随主题卸载删除
3. **多站点**：**支持**（批次 4 已完成）
4. **是否保留 `renderPage`**：**删除**（已删）

---

## 9. 我的判断（已验证）

- **L1 + L2 是必须做的** —— 已落地，测试 87 条通过
- **多站点可以后置但必须一开始就贯穿 `site_id`** —— 否则后期回填成本极高；批次 4 已证明这一点：
  真正难的不是加表，而是把 `site_id='default'` 从数据访问层彻底清除
- **L3 值得做但成本高**，建议在 L1+L2 稳定运行后再上
- **不要为了"任意 JS"放弃 Cloudflare**

### 实测发现的两个反直觉点

1. **`theme_installs.active` 不能作为"当前主题"**：它是全局单值，多站点下必然错乱。
   正确做法是只认 `settings.theme.active`（按站点），`active` 列降级为"是否被任意站点使用"。
2. **声明表的合成主键必须内嵌站点**：`field_defs.id = field_{key}` 这种写法在两个站点声明同名
   字段时会直接 UNIQUE 冲突。凡是"自然键是 per-site、主键是全局"的表都要重建或加前缀。

---

## 10. 验证方式

```bash
npx tsc --noEmit          # 0 errors in src/
npm test                  # 47 + 40 + 63 + 32 = 182 条全通过
```

测试直接驱动**真实 Worker 源码**（esbuild 打包）对着**真实本地 D1**（`node:sqlite`）运行，
R2/KV 用内存实现替身。四套件共享同一个 D1，因此按顺序运行本身就是在验证
"套件之间没有状态污染"。

