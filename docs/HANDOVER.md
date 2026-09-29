# CFPress (CFCMS) 交接文档

> 更新时间：2026-09-29 (GMT+8) ｜ 交接基线：**本轮提交**
> （`Admin UI language (en/zh-CN) + account self-service + per-user menu config`；
> 上一轮批次 4 脚手架 + eshop 范例主题与主页接管，再上一轮 `48edc41` 多语言四层）
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

## 2. 提交脉络

```
6b09051  CFCMS v0.7.0 — 初始代码
1aeffa2  Add AGPL-3.0 license
265d03c  Layer src/ into shared/platform/rendering/extensions + enforce architecture
03ae88d  Add handover document
d6e2239  Split the admin SPA into modules + add structure tests
48edc41  Multi-language: four layers (L0-L3) + theme-owned tables
a1ac8e3  Unify admin menus into one registry + generate table screens from declarations
33f6369  Add theme/plugin scaffolders + make declared routes actually drive rendering
fb2b012  Add eshop sample theme, its test suite, and the three dev docs (batch 4)  ← 上一基线
3ccd66b  Admin UI language (en/zh) + account self-service + site menu editor  ← 本轮
```

`265d03c`：**目录分层 + 架构红线机器强制 + 运行时清单校验**（37 文件、+2827/−122）。

`d6e2239`：把 `public/admin/admin.js` 从 1514 行单文件拆成入口 + 4 个基础模块 +
18 个屏幕模块，新增 `tests/admin-spa.test.mjs`。纯前端重构，`src/` 一行未动。

`48edc41`：**批次 2 —— 多语言四层（L0/L1/L2/L3）全部落地**，并把原属批次 3 的
「主题自有表」部分（DDL 生成 + 注册表 + facade + 沙箱端点）一起做了。
顺带修掉三个只在真实交互下才暴露的缺陷（见 §5 批次 2 与 §8 坑位 11–13）。

`fb2b012`（+`33f6369`，批次 4）：**脚手架三件套 + `contract/` 拆分 + 路由消费契约 +
eshop 范例主题 + 三份开发文档**。生成器全部可被 import（本机沙箱无法 spawn 子进程），
`tests/scaffold.test.mjs` 68 条用真实校验器与真实模板引擎跑生成物。发现并修掉
"声明先于运行时"缺陷族的两例（`routes[].resolve.table`、`routes[].template`）。

本轮：**批次 5 —— 后台界面语言 + 账户自助 + 菜单配置**。后台 SPA 全面接入 L2 四层
字典（en/zh-CN 核心包约 90 key ×2），语言切换器持久化到 `site_users.ui_lang`；
扩展菜单支持 `label_key`（**服务端**翻译，前缀校验拒绝越界 key）；用户可自助改密/改名
（当前密码闸门下沉 `platform/auth.ts`，稳定错误码）；左侧菜单可按用户隐藏/恢复
（`site_users.menu_prefs`，纯 UI 层）。迁移 `0013`。真浏览器验收 38 条全绿
（`.wrangler/eshop-verify.cjs` v5）。

同轮收尾了批次 4 的遗留验证：**主页接管**（`routes[]` 声明 `path: "/"` 时前台首页交给
主题渲染，`src/index.ts` 的 home 闭包改为主题路由循环之后的 fallback），
`themes/eshop/theme.json` 首位路由即商品档案页；`tests/theme-eshop.test.mjs` 45 条、
`tests/_eshop-inject.mjs` 加 home-route 场景。

## 3. 源码布局（分层已落地，旧路径 `src/core/*` 已不存在）

```
src/
├── index.ts                  前端路由：站点解析 → 语言解析 → SEO → 主题路由 → CPT → 页面 → 404
├── api.ts                    管理 API（全部按站点；manifest 校验在安装路径上；`admin-menus` 端点）
├── shared/                   叶子层：types crypto repo cache scheduler（不 import 任何业务层）
├── platform/                 auth permissions sites frontend seo revisions
│   ├── admin-menus.ts        ★ 后台菜单注册表：主题/插件/核心共用的唯一读写入口
│   └── i18n/                 多语言四层
│       ├── core-pack.ts      内置核心语言包（TS 常量，不依赖 R2）
│       ├── translate.ts      interpolate / createTranslator / mergePacks
│       ├── resolve.ts        路径 → ?lang= → cookie → 站点默认
│       ├── locale-registry.ts L0 站点语言开关 + 增删改
│       ├── packs.ts          L2 分层装配 + setPackProviders 注入槽
│       └── index.ts          barrel
├── rendering/                template-engine template-resolver blocks（纯渲染）
└── extensions/
    ├── contract/             ★ 主题/插件共享的词汇与接口
    │   ├── hooks.ts            HostHooks + NULL_HOOKS + DECLARABLE_HOOKS + 注入槽
    │   ├── manifest.ts         词汇表：保留列 / 字段类型 / 后台屏幕 / 各种正则
    │   ├── capabilities.ts     CAPABILITIES 白名单
    │   └── validation.ts       validateManifest —— 安装边界校验，失败必须抛错
    ├── security.ts           只剩 safeZipPath / sha256
    ├── theme/                runtime-declarative runtime-worker capabilities templates
    │                         tables（DDL 生成 + theme_table_defs）table-facade packs
    └── plugin/               runtime packs menus

scripts/                      脚手架（生成器可被 import —— 本机沙箱无法 spawn）
├── _scaffold.mjs             parseArgs / writeTree / CliError / isMain
├── make-theme.mjs            themeFiles() + main(argv, io)
├── make-plugin.mjs           pluginFiles() + main(argv, io)
└── make-table.mjs            tableDeclarations() + main(argv, io)
```

**四条红线（`tests/architecture.test.mjs` 机器强制，13 组检查）：**
1. `shared/` 不 import 任何业务层
2. `platform/` 不 import `extensions/`
3. `rendering/` 不 import `extensions/`
4. `extensions/theme/` 与 `extensions/plugin/` **互不 import**（主题调插件走 `contract/hooks.ts` 依赖倒置，`index.ts` boot 时 `setHostHooks(...)` 注入）

**同一个依赖倒置模式已经用了三处**：`platform/i18n/packs.ts` 的
`setPackProviders({theme, plugin})`、`contract/hooks.ts` 的 `setHostHooks(...)`、
以及 `platform/admin-menus.ts`（两种扩展都要写菜单，而它们互不 import ——
放在 `platform/` 是唯一不需要越界 import 的位置）。所以 `platform/` 不需要认识
`extensions/`，规则 2 依然成立——**主题/插件的语言包与菜单都由扩展层实现，平台只认接口**。

**数据红线：** `siteId` 必须贯穿所有数据访问函数，**默认值零容忍**
（字符串形式 `siteId = "default"` 和常量形式 `siteId = DEFAULT_SITE_ID` 都算违规，架构测试会 FAIL）。

## 4. 六个已确认的架构决策（§9，全部选项 A，不要再当"待确认"）

1. **slug 跨语言唯一** —— 唯一索引 `UNIQUE(site_id, type, slug)`，不含 locale
2. **主题自有表只支持基础类型** —— `text/longtext/number/boolean/date/datetime`
3. **插件也可声明自有表** —— 与主题同机制，表名 `plugin_{slug}_{table}`
   ⚠️ **决策不变，但落地在批次 4**：`theme_table_defs` 只有 `theme_name` 一列，
   支持插件必须**重建该表**（SQLite 不能 `ALTER` 主键/UNIQUE）。在那之前，
   插件声明 `tables[]` 会被**校验器明确拒绝**（不是静默忽略）。
4. **删 `theme_admin_menus`** —— 合并为统一 `admin_menu_registry`（迁移时 drop 旧表）✅ **批次 3 已完成**
5. **目录重整先做** —— ✅ 已完成
6. **界面语言本期做** —— 后台 UI 语言与内容语言独立

## 5. 进度总览（路线图见 `docs/ARCHITECTURE.md` §8）

### 批次 1（架构防错）—— ✅ 全部完成

| 项 | 状态 |
|---|---|
| `src/` 目录分层重整（19 个平铺文件归位） | ✅ |
| 架构测试 11 组检查 + 8 项反向验证（注入违规必须 FAIL） | ✅（批次 3 后为 13 组） |
| `siteId`/`locale` 默认值清零（26 字符串 + 6 常量形式） | ✅ |
| 运行时 `validateManifest`（安装返回 400，不再只是测试端强制） | ✅ |
| 新套件 `manifest-validation`（33 条断言，逐条注入缺陷→断言拒绝） | ✅（批次 3 后为 54 条） |
| 依赖倒置 `theme↔plugin`（`contract/hooks.ts`） | ✅ |
| 多站点 SEO bug 修复（sitemap/robots 曾对所有域名返回默认站内容） | ✅ |
| 修复两个**从未生效**的守卫（默认值正则漏常量形式；跨层检查文本匹配落空） | ✅ |
| **后台 JS 拆分**（`admin.js` 1514 行 → 入口 + 22 个新模块） | ✅ 上一轮完成（见 §7） |

### 批次 2（多语言四层 L0/L1/L2/L3）—— ✅ 本轮完成

| 项 | 状态 |
|---|---|
| 迁移 `0011_i18n.sql`（`locales` 扩列 / `site_locales` / `posts.lang_group` / `site_users.ui_lang` / `i18n_overrides` / `theme_table_defs`） | ✅ |
| `src/platform/i18n/` 六个模块（内置核心包 + 翻译 + 语言解析 + L0 注册表 + L2 分层 + barrel） | ✅ |
| 界面语言注入（`setPackProviders`，与 `setHostHooks` 同一模式） | ✅ |
| 内容翻译组 CRUD（`i18n/translations`）+ 后台语言版本条 | ✅ |
| 后台「Languages」屏（L0 站点语言 + L2 界面语言 + 四层关系说明） | ✅ |
| 主题自有表 DDL 生成 + `theme_table_defs` 注册表 + facade + 沙箱 `table/*` 端点 | ✅ **原属批次 3，提前做了** |
| 清单内联语言包校验（插件没有 `langs/` 目录可读，只能内联声明） | ✅ 规划外新增 |
| 新套件 `tests/i18n.test.mjs`（62 条）+ `tests/_i18n-browser.cjs`（22 条，真实 Chromium） | ✅ |
| 修掉三个只在真实交互下暴露的缺陷（见 §8 坑位 11–13） | ✅ |

**验收要点全部有测试对着**：只启用一种语言时主题自有表**不建** `_i18n` 表；
启用第二种后出现；`price` 跨语言同值、`name` 跨语言不同值；
后台界面语言与内容语言独立可设；显式 `/en/x` 找不到返回 404 不回退。

### 批次 3（统一后台菜单 + 生成式屏幕）—— ✅ 本轮完成

| 项 | 状态 |
|---|---|
| 迁移 `0012_admin_menu_registry.sql`（建新表 + 搬旧数据 + `DROP theme_admin_menus`） | ✅ |
| `src/platform/admin-menus.ts`（注册/清理/查询 + `menuRowId` 防碰撞 + 分组 + 能力过滤） | ✅ |
| `src/extensions/theme/capabilities.ts` 改走注册表（`registerOwnerMenus` / `clearOwnerMenus`） | ✅ |
| `src/extensions/plugin/menus.ts`（插件菜单，`ALL_SITES='*'` 写一次） | ✅ |
| `src/api.ts` `GET /api/v1/admin-menus` 端点 + 停用插件时清它的菜单 | ✅ |
| `table-list` / `table-edit` 两个屏幕（列表列 + 表单控件全由 `fields[]` 生成） | ✅ |
| `public/admin/js/table-form.js`（字段类型 → 控件的唯一映射 + `date`/`datetime` 往返） | ✅ |
| `theme-menu.js` 改为统一分发器（`content-list` / `table-*` / `theme-settings` / `plugin-settings`） | ✅ |
| 插件清单支持 `adminMenus`（`seo` 插件新增 SEO Settings 菜单） | ✅ |
| 清单校验抽出共享 `validateAdminMenus`；插件 `tables[]` **明确拒绝** | ✅ |
| 新套件 `tests/admin-menus.test.mjs`（43 条）+ 架构测试新增 3 项检查（共 13） | ✅ |
| 真实浏览器验收 `tests/_admin-menus-browser.cjs`（31 条，连跑两次全绿） | ✅ |
| 修掉"新增/列表同名"缺陷（真实浏览器才暴露，见 §8 坑位 17） | ✅ |

**五条验收标准全部有测试对着**：① 生成式列表/表单，主题零后台代码；
② SEO 插件注册菜单并打开自己的设置页；③ 停用插件**只**消失它自己的菜单；
④ 切走主题保表丢菜单、切回恢复；⑤ 插件菜单在**全新站点**上无需额外步骤即可见。

**反向验证（本轮 6 项，全部注入后确认变红再撤回）**：`clearOwnerMenus` 忽略
`owner_name` → FAIL×3；插件菜单改成按站点 → FAIL×2；关掉 `table-list` 的 args 校验 →
FAIL×4；关掉插件校验分支 → FAIL×3；已发布主题用未知 screen → FAIL；
`src/` 引用已退役表 → FAIL。

### 批次 4（脚手架 + 文档）—— 已完成（插件自有表除外）

| 项 | 状态 |
|---|---|
| `extensions/contract/` 拆出 `manifest.ts`/`validation.ts`/`capabilities.ts` | ✅ |
| `scripts/make-theme.mjs` / `make-plugin.mjs` / `make-table.mjs` | ✅ |
| `tests/scaffold.test.mjs`（68 条，真实校验器 + 真实模板引擎） | ✅ 已进 `npm test` |
| 修复「声明被校验但运行时没人读」第三、四例（`resolve.table` / `routes[].template`） | ✅ |
| `docs/I18N.md` / `THEME-DEV.md` / `PLUGIN-DEV.md` | ✅（对着源码核对过，详见 ARCHITECTURE §4.4） |
| `themes/eshop/` 示例主题 + `tests/theme-eshop.test.mjs`（41 条） | ✅ 已进 `npm test`，七个注入场景逐条反向验证（`tests/_eshop-inject.mjs`） |
| **插件自有表** `plugin_{plugin}_{table}` | ⬜ 已登记：需**重建 `theme_table_defs`**（SQLite 不能 `ALTER` 主键/UNIQUE，而它现在只有 `theme_name` 一列） |

**本轮新增的两条引擎级守卫（都反向验证过）**：

1. **子模板未闭合 `{{@section}}` 直接抛错**。引擎原先靠「向后扫描有没有 `{{/section}}`」
   猜一个 `{{@section}}` 是定义还是插槽；猜错时子模板的 section 被当成插槽，
   布局渲染空 `<main>`——**HTTP 200、无异常**。现在用**文件事实**（`@extends` 了就是子模板，
   子模板永不提供插槽）把它变成结构性错误。
   ⚠️ 这个缺陷**真实存在于生成的骨架里**（四个子模板全漏了 `{{/section}}`），
   是 `tests/scaffold.test.mjs` 渲染时才发现的。
2. **`@extends` 链的 section 合并顺序**。原写法「保留第一次写入，只特判 `i === 0`」在
   **三层**继承时让**最不派生**的根赢；改成从根向子遍历、后来者覆盖。仓库里目前没有
   嵌套布局，所以一直没暴露——主题作者一试就会拿到祖父的副本。

**反向验证（本轮 4 项）**：路由运行时改动 → theme-integration FAIL×12；
7 条新清单守卫 → manifest-validation FAIL×7；i18n 断言收窄 → 强制 `created_i18n_tables: []` 变红；
生成的骨架去掉 4 个 `{{/section}}` → scaffold 同时被「内容计数」与「引擎守卫」两条独立机制抓到。

**反向验证（eshop 主题，7 项）**：`tests/_eshop-inject.mjs` 逐场景注入——未闭合 section /
改 `query.as` / 改 `resolve.by` / 砍 `translatable` / 模板链接指向 `/blog/` / 藏模板文件 /
藏语言包——每个场景先断言"确实注入了"（内容哈希比对），再断言红在预期的断言上，
最后验证还原成功（`assertPristine` 双向把关）。全部符合预期，详见 ARCHITECTURE §4.3。

> ⚠️ **第六种假绿**在本轮暴露：套件渲染抛错时**摘要行不会打印**，
> 校验脚本把「grep 不到摘要」误读成「没有失败」。修法：套件 `catch` 里也打印摘要
> （异常计为一条失败，标注 `(aborted)`）；校验脚本把「摘要缺失」当 FAILED。
> `theme-aurora` 的摘要格式（只打 `N failure(s)`、无 passed 计数）也已统一。
> 详见 AGENTS.md「第六种假绿」与 ARCHITECTURE §4.3。

### 批次 5（后台界面语言 + 账户自助 + 菜单配置）—— ✅ 本轮完成

| 项 | 状态 |
|---|---|
| 核心 UI 语言包 en + zh-CN（各约 90 key：导航/操作/主题/登录/账户/菜单配置/提示/错误码） | ✅ `core-pack.ts`，两语言**同步扩**（§2.4 落地段） |
| SPA 字典消费 `public/admin/js/i18n.js`（叶子模块：`t()` 永不空白、localStorage 登录屏缓存、`setUiLocale`） | ✅ |
| 语言切换器（header 下拉）+ 登录屏双语 + 切换即 `loadContext()+render()` | ✅ `nav.js`/`shell.js`/`auth.js` |
| **菜单标签服务端翻译**：`admin_menu_registry.label_key`（0013）+ `validateAdminMenus` owner 前缀校验 + `admin-menus` GET 消费点 | ✅ eshop 三个菜单复用 `theme.eshop.menu.*` |
| 账户自助改密/改名：`platform/auth.ts`（`changePassword`/`changeUsername`，当前密码闸门在服务函数内）+ `POST auth/password` / `auth/username` | ✅ 稳定错误码 `wrong_current`/`weak`/`taken`/`invalid` |
| `screens/account.js`（每个角色可用，不依赖 `users.manage`） | ✅ 客户端只预检两次新密码一致 |
| per-user 菜单配置：`site_users.menu_prefs`（0013）+ `GET/PUT admin-menus/prefs` + `screens/menu-config.js` | ✅ 规则 38：只影响侧边栏，不授/撤权限；`dashboard` 永远显示 |
| **站点菜单编辑器**（用户追加需求）：逐语言改名（en/zh-CN）、项排序（箭头+拖拽）、**跨组移动**、分组改名与排序、对所有人隐藏、恢复默认 | ✅ `admin.menu.custom` settings blob + `GET/PUT/DELETE admin-menus/custom`（写需 `settings.manage`，GET 回 `can_manage`） |
| 应用点收敛：`nav.js` 纯函数 `applyMenuCustom()`（侧栏与编辑器共用） | ✅ 规则 39：改名叠加在服务端翻译之上；稳定排序；**不存在分组=忽略**（反向验证抓到过“项消失”真缺陷）；结构性变更物化整组 order |
| 新套件 `tests/menu-custom.test.mjs`（40 条：API 契约 + 权限分层 + 校验 400s + 按站隔离 + **纯函数逻辑**） | ✅ 已进 `npm test`（16 套件 665 条） |
| 浏览器验收 v6 扩到 **47 条**：编辑器 11 条（改名 en/zh、组改名、组序、项序、跨组、站点隐藏、zh 回退、恢复默认） | ✅ 全绿 |
| 新套件 `tests/account.test.mjs`（27 条，含 **label_key 翻译端到端**：zh-CN →「商品」、en → "Things"、无翻译回退原文） | ✅ 已进 `npm test`（15 套件） |
| 真浏览器验收 `.wrangler/eshop-verify.cjs` v5（38 条：前台 18 + 界面语言往返 + 服务端翻译菜单 + 菜单隐藏/恢复 + 账户三道闸门） | ✅ 全绿 |
| 主页接管收尾（批次 4 遗留验证）：`routes[]` 声明 `path: "/"` → 前台首页交给主题；home 闭包移到主题路由循环之后作 fallback | ✅ `/`、`/en`、`/zh-CN` 均渲染商品档案 |
| 反向验证：改密/改名守卫下沉 `platform/auth.ts` 后注入（绕过当前密码校验） | ✅ 注入 → 2 红，还原 → 27 绿 |

**三条流程教训（本轮实测，详见 §8 坑位 21–23）**：真浏览器验收放在所有套件**之后**跑；
`api()` 非 2xx 时**抛 `Error(data.error)`**（`if (d.error)` 不可达，catch 里要 `explain(err.message)`）；
`ui_lang` 按用户持久化在 D1（**换浏览器也保持**，验收脚本登录后必须显式重置）。

## 6. 测试与验证（当前全绿：16 套件 / 665 条 / 0 失败）

```bash
npx tsc --noEmit                 # src/ 0 错误（node_modules 里的 lib 冲突是既有的，忽略）
node tests/<name>.test.mjs       # 逐个跑（判据是 0 failures，别把断言数写死）
```

| 套件 | 数量 | 守什么 |
|---|---|---|
| architecture | 15 | 分层红线、默认值零容忍、清单声明与文件对齐、语言包 key 前缀、**屏幕集合钉住 / 菜单引用的表存在 / 已退役表不再被引用** |
| manifest-validation | 63 | 安装边界：每个用例注入单个缺陷，断言必须抛错（含内联语言包、菜单 args、插件拒绝 `tables[]`、**路由 `resolve` 二选一 / `resolve.by` / `query.as` 作用域名**） |
| admin-menus | 43 | 注册表 schema / `menuRowId` 防碰撞 / 归属隔离 / 排序 / 能力过滤 / 主题与插件注册 / 停用插件只删自己的菜单 / 新站点可见 / 切主题切回 |
| admin-spa | 15 | 后台模块图无环/无孤儿、`window.*` 契约、每个屏幕真渲染一次 |
| template-engine | 49 | 模板解释器单元（含 **子模板未闭合 section 抛错**、**三层继承最派生者胜**） |
| **scaffold** | **68** | 生成的 theme/plugin/table 通过**真实** `validateManifest` + **真实**模板引擎 + **真实**架构规则；`@include`/`@extends` 目标存在；每个子模板 section 开闭配对；语言包前缀；拒绝覆盖；非法输入退出码；`--translatable` 正反两面 |
| theme-integration | 65 | 上传→激活→CPT→渲染→切主题保数据，端到端（含**表驱动路由**：`resolve.table` / `routes[].template` / `query.as` / 单条未命中 404） |
| **theme-eshop** | **45** | **范例主题**：`themes/eshop/` 的声明与模板互相自洽——表/翻译字段/菜单↔表配对/路由 `resolve`/`query.as`/语言包，全部过**真实**校验器与**真实**架构规则；六个模板各渲染一次（有数据/无数据）；链接走路由自己的路径；`@first` 绑迭代作用域；**主页接管**（`path: "/"` 声明即前台首页，+4 条） |
| multisite | 74 | 多站点隔离（含 SEO 端点按站点，第 9b 段） |
| i18n | 62 | 多语言四层契约（§5.4① 八条全覆盖）+ 翻译组 + 主题自有表 |
| admin-contract | 32 | 后台 API 契约 |
| **account** | **27** | **账户自助与菜单偏好（批次 5 新增）**：改密/改名的当前密码闸门（wrong_current 403 / weak 400 / taken 409 / invalid 400）、旧密码失效、`auth/me` 反映改名、menu_prefs 往返/去重/按用户隔离、**label_key 翻译端到端**（zh-CN→「物品」、en→"Things"、无 key 菜单保留原文、`ui_locale` 回显） |
| **menu-custom** | **40** | **站点菜单编辑器（批次 5 新增）**：`admin-menus/custom` 三端点契约（默认空、往返、按站隔离、DELETE 复位）、权限分层（author 可读不可写、`can_manage` 回显）、10 种结构违规 400 + 未知字段剥离、`applyMenuCustom` 纯函数（双语改名解析/稳定排序/跨组移动/**不存在分组被忽略**/siteHidden/navGroups 过滤语义） |
| plugin-hooks | 25 | 插件 hook 生命周期 |
| theme-worker | 28 | L3 沙箱（含 WorkerStub 不可跨请求） |
| theme-aurora | 14 | aurora 主题渲染快照式检查（摘要格式本轮统一为 `N passed, M failed`） |

⚠️ **一跑必须有摘要行**：`theme-eshop` / `theme-aurora` 都遵循「catch 里也打印摘要、
崩溃标注 `(aborted)`」——脚本判据统一是 `^[0-9]+ passed, [0-9]+ failed`，
**匹配不到就当失败**（见「第六种假绿」）。

另有一个**不在 `npm test` 链里**的反向验证工具（手工跑）：

```bash
node tests/_eshop-inject.mjs list         # 7 个场景
node tests/_eshop-inject.mjs inject <场景> # 注入（内容哈希证明生效）
node tests/theme-eshop.test.mjs           # 应红在预期断言
node tests/_eshop-inject.mjs restore      # 快照还原（assertPristine 双向验证）
```

⚠️ **多套件共享同一个本地 D1**：断言必须按 owner 收窄（`theme_name` / 站点），
别写全局计数。`theme_table_defs` **按设计不随主题停用消失**，所以夹具必须删掉自己的注册行
**并且** drop 自己生成的表——否则下一套件会看到上一套件留下的东西
（i18n 套件已经因此假红过一次）。

另有两个**不在 `npm test` 链里**的真实浏览器验收脚本：

```bash
npx wrangler dev --port 8787 --ip 127.0.0.1     # 另开一个 shell
node tests/_i18n-browser.cjs                     # 多语言：22 条断言
node tests/_admin-menus-browser.cjs              # 菜单与生成式屏幕：31 条断言（本轮新增）
node .wrangler/eshop-verify.cjs                  # eshop 全链路 + 批次 5 新功能：47 条断言
```

⚠️ **浏览器验收必须放在所有测试套件之后跑**（先测试 → 再 `theme:deploy` + 恢复 locale
→ 最后验收）。15 个套件共享同一块本地 D1，幂等清理会清掉 `site_locales` 的 zh-CN 行
与 `settings.theme.active`——本轮 `/zh-CN` 404 之谜的真相就是这个（ symptom 是
"昨天还好好的 URL 今天 404"）。`eshop-verify.cjs` 对此**自愈**：登录后先把界面语言
重置为 en 再重载（`ui_lang` 按用户持久化，见坑位 23）。

`_i18n-browser.cjs` 跑 22 条断言：登录 → Languages 屏 → 加语言 → 编辑器语言版本条 →
建翻译 → 删翻译 → 停用语言，并断言**零 console 错误、零失败请求、零 5xx**。

`_admin-menus-browser.cjs` 跑 31 条断言：SEO 插件菜单出现在 "Extensions" 分组 → 打开
插件设置 → 值写入后**刷新仍在**；再上传一个声明 `tables[]` 的主题 → 激活 → "From theme"
分组出现 → **列表的列来自 `fields[]`、表单控件来自 `field.type`** → 存 → 列表可见 →
删 → 复原初始状态。

两个脚本都**自己清理自己**，所以可以重复跑；都用应用自己的 API 挑选目标数据，
不依赖固定行号。

⚠️ **`node tests/run-all.mjs` 在本机沙箱会整体报 SKIP（EBUSY）**——Windows 沙箱锁 node 二元文件，
不是测试失败。**逐个直接跑才可靠。**

⚠️ **断言强度教训**（`tests/multisite.test.mjs` 第 9b 段曾假绿）：断言必须盯住
"注入缺陷后必然会变的那一个值"。断言"XML 格式正确"这类东西等于没断言。
**上一轮又踩了一次同源的坑**：`tests/admin-spa.test.mjs` 第一版断言"`render()` 没抛错"，
而 `render()` 自己 catch 住屏幕异常并换成 "Something went wrong" 面板 —— 于是注入一个
未定义标识符后测试依然全绿。现在断言的是**写进 DOM 的内容**（非空、不含错误面板）。

⚠️ **反向验证本身也会假绿**（本轮新增的第四种失败，见 `AGENTS.md`）：
为 `clearOwnerMenus` 写的归属隔离用例原本拿"主题 owner vs 插件 owner"对比，
于是把 `WHERE` 里的 `owner_name` 整条删掉**测试依然全绿**——两个 fixture 的 `owner_type`
本来就不同，`owner_name` 在这一次比较里是多余的。**被删掉的那一半必须是唯一区分
fixture 的那一项**；修正方式是再加一个**同类型**的第二个 owner（注入后 3 个 FAIL）。

⚠️ **新守卫必须反向验证**：写完守卫 → 故意注入一次违规 → 确认它 FAIL。测不出失败的检查等于没有检查。
本轮 6 项注入（见 §5 批次 3）全部如期变红。

## 7. 后台 SPA（两轮前拆分，批次 5 又新增 3 个模块）

`public/admin/admin.js` 1514 行单文件 → 入口 + 6 个基础模块 + 屏幕模块
（`js/screens/` 现有 23 个文件：注册表 `index.js` + 22 个屏幕/工具模块）。

### 落点

```
public/admin/
├── admin.js             入口：装配 + window.* 注册（< 120 行）+ boot 时 cachedMessages()
├── ui.js  icons.js      UI kit / 图标
└── js/
    ├── state.js         state + api/scoped/contentPath/postTypeInfo/loadContext（叶子模块）
    │                    loadContext 同取 admin-menus/prefs → state.hiddenMenus（与菜单同取：
    │                    切语言重跑 loadContext 时两者同时刷新）
    ├── i18n.js          ★ 批次 5：t()/loadMessages/setUiLocale（叶子中的叶子，谁都能 import 它）
    ├── nav.js           baseGroups（分组带稳定 id）/ applyMenuCustom（★ 站点定制唯一应用点，
    │                    纯函数，侧栏与编辑器共用）/ navGroups（应用定制 + 双层隐藏过滤）/
    │                    navGroups / sidebar / header（语言下拉）
    ├── shell.js         render + go + switchSite + pageHead + 屏幕注册表 + 页名分发 + 语言切换委托
    ├── auth.js          renderLogin / doLogin / logout / setThemeForTest（登录成功后 loadMessages）
    ├── table-form.js    字段类型 → 控件 的唯一映射 + 值往返
    └── screens/         index.js（注册表）+ 22 个屏幕/工具模块
                         ★ account.js / menu-config.js 是批次 5 新增（都走 data-* 委托，零新 window.*）
                         ★ menu-config.js = 站点菜单编辑器（改名/排序/跨组/隐藏/恢复默认，
                           结构性变更物化显式 order，标签 change 即存、Enter 提交）+ 我的偏好双面板
```

**`i18n.js` 是叶子中的叶子**：不 import 任何东西，所以包括 `ui.js` 在内的所有模块都能
依赖它而不成环。菜单标签**不在**这里翻译——`admin-menus` API 已在服务端把 `label_key`
换成译文，切换语言时 `setUiLocale → loadContext() → render()` 重取上下文即可。

**关键设计：`shell.js` 不 import 任何屏幕。** 屏幕通过 `setScreenTable(SCREENS)`
自注册，登录屏通过 `setLoginScreen(renderLogin)` 注入 —— 否则
`shell → screens → shell` 立即成环。`extension-install.js` 独立出来是为了
不让"主题屏"依赖"插件屏"。屏幕内的 `window.xxx()` 调用已全部改为直接调用导入的函数。

### 页名分发（本轮改动的核心）

`shell.js` 按四个前缀分发页名：`menu:<id>`（扩展菜单）、`table:<t>`（列表）、
`table-new:<t>`（新建）、`table-edit:<t>:<slug>`（编辑）。**必须保持三前缀分离**——
合并成 `table:<t>[:<slug>]` 会让"列表"和"新建"成为同一个页名，点 Add 时路由认为
"已经在目标页上"而不重渲染，按钮看起来完全没反应（见 §8 坑位 17）。

> **新屏幕不该产生新的 `WINDOW_HANDLERS` 条目。** `screens/languages.js` 全部动作走
> `data-lang-enable` / `data-lang-disable` / `data-action="add-language"` 这类
> document 级委托，一个 `window.*` 都没加；本轮的 `table-list.js` / `table-edit.js`
> 同样走 `data-table-new` / `data-table-edit` / `data-table-del` / `data-table-save`。
> 新代码照这个来——规则 23 那个"漏登记零报错"的坑，最好的用法是根本不去踩它。

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
5. **所有页面各真渲染一次**，断言写进 `#content` 的内容非空且不含错误面板

### 真实浏览器验收（三套）

**两轮前（后台拆分）**：`wrangler dev` + Chromium（playwright-core，浏览器已在
`%LOCALAPPDATA%\ms-playwright`）

- 静态资源全部 200 且 MIME 正确（`/admin/js/**` 目录确实被托管）
- 登录 → 侧栏真实点击（走 document 级委托）→ 主题下拉切换 → 侧栏折叠
- **16 个页面 × 明暗两套** = 32 次渲染，0 异常：h1 非空、导航项存在、正文 > 200 字符、壳层存在
- 用户菜单登出（走 `data-action` 委托）回到登录页
- console 零错误、零 5xx。唯一 401 是登录前的 `/api/v1/auth/me`，**设计内**

**上一轮（多语言）**：`tests/_i18n-browser.cjs`，22 条断言，见 §6。
它把「语言开关 → 编辑器语言版本条 → 建翻译 → 删翻译」这条链在真浏览器里走通，
并证明**界面上真的多了一块、又真的少回去**——而不是只证明接口返回了 200。

**本轮（菜单 + 生成式屏幕）**：`tests/_admin-menus-browser.cjs`，31 条断言，见 §6。
它证明的是**"声明 → 后台"这条路真的通了**：插件菜单出现并能打开设置页、
主题声明的表真的生成了列表列与表单控件、值真的存进去且刷新后还在。
**这一套抓到了单元测试看不见的产品缺陷**（"新增/列表同名"，见坑位 17）——
两个屏幕各自都能渲染，所以逐屏渲染测试永远发现不了它。

### 没做的事（已登记）

`public/admin/` 没有搬到仓库根的 `admin/`。`wrangler.jsonc` 的 `assets.directory`
只接受**一个**目录，而 `/admin/*` 这个 URL 空间必须保留（`src/index.ts` 把
`/admin` 前缀交给 `env.ASSETS.fetch()`，`robots.txt` 也依赖它）。搬迁要么再加一个
静态目录、要么把 `public/` 整个重构——都与"拆 JS"正交。已登记进 `AGENTS.md`
的偏离表。

同样登记在偏离表、留给批次 4 的还有：`public/admin/ui.js` 未再细分；
`extensions/contract/` 只拆出了 `hooks.ts`；**插件自有表**（需要重建 `theme_table_defs`）。

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
   见 `AGENTS.md` 规则 21–24。**优先用 `data-*` 委托，根本不产生新的 `window.*`。**
10. **别把"没抛错"当断言**：`render()` 会 catch 屏幕异常并渲染错误面板，
    所以"`render()` resolved" 不等于"屏幕是好的"。断言要盯**写进 DOM 的内容**。
11. **`lang_group` 可空，「没有它就是自己」只能写一次**。JS 用 `groupOf()`、
    SQL 用 `GROUP_SQL`（都在 `src/api.ts`，紧挨着），两处共用同一个定义。
    只写 `WHERE p.lang_group = ?` 会**排除组名所指的那一行自己**，于是组看起来是空的：
    编辑器报告语言缺失，并诱导用户**再建一份已经存在的内容**——不报错，只是悄悄多一份。
12. **语言开关是后台上下文的事实源**。改完必须 `loadContext()` 再 `render()`，
    否则 `state.locales` 是旧的，`loadVersions()` 以为站点只有一种语言，
    **整个语言版本条不渲染**。屏幕上"少一块"不会报错，所以极难发现。
13. **别把"缓存是空的"和"事实是空的"当成同一件事**。`loadVersions` 原本写
    `state.locales.length < 2` → 空数组走了"单语言"分支。改成只在**确知**单语言
    （长度恰为 1）时短路，其余情况问服务端。
14. **`langs` 语言包两条路径**：主题从 R2 读 `themes/<name>/langs/<locale>.json`；
    插件**没有目录可读**（`uploadExtension` 把包当 zip 原样存，从不解包），
    只能把语言包**内联在 `plugin.json` 的 `langs{}` 里**。两条路径同一套 key 前缀规则。
15. **`{table}_i18n` 永不 drop、永不清回 NULL**。语言停用只隐藏；重新启用时翻译必须还在。
    主表字段只增不删（`ALTER TABLE ADD COLUMN`）。这是与 WordPress 的分界线。
16. **`.wrangler/` 里的本地 D1 会被测试直接写**（`node:sqlite` 读 miniflare 的 sqlite 文件），
    所以测试留下的 fixture 会出现在后台列表里。**别把"后台里怎么多了几条测试数据"当成 bug。**
17. **后台页名必须三前缀分离**（`table:` / `table-new:` / `table-edit:`）。
    曾经合并成 `table:<t>[:<slug>]`，"列表"与"新建"因此是**同一个页名**：点 Add 时
    路由判断"我已经在这个页面上了"→ 不重渲染 → **按钮看起来完全没反应**
    （无报错、无失败请求、无 5xx）。逐屏渲染测试发现不了它（两个屏幕各自都能渲染），
    **只有真实浏览器点一下才会暴露**。见 `AGENTS.md` 规则 35。
18. **菜单必须带归属（`owner_type` + `owner_name`）**，`admin_menu_registry` 是唯一来源，
    `theme_admin_menus` 已退役。主题菜单**按站点**；插件菜单**写一次 `site_id='*'`**、
    读时 `site_id = ? OR site_id = '*'`——插件只有安装级 `enabled`，按站点扇出需要
    一个**尚不存在**的"建站点钩子"，少了它新站点会静默地没有任何插件菜单。
19. **`table-list` / `table-edit` 的列与控件必须由 `tables[].fields[]` 生成**，
    主题不得手写后台表单。字段类型只有 6 种，`datetime` 列**全库都是 INTEGER 秒**
    （`table-form.js` 的 `toLocalInput`/`fromLocalInput` 负责往返）。**插件不得声明
    `tables[]`、也不得用这两个 screen**（校验器直接拒绝，不是忽略——静默忽略一个已声明
    的能力比拒绝它更危险）。
20. **反向验证的 fixture 必须只有一处差异**。拿"主题 owner vs 插件 owner"去验
    `owner_name` 过滤是**假绿**：删掉 `owner_name` 依然全绿，因为两个 fixture 的
    `owner_type` 本来就不同。写用例时先问「我把这一条删了，哪个断言会变红」。
21. **共享 D1 会被测试套件清掉配置**。15 个套件共用同一块本地 D1，幂等清理波及
    `site_locales`（zh-CN 行消失）与 `settings.theme.active`——症状是"昨天还好好的
    `/zh-CN` 今天 404"。**验收顺序铁律：先跑全部套件 → 再部署/恢复配置 → 最后真浏览器
    验收**。`eshop-verify.cjs` 对语言状态自愈（登录后重置为 en 再重载）。
22. **`api()` 帮手在非 2xx 时抛 `Error(data.error)`**——服务端的稳定错误码
    （`wrong_current`/`weak`/`taken`/`invalid`）出现在 catch 的 `err.message` 里，
    SPA 里 `if (d.error)` 分支**永远不可达**。错误对话框要写
    `explain(err.message)`，否则用户看到裸码（账户屏实踩：对话框显示 "wrong_current"）。
23. **`ui_lang` 按用户持久化在 D1，换浏览器也保持**。全新浏览器登录依然是上次的语言
    （localStorage 缓存只是登录屏的加速，不是事实源）。浏览器验收脚本断言界面文案前
    必须先显式重置语言；否则上一次运行切过中文，这一次的英文断言全红——**功能没坏，
    是状态没归零**。
24. **SPA 套件的盲区：只 import、不点击**。`admin-spa.test.mjs` 做静态检查 + 真实
    import 入口，但从不执行登录点击路径——`doLogin` 里漏 import 一个函数（ReferenceError）
    套件全绿，因为屏幕渲染异常会被 catch 成错误面板，而登录路径根本没被走到。
    **登录卡死的探针**：playwright 监听 `console`/`pageerror`/`response` + 打印
    `#dialog-host`（`_i18n-browser.cjs` 同款手法；`auth.js` 缺 `loadMessages` 就是这样抓到的）。
25. **`fill()` 只派发 `input` 不派发 `change`**。菜单编辑器的标签输入在 `change`（失焦）时
    才保存——自动化测试 fill 之后**必须显式 blur**，否则断言读到的是改名前的界面
    （v6 首跑实踩：改名断言挂了，但后续步骤的点击触发 blur 又把它救活了——症状是
    "现在没生效、两步之后生效了"）。Enter 提交（keydown→blur）是给人用的快捷方式，
    不是给 playwright 的。

## 9. 权威文档索引

| 文档 | 内容 |
|---|---|
| `docs/ARCHITECTURE.md` | **唯一权威**：多语言 §2、主题 §3、插件 §4、防错 §5、表总览 §6、分层 §7、路线图与进度 §8、已确认决策 §9、假绿记录 |
| `AGENTS.md` | 改代码前的硬规则清单（红线、清单规则 14–20、后台 SPA 规则 21–24、主题自有表规则 25–29、共用定义规则 30–31、**菜单注册表与生成式屏幕规则 32–37**、明确不做的事） |
| `tests/architecture.test.mjs` | 分层与越界守门人（13 组检查） |
| `tests/admin-menus.test.mjs` | 菜单注册表契约（归属隔离 / 安装级可见 / 停用只删自己 / 切主题切回） |
| `tests/i18n.test.mjs` | 多语言四层契约（§5.4① 八条 + 翻译组 + 主题自有表 + 9b 段 `lang_group` 回归） |
| `tests/_i18n-browser.cjs` | 多语言后台的真实浏览器验收（22 条，自清理，可重复跑） |
| `tests/_admin-menus-browser.cjs` | 菜单 + 生成式屏幕的真实浏览器验收（31 条，自清理，可重复跑） |
| `tests/admin-spa.test.mjs` | 后台 SPA 的结构守门人（模块图 + `window.*` 契约 + 逐屏渲染） |
| `tests/account.test.mjs` | 账户自助与菜单偏好契约（当前密码闸门 / 稳定错误码 / prefs 隔离 / **label_key 翻译端到端**） |
| `.wrangler/eshop-verify.cjs` | eshop 全链路 + 批次 5 新功能的真浏览器验收（38 条，语言状态自愈，需 `wrangler dev`） |
| `docs/HANDOVER.md` | 本文 |
| `.workbuddy-ai/memory/` | 工作日志（按天）+ `MEMORY.md`（长期记忆）——本机文件，不入库 |
