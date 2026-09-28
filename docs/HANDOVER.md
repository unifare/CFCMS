# CFPress (CFCMS) 交接文档

> 更新时间：2026-09-28 21:00 (GMT+8) ｜ 交接基线：**本轮提交**
> （`Split the admin SPA into modules + contract tests`；上一轮为 `265d03c`）
> 读者：接下来接手本项目的开发者或 AI 会话。**先读本文，再读 `docs/ARCHITECTURE.md`，改代码前读 `AGENTS.md`。**

---

## 1. 项目是什么

**CFPress / CFCMS** — 跑在 Cloudflare 全家桶上的 WordPress 式 CMS：

| 组件 | 用途 |
|---|---|
| Workers | 全部服务端逻辑（无 Node 服务器） |
| D1 (SQLite) | 内容与配置 |
| R2 | 主题模板包、媒体、扩展 zip |
| KV | 会话、缓存 |
| Static Assets | 后台 SPA（`public/admin/`） |

- 仓库：`https://github.com/unifare/CFCMS`（public，分支 `main`，许可证 AGPL-3.0）
- 版本：v0.7.0 → 目标 v0.8.0（主题架构改造）
- 参照物：WordPress 的主题/插件模型；多站 similar 到 WP multisite

## 2. 三次提交的脉络

```
6b09051  CFCMS v0.7.0 — 初始代码
1aeffa2  Add AGPL-3.0 license
265d03c  Layer src/ into shared/platform/rendering/extensions + enforce architecture
03ae88d  Add handover document
????????  Split the admin SPA into modules + contract tests   ← 当前 HEAD
```

`265d03c` 是上一轮大改：**目录分层 + 架构红线机器强制 + 运行时清单校验**，
37 文件、+2827/−122。细节见 `docs/ARCHITECTURE.md` §7–§8。

本轮（最后一个 commit）把 `public/admin/admin.js` 从 1514 行单文件拆成
入口 + 4 个基础模块 + 18 个屏幕模块，并新增 `tests/admin-spa.test.mjs`。
**纯前端重构，`src/` 一行未动**——分层与它正交。

## 3. 源码布局（分层已落地，旧路径 `src/core/*` 已不存在）

```
src/
├── index.ts                  前端路由：站点解析 → SEO → 主题路由 → CPT → 页面 → 404
├── api.ts                    管理 API（全部按站点；manifest 校验在安装路径上）
├── shared/                   叶子层：types crypto repo cache scheduler（不 import 任何业务层）
├── platform/                 auth permissions sites frontend seo revisions（不认识扩展）
├── rendering/                template-engine template-resolver blocks（纯渲染）
└── extensions/
    ├── contract/hooks.ts     依赖倒置契约：HostHooks + NULL_HOOKS + 注入槽
    ├── security.ts           validateManifest —— 安装边界校验，失败必须抛错
    ├── theme/                runtime-declarative runtime-worker capabilities templates
    └── plugin/               runtime（hook 注册表 + 装配 + 能力门面）
```

**四条红线（`tests/architecture.test.mjs` 机器强制，11 组检查）：**
1. `shared/` 不 import 任何业务层
2. `platform/` 不 import `extensions/`
3. `rendering/` 不 import `extensions/`
4. `extensions/theme/` 与 `extensions/plugin/` **互不 import**（主题调插件走 `contract/hooks.ts` 依赖倒置，`index.ts` boot 时 `setHostHooks(...)` 注入）

**数据红线：** `siteId` 必须贯穿所有数据访问函数，**默认值零容忍**
（字符串形式 `siteId = "default"` 和常量形式 `siteId = DEFAULT_SITE_ID` 都算违规，架构测试会 FAIL）。

## 4. 六个已确认的架构决策（§9，全部选项 A，不要再当"待确认"）

1. **slug 跨语言唯一** —— 唯一索引 `UNIQUE(site_id, type, slug)`，不含 locale
2. **主题自有表只支持基础类型** —— `text/longtext/number/boolean/date/datetime`
3. **插件也可声明自有表** —— 与主题同机制，表名 `plugin_{slug}_{table}`
4. **删 `theme_admin_menus`** —— 合并为统一 `admin_menu_registry`（迁移时 drop 旧表）
5. **目录重整先做** —— ✅ 已完成
6. **界面语言本期做** —— 后台 UI 语言与内容语言独立

## 5. 进度总览（路线图见 `docs/ARCHITECTURE.md` §8）

### 批次 1（架构防错）—— ✅ 全部完成

| 项 | 状态 |
|---|---|
| `src/` 目录分层重整（19 个平铺文件归位） | ✅ |
| 架构测试 11 组检查 + 8 项反向验证（注入违规必须 FAIL） | ✅ |
| `siteId`/`locale` 默认值清零（26 字符串 + 6 常量形式） | ✅ |
| 运行时 `validateManifest`（安装返回 400，不再只是测试端强制） | ✅ |
| 新套件 `manifest-validation`（33 条断言，逐条注入缺陷→断言拒绝） | ✅ |
| 依赖倒置 `theme↔plugin`（`contract/hooks.ts`） | ✅ |
| 多站点 SEO bug 修复（sitemap/robots 曾对所有域名返回默认站内容） | ✅ |
| 修复两个**从未生效**的守卫（默认值正则漏常量形式；跨层检查文本匹配落空） | ✅ |
| **后台 JS 拆分**（`admin.js` 1514 行 → 入口 + 22 个新模块） | ✅ **本轮完成**（见 §7） |

### 批次 2（多语言四层 L0/L1/L2/L3）—— 未开始
迁移 `0011_i18n.sql` → `src/platform/i18n/` 四模块 → 界面语言注入 → 翻译组 CRUD → 契约测试。
验收要点：只启用 zh-CN 时主题自有表**不建** `_i18n` 表；启用 en 后出现；`price` 跨语言同值。

### 批次 3（主题自有表 + 统一后台菜单）—— 未开始
DDL 生成器 + diff 迁移、`host.table()` facade、`admin_menu_registry`、`table-list`/`table-edit` 屏幕、插件菜单。

### 批次 4（脚手架 + 文档）—— 未开始
`make-theme.mjs`/`make-plugin.mjs`、`docs/I18N.md`/`THEME-DEV.md`/`PLUGIN-DEV.md`、`eshop` 示例主题。

## 6. 测试与验证（当前全绿：10 套件 / 0 失败）

```bash
npx tsc --noEmit                 # src/ 与 public/ 0 错误（node_modules 里的 lib 冲突是既有的，忽略）
node tests/<name>.test.mjs       # 逐个跑
```

| 套件 | 数量 | 守什么 |
|---|---|---|
| architecture | 10 | 分层红线、默认值零容忍、清单声明与文件对齐 |
| manifest-validation | 33 | 安装边界：每个用例注入单个缺陷，断言必须抛错 |
| **admin-spa** | **15** | **本轮新增**：后台模块图无环/无孤儿、`window.*` 契约、每个屏幕真渲染一次 |
| template-engine | 47 | 模板解释器单元 |
| theme-integration | 46 | 上传→激活→CPT→渲染→切主题保数据，端到端 |
| multisite | 74 | 多站点隔离（含 SEO 端点按站点，第 9b 段） |
| admin-contract | 32 | 后台 API 契约 |
| plugin-hooks | 25 | 插件 hook 生命周期 |
| theme-worker | 28 | L3 沙箱（含 WorkerStub 不可跨请求） |
| theme-aurora | 19 项 | aurora 主题渲染快照式检查 |

⚠️ **`node tests/run-all.mjs` 在本机沙箱会整体报 SKIP（EBUSY）**——Windows 沙箱锁 node 二元文件，
不是测试失败。**逐个直接跑才可靠。**

⚠️ **断言强度教训**（`tests/multisite.test.mjs` 第 9b 段曾假绿）：断言必须盯住
"注入缺陷后必然会变的那一个值"。断言"XML 格式正确"这类东西等于没断言。
**本轮又踩了一次同源的坑**：`tests/admin-spa.test.mjs` 第一版断言"`render()` 没抛错"，
而 `render()` 自己 catch 住屏幕异常并换成 "Something went wrong" 面板 —— 于是注入一个
未定义标识符后测试依然全绿。现在断言的是**写进 DOM 的内容**（非空、不含错误面板）。

⚠️ **新守卫必须反向验证**：写完守卫 → 故意注入一次违规 → 确认它 FAIL。测不出失败的检查等于没有检查。
本轮 6 项注入（删注册 / 加循环 / 未注册的 onclick / 孤儿模块 / 未导入标识符 / 空白渲染）全部如期变红。

## 7. 后台 SPA 拆分（✅ 本轮已完成）

`public/admin/admin.js` 1514 行单文件 → 入口 + 4 个基础模块 + 18 个屏幕模块。

### 落点

```
public/admin/
├── admin.js             入口：装配 + window.* 注册（约 60 行）
├── ui.js  icons.js      UI kit / 图标（本轮未拆）
└── js/
    ├── state.js         state + api/scoped/contentPath/postTypeInfo/loadContext（叶子模块）
    ├── nav.js           navGroups / sidebar / header（纯 markup，不调 render）
    ├── shell.js         render + go + switchSite + pageHead + 屏幕注册表
    ├── auth.js          renderLogin / doLogin / logout / setThemeForTest
    └── screens/         index.js（注册表）+ 17 个屏幕/工具模块
```

**关键设计：`shell.js` 不 import 任何屏幕。** 屏幕通过 `setScreenTable(SCREENS)`
自注册，登录屏通过 `setLoginScreen(renderLogin)` 注入 —— 否则
`shell → screens → shell` 立即成环。`extension-install.js` 独立出来是为了
不让"主题屏"依赖"插件屏"。屏幕内的 `window.xxx()` 调用已全部改为直接调用导入的函数。

### `window.*` 契约（注意：是 **17** 个，不是 18 —— 之前本文档写错了）

markup 用内联 `onclick="name(...)"`，浏览器解析在 `window` 上、不在模块作用域。
**少注册一个不会有任何报错**：不编译、不报 console、不发失败请求，按钮就是点了没反应。

`toggleMenu` `closeMenus` `toggleGroup` `toggleSidebar` `go` `switchSite`
`newContent` `editContent` `addBlock` `saveContent` `showRevisions` `deleteContent`
`installExtension` `pluginSettings` `doLogin` `logout` `setThemeForTest`

全部集中在入口的 `WINDOW_HANDLERS` 映射里，一眼可见。

### 配套测试 `tests/admin-spa.test.mjs`（15 条）

1. 相对 import 全部可解析；模块图无环（DFS，报出完整环路径）；无孤儿模块
2. `window.*`：入口有 `WINDOW_HANDLERS` 映射；17 个一个不少；markup 里调用的名字全部登记过
3. 入口保持薄（< 120 行、不定义任何屏幕）；`js/screens/` ≥ 15 个文件
4. **真实 import 入口**（复制到临时目录加 `type: module`，用 DOM/fetch 替身）：
   启动不抛错、无未处理 rejection、17 个处理器都是函数
5. **20 个页面各真渲染一次**，断言写进 `#content` 的内容非空且不含错误面板

### 真实浏览器验收（已跑）

`wrangler dev` + Chromium（playwright-core，浏览器已在 `%LOCALAPPDATA%\ms-playwright`）：

- 静态资源全部 200 且 MIME 正确（`/admin/js/**` 新目录确实被托管）
- 登录 → 侧栏真实点击（走 document 级委托）→ 主题下拉切换 → 侧栏折叠
- **16 个页面 × 明暗两套** = 32 次渲染，0 异常：h1 非空、导航项存在、正文 > 200 字符、壳层存在
- 用户菜单登出（走 `data-action` 委托）回到登录页
- console 零错误、零 5xx。唯一 401 是登录前的 `/api/v1/auth/me`，**设计内**

### 没做的事（已登记）

`public/admin/` 没有搬到仓库根的 `admin/`。`wrangler.jsonc` 的 `assets.directory`
只接受**一个**目录，而 `/admin/*` 这个 URL 空间必须保留（`src/index.ts` 把
`/admin` 前缀交给 `env.ASSETS.fetch()`，`robots.txt` 也依赖它）。搬迁要么再加一个
静态目录、要么把 `public/` 整个重构——都与"拆 JS"正交。已登记进 `AGENTS.md`
的偏离表。

## 8. 关键坑位清单（新人必读）

1. **Workers 禁止 eval / new Function / 动态 import** —— 模板引擎是解释执行，永远别引入 eval 类方案
2. **`.wrangler/` 含 bootstrap 管理员密码 hash**，已 gitignore，绝不入库
3. **多站点**：`theme_installs.active` 不是"当前主题"；唯一事实源是 `settings` 表按站点的 `theme.active`。
   声明表主键用 `scopedId(prefix, siteId, key)` 内嵌站点，否则跨站 UNIQUE 冲突
4. **主题切换只隐藏声明、绝不删数据**（含主题自有表）
5. **L3 主题 Worker**：`WorkerStub` 请求作用域，只能缓存 R2 源码字符串；`load()` 失败是延迟的，必须 `/__health` 预热
6. **清单校验的硬边界**：`blocks[].name` 纯标识符不带斜杠（`core/` 前缀是平台内置专用）；
   表名 ≥2 字符；表字段类型只有 6 种。新增清单规则的标准动作：
   写进 `validateManifest` → 在 `manifest-validation.test.mjs` 加注入用例 → 同步 `AGENTS.md` 与 §5.3
7. **每轮做完必须 commit + push**（用户明确要求），push 后**必须独立验证**：
   `git ls-remote origin main` 要等于本地 HEAD（沙箱 git 有"命令成功但 ref 没变"的已知问题），
   最硬的证据是 `gh api repos/unifare/CFCMS/commits/main --jq .sha`
8. **memory 文件与文档里的路径引用要跟着重构走** —— 上轮分层后 `MEMORY.md` 残留 8 处 `src/core/*` 旧路径，差点误导后续会话
9. **后台改结构时**：`shell.js` 不得 import 屏幕（自注册）；屏幕之间不得互相 import；
   新的 `window.*` 处理器必须登记进入口的 `WINDOW_HANDLERS`（漏登记**零报错**，按钮点了没反应）。
   见 `AGENTS.md` 规则 20–23
10. **别把"没抛错"当断言**：`render()` 会 catch 屏幕异常并渲染错误面板，
    所以"`render()` resolved" 不等于"屏幕是好的"。断言要盯**写进 DOM 的内容**。
    这是本轮亲自踩到的假绿

## 9. 权威文档索引

| 文档 | 内容 |
|---|---|
| `docs/ARCHITECTURE.md` | **唯一权威**：分层 §7、路线图与进度 §8、已确认决策 §9、假绿记录 |
| `AGENTS.md` | 改代码前的硬规则清单（红线、清单规则 14–19、后台 SPA 规则 20–23、明确不做的事） |
| `tests/admin-spa.test.mjs` | 后台 SPA 的结构守门人（模块图 + `window.*` 契约 + 逐屏渲染） |
| `docs/HANDOVER.md` | 本文 |
| `.workbuddy-ai/memory/` | 工作日志（按天）+ `MEMORY.md`（长期记忆）——本机文件，不入库 |
