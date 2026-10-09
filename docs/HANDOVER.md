# CFPress (CFCMS) 交接文档

> 更新时间：2026-10-09 (GMT+8) ｜ 交接基线：**批次 16 Track 0 + B1 + A3 —— 媒体隔离 / 块 attrs 契约 / 统一媒体控件**
> （批次 15 数据驱动后台；批次 14 多语言 URL——slug 按语言 + hreflang + 按语言 feed + 规则 56–59；
> 批次 13 mobai 主题 + RSS；批次 12 写入路径修复 + journal 主题；批次 11 平台功能开关。
> 批次 10 及更早见下方各节与 `docs/history/`。）
> 读者：接下来接手本项目的开发者或 AI 会话。**先读本文，再读 `docs/ARCHITECTURE.md`，改代码前读 `AGENTS.md`。**
>
> ⚠️ 批次 16 已完成 **Track 0**（媒体隔离地基）、**Track B1**（块 attrs 契约）、**Track A3**（统一媒体控件）。
> 其余部分（A4 媒体屏升级、B3 编辑器界面翻译、B4 多语言编辑体验、B5 `post_meta` 语言维度）
> 在 `docs/design/MEDIA-EDITOR-PLAN.md`（**已定稿、未实现**，含四条轨道的完整拆分与已拍板语义）。
> ⚠️ 本轮的批次过程文档在 `docs/history/HANDOVER-PLUGIN-BATCH.md`（已降级为批次存档，只记步骤 1–6 的细节）。
> 每日工作日志在 `.workbuddy-ai/memory/YYYY-MM-DD.md`（gitignore，本机才有）。

---

## 1. 项目是什么

**CFPress / CFCMS** — 跑在 Cloudflare 全家桶上的 WordPress 式 CMS：

| 组件 | 用途 |
|---|---|
| Workers | 全部服务端逻辑（无 Node 服务器） |
| D1 (SQLite) | 内容与配置 |
| R2 | 主题模板包、媒体、扩展 zip |
| KV | 会话、缓存镜像（**镜像默认关**，见功能开关） |
| Static Assets | 后台 SPA（`public/admin/`） |

- 仓库：`https://github.com/unifare/CFCMS`（public，分支 `main`，许可证 AGPL-3.0）
- 版本：v0.7.0 → 目标 v0.8.0
- **线上**：`https://cfpress.2aass.workers.dev`（免费计划，账号 `2aass@proton.me`）
  ——所有 `wrangler` 命令必须带 `-c wrangler.local.jsonc`（真资源 id 在里面，已 gitignore；
  仓库里的 `wrangler.jsonc` 是 `REPLACE_WITH_*` 占位符）
- **后台首登**：`admin` / `change-me-now`（bootstrap 自动建号；**公开站点，上生产前必须改密**）
- dev 端口 **47913**（跨项目约定，env `CFP_PORT` 可覆盖）
- ⚠️ 沙箱代理放行 `api.cloudflare.com` 但**拦截 `*.workers.dev`**——线上站点无法在沙箱内 HTTP
  验证，部署成功靠 `wrangler deploy` 输出 + `wrangler deployments list` + GraphQL analytics 证明

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
fb2b012  Add eshop sample theme, its test suite, and the three dev docs (batch 4)
3ccd66b  Admin UI language (en/zh) + account self-service + site menu editor  (batch 5)
959f423  Review: multi-language invariants (batch 6 review)
83e65ed  Fix the four multi-language defects the review found (batch 6)
36720a1  Rule 41: every data field carries a language dimension (batch 7)
...      (batches 8–9: 见 ARCHITECTURE.md §8 路线图)
576fe6a  Delete retired themes/plugins + fix the 11th false green (batch 10 step 1)
34c0bc9  Owner-agnostic own tables: rebuild theme_table_defs with owner_type (step 2)
bcc856c  Channel contract + plugin page contract + rules 48–51 (steps 3+4)
9487b40  Channel runtime: webhook impl + dedup ledger + PluginApi.notify (step 5)
9fd19db  Admin renderer: plugin-page blocks + channel settings form (step 6)
(batch 10 steps 7+8: plugins/notify sample + plugin-pages suite + injectors — 见 §5)
0aa6ed6  Opt-out feature switches: KV cache mirror + theme Worker sandbox (batch 11)
622bcce  Fix savePost: PUT with an id now creates when the row is missing
6a53ba7  Dashboard fields (recent/published) + deletePost site-ownership check
9e9dde5  PBKDF2 120k→25k (free-plan 10ms CPU) + handleApi top-level try/catch
f312143  journal theme (modern blog) + listing dates + CJK reading time
0f2bd7f  mobai theme (墨白) + RSS feed + cover images + theme.strings for templates
a81e5e0  Re-key tenant audit verdicts after the mobai batch
7581387  Per-language slugs + hreflang + per-locale feeds + rules 56-59  ← 批次 14
60f9a24  Dropdown check mark: show only on the active row
176331b  Data-driven admin: block palette, dashboard cards, typed settings forms  ← 批次 15 基线
(batch 16 Track 0: media ownership + isolation, and the site-list memo fix — 见 §5)
(batch 16 Track B1: the block attribute contract, and the editor's per-type controls — 见 §5)
(batch 16 Track A3: one media control for blocks, custom fields and settings — 见 §5)
```

**批次 16 Track 0（媒体隔离地基）**：`media_files` 自 0009 起就有 `site_id`，但
**它的唯一公开门没有执行它**——`/media/<key>` 在 `src/index.ts` 里于**站点解析之前**、
**鉴权之前**匹配并直接从 R2 取对象，于是 A 站铸的 key 在 B 站域名下 200、未登录访客也 200。
后台列表早已按站点收窄，**恰恰因为另一扇门是对的，这个洞活过了所有既有断言**。
本批次补齐两轴（租户 + 所有者）并让两扇门走同一份策略；顺带修掉一个"新建站点在前台解析不到"
的 memo 缺陷。详见 §5 与 `AGENTS.md` 规则 60。

**批次 11（`0aa6ed6`，平台功能开关）**：`src/shared/features.ts` 单一定义
（`FEATURE_SWITCHES`：key/varName/defaultOn/label），优先级 站点 settings 行 →
`wrangler.jsonc` vars → `defaultOn`，解析不了=关。两个开关都默认关：
`cache_mirror_kv`（KV 写入镜像）、`theme_runtime_worker`（主题 Worker 沙箱，
**检查必须在绑定之前**）。后台 Tools → Features 屏 + `GET/POST /api/v1/features`。
规则 52–55。

**批次 12（写入路径修复 + journal 主题）**：三个「200 + 内容错」真缺陷——
①`savePost` 对带 id 的 PUT 只 UPDATE（SQLite 零行更新不报错→孤儿翻译行，**判据必须是
查询结果不是入参形状**）；②`deletePost` 不校验站点归属（A 站可删 B 站文章）；③dashboard
漏发 `recent`/`published` 且 media 计数漏租户。外加 `handleApi` 顶层 try/catch（异常逃逸成
平台错误页 → 客户端只见 "Request failed"）与 **PBKDF2 迭代 120000→25000**（免费计划单请求
10ms CPU，实测 120k≈22ms 会在写库前被杀——症状是 `site_users` 恒 0、登录报 "Request failed"；
迭代数写在 hash 串里，以后调高不破坏旧密码）。同批交付 `journal` 现代博客主题（39 条套件）、
列表日期 `date_display`（Intl 按 locale 记忆化）、`readingTime` CJK 按字计。

**批次 13（`0f2bd7f`，mobai 主题 + RSS）**：设计稿→主题 `content/themes/mobai`（杂志式中文博客，
明暗两套、零构建零外链）。平台补 **RSS**（`/feed.xml`，原平台只有 sitemap/robots）与
`cover`（从正文第一个 `core/image` 派生——字段类型无法诚实表达 URL，`text` 被规则 41 强制可翻译）。
`theme.strings` 把主题自己的语言包暴露给模板（前端文案不再硬编码）。**顺带抓到
`x-cfpress-scope` ByteString 缺陷**：站点标题/分类含中文时 worker 主题整条路径静默退化
（请求头是 Latin-1）——该头只写不读，删除而非编码，回退路径改为 `console.error` 原因。

**批次 14（`7581387`，多语言 URL）**：slug 按语言（迁移 0016：`post_translations.slug`，
NULL=跟随主表 `posts.slug`=默认语言值；**DROP 全局 UNIQUE 索引**，唯一性改为写路径按语言
检查 409；读一律 `COALESCE(t.slug,p.slug)`，规则 58）；hreflang（`lang_group` 兄弟版本 +
x-default）；`/{locale}/feed.xml`；`lang_nav` 切换器进 scope。规则 56–59 + 四道架构守卫 +
`_locale-url-inject.mjs` + `npm run gate`（纯 node 直调，刻意不含 tsc——lib.dom 上游噪音
淹没退出码）。**锁定教训**：publish-only 的 PUT 曾把 URL 改名成 entityId
（`tSlug || entityId` 兜底是 CREATE-only）。

**批次 15（`176331b`，数据驱动后台）**：①编辑器块面板从 `CORE_BLOCKS` 下发
（原硬编码 9 种 vs 渲染器 12 种——gallery/button/columns 一直插不出来），
`GET /api/v1/blocks`（原本零消费的端点）升级为翻译后形状；②Dashboard 统计卡为 API 下发的
`cards` 数组，插件经 **`dashboardCards` filter** 注入；③声明式设置表单按
`ALLOWED_FIELD_TYPES` 出类型感知控件，`options` 终于被持久化（迁移 0017——校验器一直接受
却从不存储）。三道新守卫（SPA 禁块名字面量 / dashboard 禁 stat 硬编码 / 13 类型逐个有 case）
+ `_skeleton-inject` 3 个新场景（23 场景 0 问题）。

**批次 16 Track 0（媒体隔离地基）—— ✅ 本轮完成**

起点是用户提的四条诉求（编辑器跟进 / 多语言体验 / 统一媒体控件 / 站点与用户隔离）。
勘察后先出方案（`docs/design/MEDIA-EDITOR-PLAN.md`，四条轨道），本轮只做 **Track 0**，
因为其余三条都依赖它。

| 项 | 状态 |
|---|---|
| 迁移 `0018_media_ownership.sql`：`media_files.uploaded_by` + `(site_id, uploaded_by, created_at)` 索引；`contract/schema.ts` 的 note 同步 | ✅ |
| `src/platform/media-policy.ts`：媒体访问策略的**唯一定义**（`isolation` / `require_session`，站点设置行 `cfpress.media`，解析不了=安全侧）+ `mediaKeyBelongsToSite` + `mediaReadDecision`（**返回拒绝原因**）+ `mediaOwnerClause` | ✅ |
| `/media/` 读取分支**移到站点解析之后**（与 sitemap/robots 同层），三闸门：key 属本站 / 策略要求时会话 / owner 隔离下必须是上传者；拒绝**一律 404** | ✅ |
| `api.ts`：上传写 `uploaded_by` + 校验站点真实存在；列表支持 `q`/`type`/`page`/`limit`/`total` 并按策略收窄；新增 `PATCH`（alt/title）与 `DELETE`（**先删 R2 对象再删行**）；dashboard 的媒体计数走同一条 owner 子句 | ✅ |
| **顺带修掉的第四个真缺陷**：`platform/sites.ts` 的站点列表 memo 注释写着"per-request"，实际以 `env`（isolate）为键且从不清理 → **新建站点在前台解析不到**（host 与 path 前缀都落到默认站）。修法：入口每请求 `resetSiteListMemo(env)` | ✅ |
| 新套件 `tests/suites/media.test.mjs`（69 条）+ 登记进四处注册表（`package.json` / `run-all.mjs` / `cfpress.sh` / `cfpress.ps1`） | ✅ |
| 新守卫（`architecture.test.mjs`，3 条）：`/media/` 分支必须在 `await resolveSite(` **之后**（**结构**判据，行为测试看不见它）+ 读取路径必须走 `mediaReadDecision` | ✅ |
| 新注入工具 `tests/tools/_media-inject.mjs`（**7 场景**，全部"注入→具名断言变红→还原→哈希一致"） | ✅ |
| `_tenant-query-audit.mjs` 重新键位（`api.ts:1357→1584`、`frontend.ts:145→186`，后者是批次 10 起就漂了的陈旧键） | ✅ |
| 规则 60 写进 `AGENTS.md` + `ARCHITECTURE.md` §10 | ✅ |

**本轮的三条关键判断**（都写进了 `AGENTS.md` 规则 60）：

1. **三条闸门都答 404 ⇒ 断言必须盯"哪一条"**。`mediaReadDecision` 因此返回
   `site`/`session`/`owner`/`missing` 而不是布尔；套件把三条闸门**逐条单独打开**再断言。
   只在三条全关时断言"404"的写法，删掉任何一条都不会变红——这正是本仓库反复踩的
   "观测面"层假绿（§12）。
2. **守卫必须是结构的**。把 `/media/` 分支挪回站点解析之前，只要所有站点恰好都是默认站，
   行为测试全绿。所以守卫解析 `index.ts` 里两个锚点的**先后顺序**，注入场景 7 验证它。
3. **默认值本身是产品决定**。`require_session` 默认**开**（用户选定"站点校验 + 要求会话"）：
   未登录访客取不到媒体 ⇒ 前台 `<img>` 会 404。它被实现为站点设置而不是常量，
   就是为了让这个选择**可逆**，并且排障第一站就是它。`AGENTS.md` 规则 60e 明写了这一点。

**新基线**：**23 套件 + `_schema-scope`，24 项 / 1240 条 / 0 失败**；`tsc --noEmit` src/ 0 错误；
`_tenant-query-audit` 每条命中都有裁决；`_media-inject` 7/7 场景有效。

### 批次 16 Track B1（块 attrs 契约）—— ✅ 本轮完成

**起点是一个用户看得见、而所有守卫都看不见的缺陷**：编辑器给**所有**块写 `attrs.text`，
渲染器按类型读**不同**的属性——`core/image`→`url`+`alt`、`gallery`→`items`、
`html`→`html`、`group`/`columns`→嵌套 `content`、`button`→`url`+`text`。
于是 **12 种块里有 6 种从后台插入后前台渲染为空**：**HTTP 200、零异常、零 5xx**。
这是「声明先于运行时」缺陷族的**第八例**，且是**没有任何守卫**的一例——
清单校验器查声明，架构测试查结构，`admin-spa.test.mjs` 从不打开编辑器屏幕。

| 项 | 状态 |
|---|---|
| `src/rendering/blocks.ts`：`CORE_BLOCKS` 升级为**契约**（每块声明 `attrs[{key,type,labelKey,fallback,required?}]`、`children?`、`media-list` 的 `itemKeys`）+ `BLOCK_ATTR_TYPES` 闭集合 + `blockSpec`/`blockAttrKeys` | ✅ |
| `GET /api/v1/blocks` 下发属性清单（标签按 UI 语言翻译，`itemKeys` 从契约转发） | ✅ |
| **新** `public/admin/js/block-fields.js`（叶子模块）：属性类型 → 控件的**唯一**映射（`RENDERED_ATTR_TYPES` + `renderBlockAttr(s)`）+ **块树的寻址与变更纯函数**（`locateBlock`/`insertBlock`/`setAttrAt`/`setItemAt`/`moveBlockAt`/…） | ✅ |
| `screens/editor.js`：逐属性出控件、写入**声明过的键**（不再恒写 `text`）；`group`/`columns` 渲染嵌套容器与内层面板；块标题用服务端翻译后的 label | ✅ |
| 新套件 `tests/suites/editor-blocks.test.mjs`（**40 条**）：契约 → 控件 → 写入的键 → **真实渲染器 markup** 的**往返**断言 + 嵌套寻址 + **§8 刻意的反向对照** | ✅ |
| 架构守卫（`architecture.test.mjs`，+9 条，规则 61）：**解析** `renderBlocks` 每个 case 体的 `a.<key>` 读取集合并与声明比对 / 每个声明块都有 case / `RENDERED_ATTR_TYPES` == `BLOCK_ATTR_TYPES` 且每种类型都有分支 / 每个 `media-list` 都声明 `itemKeys` | ✅ |
| `_skeleton-inject.mjs` 新增 **5 个场景**（渲染器读未声明的属性 / 契约改名 / 控件丢分支 / 导出清单漂移 / 丢 `itemKeys`）→ **28 场景 0 问题** | ✅ |
| `admin-contract.test.mjs` +7 条：调色板下发 `attrs`（类型/必填/翻译标签/`itemKeys`/容器标记） | ✅ |
| 规则 61 写进 `AGENTS.md` + `ARCHITECTURE.md` §10 | ✅ |

**本轮抓到的两类东西**（都值得单独记）：

1. **元守卫的盲区：`check(name, condition, detail)` 的 condition 传字面量恒为真。**
   我在新守卫里写成 `check(name, JSON.stringify(a), JSON.stringify(b))`——把期望值与实际值
   当成了条件与详情。**架构套件全绿**，是 `_skeleton-inject` 的"导出清单漂移"场景报
   `did NOT go red` 才发现的。修法两层：修正那一条，并把元守卫从"禁集合当条件"
   扩到"**禁字面量当条件**"（字符串/模板/数组/对象/`true`）。
   ⚠️ 元守卫只扫 `architecture.test.mjs` 自己，**其它套件里同样的拼法只能靠注入工具抓**。
2. **"声明了但没人读"的反向：契约自己漏了一半。** `media-list` 的条目键原本由 `api.ts`
   在出口处附加，契约本身不描述条目形状——于是**只用契约**（不经过 API）渲染控件时，
   画廊字段渲染成一个**没有任何输入框**的空字段。修法是把 `itemKeys` 声明在属性上（61c）。
   **判据**：一个控件如果需要调用方告诉它"你由什么组成"，那部分组成就还没被声明。

**新基线**：**24 套件 + `_schema-scope`，25 项 / 1296 条 / 0 失败**；`tsc --noEmit` src/ 0 错误；
`npm run gate` 四项全绿；`_skeleton-inject` 28/28 场景有效；`_tenant-query-audit` 每条命中都有裁决
（`api.ts` 的 `theme_installs` 一条随行号移到 `:1610`）。

### 批次 16 Track A3（统一媒体控件）—— ✅ 本轮完成

**起点是"多媒体管理和上传要全平台统一的控件"这条诉求。** 勘察发现需要它的地方有**三处**，
而其中**两处根本没有实现**：

| 消费点 | 之前 |
|---|---|
| 块的 `media` / `media-list` 属性 | 一个 URL 文本框（Track B1 之前连渲染都不对） |
| 内容自定义字段的 `media` / `media-multiple` | **`ALLOWED_FIELD_TYPES` 里一直有这两种，编辑器却没有分支** → 静默掉进默认文本框 |
| 主题/插件设置的 `media` / `media-multiple` | 一个 placeholder 写着 "URL in the media library" 的裸文本框 |

| 项 | 状态 |
|---|---|
| **新** `public/admin/js/media-picker.js`：`mediaUrl()`（唯一构造 `/media/<key>`）/ `mediaItem()`+`mediaItemsFromPayload()`（归一化）/ `mediaFieldHtml()`（**唯一的控件标记**）/ `pickerTileHtml`/`pickerGridHtml`（可测的网格）/ `openMediaPicker()`（搜索 + 网格 + **上传** + 单选/多选 + 取消） | ✅ |
| 控件职责收窄成"**把 URL 写进发起请求的 input 并派发 `input`/`change`**"——三个消费点因此**零新接线**（块属性有监听、设置表单 change 即存、自定义字段保存时读 `[data-meta]`）；交互由 `media-picker.js` **自己**注册一个 document 级委托，屏幕只要 import 就可用 | ✅ |
| `block-fields.js` 的 `media` 分支改用 `mediaFieldHtml`；`media-list` 每行走同一个控件 + 一个"从媒体库多选追加"按钮（`appendMediaAt` 按属性**声明的 `itemKeys`** 落值） | ✅ |
| `screens/editor.js` 自定义字段新增 `media` / `media-multiple` 分支（**补上从未存在的控件**） | ✅ |
| `screens/theme-menu.js` 的 media 分支改用同一控件（保留 `case` 标签，设置表单的类型守卫仍绿） | ✅ |
| `screens/media.js` 的三处手拼 `/media/` URL 收敛到 `mediaUrl()` | ✅ |
| 新套件 `tests/suites/media-picker.test.mjs`（**31 条**）：URL 形状（**编码后能被读取路径解回同一个 key**）/ 归一化（行与已存值两种输入）/ 坏 payload 不炸对话框 / 控件两种形态与转义 / **"选择器给的 URL，真实渲染器画得出来"** 的闭环（图片与画廊）/ 三个消费点都走共享控件 | ✅ |
| 架构守卫（+5 条，规则 62）：`data-media-field` / `data-media-pick` / `/media/${encodeURIComponent` **各只出现在 `media-picker.js`**（都配非空断言） | ✅ |
| `_skeleton-inject.mjs` +3 场景（屏幕自造控件 / 屏幕手拼 URL / URL 不再编码 key）→ **31 场景 0 问题** | ✅ |
| **真浏览器验收 `tests/tools/_media-picker-browser.cjs`（25 条，连跑两次全绿、自清理）**：真 Chromium 里登录 → 编辑器加图片块 → 打开对话框 → **在对话框里上传** → 选中 → URL 落进字段 → **保存后确认它写在 `url` 而不是 `text`** → 会话内可取到对象、匿名被拒 → 取消路径 | ✅ |
| 规则 62 写进 `AGENTS.md` + `ARCHITECTURE.md` §10；`core-pack.ts` 新增 8 个 `core.media.*`（en+zh 同步） | ✅ |

**浏览器验收当场抓到的一个真 UX 缺陷**：选完文件后**没有预览**。
块编辑器为了不丢焦点刻意不在每次输入时重渲染，而预览原本只在渲染时画一次——
于是"刚选好的图看起来没被采纳"。修法：控件里留一个 `[data-media-preview]` 槽，
选择器写值后就地刷新它（`mediaPreviewHtml`）。**这类缺陷只有真浏览器点一遍才会现形**，
Node 侧断言"标记里含有 `<img>`"永远是对的——因为它检查的是模板，不是交互。

**本轮最重要的一条**：**`check()` 现在要求条件是真正的布尔值**。
这个文件在**两个批次里累计三次**写出恒真断言——集合当条件、`JSON.stringify(...)` 当条件、
以及**数组当条件而把期望值放进了 detail**（正是本轮那次：`check("…", controlOwners, ["…/media-picker.js"])`）。
两次都是 `_skeleton-inject` 报 `did NOT go red` 才发现的，架构套件当时**全绿**。
词法模式只能禁"想到的拼法"，所以修法落在 `check()` 本身：**不是布尔就抛 `TypeError`**，
把这一整类变成一声巨响。词法守卫保留，作为更早、更友好的一层网。

**新基线**：**25 套件 + `_schema-scope`，26 项 / 1335 条 / 0 失败**；`tsc --noEmit` src/ 0 错误；
`npm run gate` 四项全绿；`_skeleton-inject` 31/31 场景有效。

`265d03c`：**目录分层 + 架构红线机器强制 + 运行时清单校验**（37 文件、+2827/−122）。

`d6e2239`：把 `public/admin/admin.js` 从 1514 行单文件拆成入口 + 4 个基础模块 +
18 个屏幕模块，新增 `tests/suites/admin-spa.test.mjs`。纯前端重构，`src/` 一行未动。

`48edc41`：**批次 2 —— 多语言四层（L0/L1/L2/L3）全部落地**，并把原属批次 3 的
「主题自有表」部分（DDL 生成 + 注册表 + facade + 沙箱端点）一起做了。
顺带修掉三个只在真实交互下才暴露的缺陷（见 §5 批次 2 与 §8 坑位 11–13）。

`fb2b012`（+`33f6369`，批次 4）：**脚手架三件套 + `contract/` 拆分 + 路由消费契约 +
eshop 范例主题 + 三份开发文档**。生成器全部可被 import（本机沙箱无法 spawn 子进程），
`tests/suites/scaffold.test.mjs` 68 条用真实校验器与真实模板引擎跑生成物。发现并修掉
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

**四条红线（`tests/suites/architecture.test.mjs` 机器强制，13 组检查）：**
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

### 批次 11–15（2026-10-08/09，全部完成——叙述见 §2 提交脉络）

| 批次 | 内容 | 基线 |
|---|---|---|
| 11 | 平台功能开关（`shared/features.ts` + Features 屏 + 规则 52–55） | `0aa6ed6` |
| 12 | savePost/deletePost/dashboard 写入路径修复 + PBKDF2 适配免费计划 CPU + handleApi try/catch + journal 主题 | `9e9dde5`/`f312143` |
| 13 | mobai 主题 + RSS `/feed.xml` + `cover` 派生 + `theme.strings` + 删除 ByteString 缺陷头 | `0f2bd7f` |
| 14 | slug 按语言（迁移 0016）+ hreflang + 按语言 feed + 切换器 + **规则 56–59 + `npm run gate`** | `7581387` |
| 15 | 数据驱动后台：块面板 / Dashboard 卡片（插件可注入）/ 声明式设置类型感知表单（迁移 0017） | `176331b` |

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
| 新套件 `tests/suites/i18n.test.mjs`（62 条）+ `tests/tools/_i18n-browser.cjs`（22 条，真实 Chromium） | ✅ |
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
| 新套件 `tests/suites/admin-menus.test.mjs`（43 条）+ 架构测试新增 3 项检查（共 13） | ✅ |
| 真实浏览器验收 `tests/tools/_admin-menus-browser.cjs`（31 条，连跑两次全绿） | ✅ |
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
| `tests/suites/scaffold.test.mjs`（68 条，真实校验器 + 真实模板引擎） | ✅ 已进 `npm test` |
| 修复「声明被校验但运行时没人读」第三、四例（`resolve.table` / `routes[].template`） | ✅ |
| `docs/guides/I18N.md` / `THEME-DEV.md` / `PLUGIN-DEV.md` | ✅（对着源码核对过，详见 ARCHITECTURE §4.4） |
| `themes/eshop/` 示例主题 + `tests/theme-eshop.test.mjs`（41 条） | ✅ 已进 `npm test`，七个注入场景逐条反向验证（`tests/_eshop-inject.mjs`） |
| **插件自有表** `plugin_{plugin}_{table}` | ⬜ 已登记：需**重建 `theme_table_defs`**（SQLite 不能 `ALTER` 主键/UNIQUE，而它现在只有 `theme_name` 一列） |

**本轮新增的两条引擎级守卫（都反向验证过）**：

1. **子模板未闭合 `{{@section}}` 直接抛错**。引擎原先靠「向后扫描有没有 `{{/section}}`」
   猜一个 `{{@section}}` 是定义还是插槽；猜错时子模板的 section 被当成插槽，
   布局渲染空 `<main>`——**HTTP 200、无异常**。现在用**文件事实**（`@extends` 了就是子模板，
   子模板永不提供插槽）把它变成结构性错误。
   ⚠️ 这个缺陷**真实存在于生成的骨架里**（四个子模板全漏了 `{{/section}}`），
   是 `tests/suites/scaffold.test.mjs` 渲染时才发现的。
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
| 新套件 `tests/suites/menu-custom.test.mjs`（40 条：API 契约 + 权限分层 + 校验 400s + 按站隔离 + **纯函数逻辑**） | ✅ 已进 `npm test`（16 套件 682 条） |
| 浏览器验收 v6 扩到 **47 条**：编辑器 11 条（改名 en/zh、组改名、组序、项序、跨组、站点隐藏、zh 回退、恢复默认） | ✅ 全绿 |
| 新套件 `tests/suites/account.test.mjs`（27 条，含 **label_key 翻译端到端**：zh-CN →「商品」、en → "Things"、无翻译回退原文） | ✅ 已进 `npm test`（15 套件） |
| 真浏览器验收 `.wrangler/eshop-verify.cjs` v5（38 条：前台 18 + 界面语言往返 + 服务端翻译菜单 + 菜单隐藏/恢复 + 账户三道闸门） | ✅ 全绿 |
| 主页接管收尾（批次 4 遗留验证）：`routes[]` 声明 `path: "/"` → 前台首页交给主题；home 闭包移到主题路由循环之后作 fallback | ✅ `/`、`/en`、`/zh-CN` 均渲染商品档案 |
| 反向验证：改密/改名守卫下沉 `platform/auth.ts` 后注入（绕过当前密码校验） | ✅ 注入 → 2 红，还原 → 27 绿 |
| **编辑器瘦身（用户反馈后重做）**：单编辑器、**行内全操作**——眼睛=站点级隐藏、箭头=排序、铅笔/点名字=展开改名/移动分组；删掉页面上全部说明文字与「我的显示偏好」面板（数据/API 保留） | ✅ `icons.js` 补 `eye`/`eye-off`；验收 v6 → **48 条**（含「无废话」断言） |
| **界面语言列表数据驱动（规则 40，用户反馈两次后定型）**：加语言 = Languages 屏数据操作，**零代码**。宇宙 = `CORE_PACKS` ∪ 平台字典 enabled ∪ 覆盖层 locale；唯一定义 `packs.ts availableUiLocaleEntries()`（切换列表与校验集同源）；缺 key 回退英文；菜单 label 语言数上限 4→8 | ✅ `packs.ts`/`core-pack.ts`/`api.ts`/`i18n.js`；i18n 套件新增 fr 数据驱动回归（3 条） |

**三条流程教训（本轮实测，详见 §8 坑位 21–23）**：真浏览器验收放在所有套件**之后**跑；
`api()` 非 2xx 时**抛 `Error(data.error)`**（`if (d.error)` 不可达，catch 里要 `explain(err.message)`）；
`ui_lang` 按用户持久化在 D1（**换浏览器也保持**，验收脚本登录后必须显式重置）。

### 批次 6–9 —— 多语言加固 / 规则 41 —— ✅ 已完成

详见 `docs/ARCHITECTURE.md` §8 路线图与 `docs/history/REVIEW-2026-09-29.md`（批次 6 审查报告）。
要点：**批次 6** 审查「多语言事实会不会在后续开发里丢失」，4 高危（`tableDelete` 跨站/删全语言、
theme-api 站点与主题头可伪造、`?? "default"` 地雷、四处 `|| "en"`）+ 3 中危全部修完，
新增 `resolveContentLocale()`（内容语言回退阶梯唯一定义）；**批次 7** 落地规则 41
（所有数据必须有多语言能力，`contract/manifest.ts` 的分类表 `PROSE_FIELD_TYPES` /
`LANGUAGE_NEUTRAL_FIELD_TYPES` + 四道结构守卫）。

### 批次 10（插件系统三支柱）—— ✅ 本轮完成

批次 10 把插件系统从「菜单 + hooks」扩成完整三支柱：**自有表（owner-agnostic）→
通知渠道（declare → host delivers）→ 声明式后台页面（declare → host renders）**。
设计全文在 `docs/design/PLUGIN-ARCHITECTURE.md`；八步交付顺序，每步独立可验证、每条新守卫都反向验证。

| 步骤 | 内容 | 状态 |
|---|---|---|
| 1 | 删除旧主题/插件（39 文件）+ 第十一种假绿修复 | ✅ `576fe6a` |
| 2 | 自有表 owner-agnostic：`theme_table_defs` 重建出 `owner_type` | ✅ `34c0bc9` |
| 3+4 | 渠道契约 + 插件页面契约 + 规则 48–51 校验 | ✅ `bcc856c` |
| 5 | 渠道运行时：webhook 实现 + claim-before-send 去重台账 + `PluginApi.notify` | ✅ `9487b40` |
| 6 | 后台渲染器：`plugin-page` 块渲染 + 渠道设置表单 | ✅ `9fd19db` |
| 7 | **`plugins/notify/` 示例插件**：`webhook` 渠道 + 三块 `adminPages` + `notify-settings` 菜单 | ✅ 本轮 |
| 8 | **`tests/suites/plugin-pages.test.mjs`（56 条）+ `tests/tools/_plugin-pages-inject.mjs`（10 场景反向验证）** | ✅ 本轮 |

**本轮（步骤 7+8）落实的四件事**：

1. **`plugins/notify/plugin.json` 真实存在**（`tests/suites/admin-menus.test.mjs` 从磁盘读它）。
   声明 `webhook` 渠道（`configSchema` 四字段）+ 一个 `deliveries` 页面（`stats`×2 /
   `table` / `form` 四种块）+ `notify-settings` 与 `notify-deliveries` 两个菜单 +
   `title_template`/`default_description` 设置。真实校验器接受。
2. **补上「插件自有表」最后一段未接线**：`syncOwnerTables` 早就支持 `"plugin"`，
   但**从没有人调用它**。经 `PluginTableSync` 提供者注入（规则 3 不允许 `plugin/` import
   `theme/`）按站点扇出——`plugin-pages` 套件证明启用插件会**真的建出物理表**并写注册表。
3. **`tests/suites/plugin-pages.test.mjs`（56 条）** 覆盖：未声明页面 id 被拒（规则 50）/
   块类型闭集合（规则 49）/ `form` 块写入落到**真实物理行**（不是 201）/ `stats` 聚合数字正确
   （含 `sum` 空集为 `null` 而非 0）/ 禁用插件菜单与页面从注册表消失 / 按站点租户边界 /
   **§9 渲染器真渲染**（读回 markup）。
4. **`tests/tools/_plugin-pages-inject.mjs`（10 场景）** 每个守卫注入一个真实缺陷、
   断言**具名断言**变红、还原、哈希一致。全部 0 problem。

**本轮新抓的两个「声明了但没人读」缺陷（200 + 内容错）**：

- **渲染器读错了字段路径**：表格端点答 `{ def: { fields }, items }`，渲染器却读扁平
  `data.fields` → 每个 `table`/`form` 块都画「这张表没有声明这些字段」——**HTTP 200、
  数据在线上完全正确**。修法：`sourceFields()` 先认 `data.def.fields`。
  **这个缺陷在本轮之前没有任何守卫**（`admin-spa` 只查模块图，`plugin-pages` 只查服务端），
  所以本轮给 `plugin-pages` 加了 §9「渲染器真渲染」——**唯一一条把 markup 读回来的断言**。
- **`tableAggregate` 无视 `status` 参数**：声明了却没消费，`sum`/`count` 的"空选择"断言
  因此假绿。修法是消费 `status` 并补一条对照断言（同选择下 `count` 应为真实的 0，
  以证明 `null` 是"没行"而不是"过滤被丢掉"）。


## 6. 测试与验证（当前全绿：25 套件 / 1314 条 / 0 失败，另有 `_schema-scope` 21 条 —— 合计 26 项 / 1335 条）

```bash
npx tsc --noEmit                 # src/ 0 错误（node_modules 里的 lib 冲突是既有的，忽略）
node tests/<name>.test.mjs       # 逐个跑（判据是 0 failures，别把断言数写死）
```

| 套件 | 数量 | 守什么 |
|---|---|---|
| architecture | 89 | 分层红线、默认值零容忍、清单声明与文件对齐、语言包 key 前缀、屏幕集合钉住、菜单引用的表存在、已退役表不再被引用、规则 41 分类表四道结构守卫、**规则 49/51 闭集合双表对比**、**规则 52–55 功能开关**、**规则 56–59 多语言与 URL**、**规则 60 媒体读取路径必须晚于站点解析（结构判据）**、**规则 61 块 attrs 契约：解析渲染器每个 case 的 `a.<key>` 读取集合与声明比对 + 控件覆盖每种类型 + `media-list` 必须声明 `itemKeys`**、**规则 62 媒体控件与 `/media/` URL 各只许一处构造**、**编辑器块面板来自 `CORE_BLOCKS`（SPA 禁块名字面量）**、**Dashboard 统计卡来自 API（禁 stat 硬编码）**、**声明式设置表单 13 类型逐个有渲染分支**、**元守卫：`check()` 条件非布尔即抛错 + 禁"集合当条件" + 禁"字面量当条件"** |
| _schema-scope | 21 | 迁移流应用到临时 SQLite，逐表检验「声明 vs 真实列」一致（租户 + 语言维度） |
| manifest-validation | 104 | 安装边界：每个用例注入单个缺陷，断言必须抛错（含内联语言包、菜单 args、**规则 48–51**、规则 41 双向） |
| admin-menus | 43 | 注册表 schema / `menuRowId` 防碰撞 / 归属隔离 / 排序 / 能力过滤 / 主题与插件注册 / 停用插件只删自己的菜单 / 新站点可见 / 切主题切回 |
| admin-spa | 19 | 后台模块图无环/无孤儿、`window.*` 契约、每个屏幕真渲染一次 |
| template-engine | 49 | 模板解释器单元（含子模板未闭合 section 抛错、三层继承最派生者胜） |
| scaffold | 71 | 生成的 theme/plugin/table 过**真实**校验器 + **真实**模板引擎 + **真实**架构规则 |
| theme-integration | 65 | 上传→激活→CPT→渲染→切主题保数据，端到端（含表驱动路由） |
| locale-url | 29 | 按语言 slug 的路由/404/唯一性、hreflang、按语言 feed、切换器（规则 56–59） |
| theme-fixture | 47 | fixture 主题的声明与模板自洽 |
| theme-journal | 39 | journal 主题：每个声明模板真渲染 + 边界作用域（无文章/无菜单/无描述） |
| theme-mobai | 52 | mobai 主题：模板真渲染 + head 的 SEO 契约（canonical/og/hreflang/feed）+ 语言包键完整性 |
| multisite | 91 | 多站点隔离（含 SEO 端点按站点、**§9 断言关掉 KV 镜像后确实没有 KV 写入**、**feed 按站点 + RSS 断言**） |
| i18n | 66 | 多语言四层契约（§5.4① 八条）+ 翻译组 + 主题自有表 |
| admin-contract | 51 | 后台 API 契约（含块面板形状/无漂移/en+zh 标签、**调色板下发的 attrs 契约（类型/必填/翻译标签/`itemKeys`/容器标记）**、dashboard cards 数组、设置 options 往返） |
| **media-picker** | **31** | **统一媒体控件（批次 16 Track A3 新增）**：`mediaUrl()` 的形状与**能被读取路径解回同一个 key** / `mediaItem()` 归一化（`media_files` 行与已存值两种输入、垃圾输入拒绝）/ 坏 payload 不炸对话框 / 控件的单值与多值两种形态 + 调用方寻址透传 + 转义 / **闭环：选择器给的 URL，真实渲染器画得出图片与画廊** / 三个消费点都走共享控件 |
| **editor-blocks** | **40** | **块 attrs 契约的往返（批次 16 Track B1 新增）**：契约良构（类型闭集合/标签/`itemKeys`）+ **契约 → 控件 → 写入的属性键 → 真实渲染器 markup** 的往返 + `required` 的语义（无 url 的图片渲染空）+ 嵌套寻址（子块按路径写入、父块不被穿透）+ **§8 反向对照**（按旧编辑器形状构造的图片/画廊/HTML 块必须渲染为空） |
| **media** | **69** | **媒体访问（批次 16 Track 0 新增）**：租户闸门（跨站 key → 404）/ 会话闸门 / **owner 硬隔离（含管理员）** / legacy `uploaded_by IS NULL` 的祖父条款 / 上传写归属 + 站点必须真实存在 / 列表按 owner 收窄 + `q`/`type`/分页/`total` / dashboard 媒体卡与列表 total 一致 / PATCH alt·title（非 owner 403、无 `media.write` 403、别站 id 404）/ **DELETE 先删 R2 对象再删行** / 脏策略行 fail-closed / **站点列表 memo 的 per-request 复位**（§1：先发前台请求 → 再建站点 → 再请求它） |
| account | 27 | 账户自助：改密/改名的当前密码闸门、稳定错误码、menu_prefs 隔离、label_key 翻译端到端 |
| menu-custom | 40 | 站点菜单编辑器三端点契约、权限分层、10 种结构违规 400、`applyMenuCustom` 纯函数语义 |
| plugin-hooks | 32 | 插件 hook 生命周期 |
| **plugin-pages** | **56** | **插件声明式后台页面（批次 10 新增）**：未声明页面 id 被拒（规则 50）/ 块类型闭集合（规则 49）/ `form` 块写入落到**真实物理行** / `stats` 聚合数字正确（`sum` 空集 = `null` 非 0）/ 禁用插件菜单与页面从注册表消失 / 按站点租户边界 / **§9 渲染器真渲染（读回 markup——本轮唯一一条把响应变成 HTML 再断言的守卫）** |
| plugin-channels | 55 | 通知渠道运行时：webhook fetch 计数、claim-before-send 去重（含跨站双向）、`readChannelConfig` 只读声明过的 key |
| **features** | **55** | **平台功能开关（批次 11 新增）**：列表与来源标注（site/var/default）/ **两层鉴权**（匿名被拒 + 非管理员 `author` 写 → 403，读只需会话）/ 保存往返 + 只落一行 + INSERT 分支 / **三层优先级逐层单独验**（站点行 > `env` var > 默认）/ 脏行降级 / 未知 key → 400 且不落库 / 屏幕接线 / UPDATE 分支（两次保存仍一行） |
| theme-worker | 37 | L3 沙箱（含 WorkerStub 不可跨请求）+ **§10 功能开关反向验证：`theme_runtime_worker` 关/删/显式 false/拼错时都不加载沙箱，站点设置关能压过 var 开** |
| launcher-parity | 57 | `cfpress.sh` ↔ `cfpress.ps1` 动作/菜单编号/套件表/退出码逐项对齐（解析结构，非 grep）+ BOM + 磁盘套件全集对齐 |

⚠️ **一跑必须有摘要行**：所有套件遵循「catch 里也打印摘要、崩溃标注 `(aborted)`」——
脚本判据统一是 `^[0-9]+ passed, [0-9]+ failed`，**匹配不到就当失败**（见「第六种假绿」）。
本轮清掉了三处**多余的第二个摘要行**（`admin-spa` / `i18n` / `architecture` 各自打过一个
`${X ? "1" : "0"} failure(s)`）——两个摘要两种拼法，正是 grep 抓错行、把崩溃读成通过的原因。

另有一个**不在 `npm test` 链里**的反向验证工具（`_tenant-query-audit.mjs`，跑得可当普通 suite）：

```bash
node tests/tools/_schema-scope.mjs           # 迁移流 → 临时 SQLite，逐表核对声明与真实列
node tests/tools/_tenant-query-audit.mjs     # 列出所有「碰租户表但不带 site_id」的语句；每条需书面裁决
```

⚠️ `_tenant-query-audit.mjs` 的 `REVIEWED` 表**键是 `file:line`**——任何在上方的编辑都会
把一条已裁决的语句挤成 `NEW`。本轮 `api.ts` 新增若干行后，`theme_installs` 那条从 `:1154`
移到 `:1187`，必须**重新键位**；同时补了 `notify.ts:108`（本批次的去重台账回写）的裁决。
跑它时 `NEW` 是**提示不是失败**，但每条都要有人看一眼。

插件系统的反向验证工具（手工跑，不进 `npm test`）：

```bash
node tests/tools/_plugin-pages-inject.mjs    # 10 场景：注入真实缺陷 → 断言具名断言变红 → 还原 → 哈希一致
```

**系统骨架 + 功能开关**的反向验证工具（10+ 场景，手工跑）：

```bash
node tests/tools/_skeleton-inject.mjs        # 31 场景：schema / 事件契约 / 断言拼法 / 功能开关 / 块面板 / 块 attrs 契约 / 媒体控件 / dashboard 卡 / 设置表单分支
node tests/tools/_locale-url-inject.mjs     # 4 场景：规则 56–59（slug COALESCE / 散落回退 / locale 正则 / feed 站点隔离）
node tests/tools/_launcher-inject.mjs        # 16 场景：启动器两侧对齐 / BOM / stderr 提示 / EOF 退出
node tests/tools/_media-inject.mjs           # 7 场景：规则 60（租户闸门 / 会话闸门 / owner 读闸门 / owner 列表子句 / 上传归属 / 删除顺序 / 分支位置）
```

⚠️ 这三个工具（`_skeleton` / `_launcher` / `_plugin-pages`）都用 **Worker 线程在进程内**跑套件——
本沙箱 `spawnSync` 一律 `EBUSY`，用子进程会把「跑不起来」伪装成「没变红」。
其 worker 入口**只由套件自己桩掉的 `process.exit` 收尾**（不能 `.then(() => done(0))`）：
`import()` 在模块体结束时即 resolve，**早于 `main()` 的第一个 `await`**，慢套件（esbuild 编译）
会确定性地输掉这场竞速、被读成「注入后没有摘要」——即把红读成 abort。见 §8 坑位 30。


第二个反向验证工具，守**规则 41（所有数据都有多语言能力）**：

```bash
node tests/tools/_i18n-field-inject.mjs      # 6 个场景，注入→断言按名字变红→还原→再断言干净
node tests/tools/_i18n-data-inventory.mjs    # 清点所有承载数据的声明类，列出还没有语言维度的
```

⚠️ **多套件共享同一个本地 D1**：断言必须按 owner 收窄（`theme_name` / 站点），
别写全局计数。`theme_table_defs` **按设计不随主题停用消失**，所以夹具必须删掉自己的注册行
**并且** drop 自己生成的表——否则下一套件会看到上一套件留下的东西
（i18n 套件已经因此假红过一次）。

另有两个**不在 `npm test` 链里**的真实浏览器验收脚本：

```bash
npx wrangler dev --port 47913 --ip 127.0.0.1     # 另开一个 shell
node tests/tools/_i18n-browser.cjs                     # 多语言：22 条断言
node tests/tools/_admin-menus-browser.cjs              # 菜单与生成式屏幕：31 条断言
node tests/tools/_media-picker-browser.cjs             # 媒体控件：25 条断言（批次 16 A3）
node .wrangler/eshop-verify.cjs                  # eshop 全链路 + 批次 5 新功能：47 条断言
```

⚠️ **`_media-picker-browser.cjs` 的 API 调用必须走页面自己的 `fetch`**（见坑位 43）——
用 `context.request` 会 401，因为会话 cookie 是 `Secure` 而 Playwright 的请求上下文
在 http 上不发它。

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

⚠️ **断言强度教训**（`tests/suites/multisite.test.mjs` 第 9b 段曾假绿）：断言必须盯住
"注入缺陷后必然会变的那一个值"。断言"XML 格式正确"这类东西等于没断言。
**上一轮又踩了一次同源的坑**：`tests/suites/admin-spa.test.mjs` 第一版断言"`render()` 没抛错"，
而 `render()` 自己 catch 住屏幕异常并换成 "Something went wrong" 面板 —— 于是注入一个
未定义标识符后测试依然全绿。现在断言的是**写进 DOM 的内容**（非空、不含错误面板）。

⚠️ **反向验证本身也会假绿**（本轮新增的第四种失败，见 `AGENTS.md`）：
为 `clearOwnerMenus` 写的归属隔离用例原本拿"主题 owner vs 插件 owner"对比，
于是把 `WHERE` 里的 `owner_name` 整条删掉**测试依然全绿**——两个 fixture 的 `owner_type`
本来就不同，`owner_name` 在这一次比较里是多余的。**被删掉的那一半必须是唯一区分
fixture 的那一项**；修正方式是再加一个**同类型**的第二个 owner（注入后 3 个 FAIL）。

⚠️ **新守卫必须反向验证**：写完守卫 → 故意注入一次违规 → 确认它 FAIL。测不出失败的检查等于没有检查。
本轮 6 项注入（见 §5 批次 3）全部如期变红。

## 6b. 线上部署与运维（免费计划）

**当前线上状态（2026-10-09）**：`cfpress.2aass.workers.dev` 已部署到批次 16 全部三个 track，
远端 D1 已到 **0018**（`wrangler d1 migrations list --remote` 报 "No migrations to apply"）。
部署前的线上抽查（方案文档里承诺的那一步）结果：**0 个媒体文件、0 处内容引用 `/media/`、1 个站点**——
所以规则 60 的两条行为变更（要求会话 + key 站点校验）当时**没有任何东西可破坏**。
⚠️ 一旦开始上传媒体并在内容里引用，`require_session` 默认**开**就意味着前台图片对匿名读者 404
（规则 60e）；Media 屏里改一行即可放开。
⚠️ 沙箱内**无法**用 HTTP 验证线上（代理拦截 `*.workers.dev`），只能靠 `wrangler deploy` 输出
+ `deployments status` 证明；要真验证请开浏览器。

- **部署顺序**：`wrangler d1 migrations apply cfpress --remote -c wrangler.local.jsonc`
  → `wrangler deploy -c wrangler.local.jsonc` → 主题文件有变化时逐个
  `wrangler r2 object put "cfpress-media/extensions/themes/<name>/<ver>/files/<path>" --file=… --remote`。
  **迁移必须先于 deploy**（新代码写新列，列不存在即 500；旧代码+新列无害）。
  ⚠️ **远端 `theme_installs` 有行 ≠ 远端 R2 有文件**（踩过两次的老坑）。
- **远端灌内容**：`wrangler d1 execute cfpress --remote --file=…`。大 SQL 会报
  `{"D1_RESET_DO":true}` → **按 ~4 条语句一批**分次执行。写完 bump
  `content_cache_versions` 让前台缓存失效。
- **监控**：沙箱/本地都无法访问 `*.workers.dev`（代理 502），用 Cloudflare **GraphQL
  analytics**（`api.cloudflare.com` 放行）查 `workersInvocationsAdaptive` 的
  `dimensions{status}`。⚠️ **标签 ≠ 根因**：`scriptThrewException` 那次的真因是 CPU 超限
  （Error 1102 不打这个标签）。
- **免费计划 = 单请求 10ms CPU**（付费 50ms，可调 3000ms）。`hashPassword` 的
  `PBKDF2_ITERATIONS = 25000`（≈3.5–5ms）就是按这个预算定的，**别调回 120000**
  （实测 22.4ms → 写库前被杀 → `site_users` 恒 0 → 登录报 "Request failed"）。
  迭代数写在 hash 串里，调高不破坏旧密码；任何"每请求都要跑"的重计算先问 10ms 够不够。
- **推送纪律**：`npx tsc --noEmit`（src/ 0 错误）+ `npm run gate` 全绿才许 push；
  push 后三路验证（`git rev-parse` == `git ls-remote` == `gh api …/commits/main`）。
- ⚠️ **待办**：之前曾在对话中泄漏过一个 Cloudflare API token（`cfut_` 开头，完整值见
  当时的对话记录，**不要写进本仓库**——GitHub secret scanning 会拒收推送，这也是它仍被视为
  泄露的证明）。应到 https://dash.cloudflare.com/profile/api-tokens 撤销。

## 7. 后台 SPA（两轮前拆分，批次 5 增 3 个模块，批次 10 再增 2 个，批次 15 数据驱动三面）

> 批次 15 起三块界面**只渲染平台下发的数据**，别在 SPA 里重新列清单：
> 编辑器块面板 ← `GET /api/v1/blocks`（`CORE_BLOCKS`）；Dashboard 统计卡 ← dashboard API 的
> `cards` 数组（插件经 `dashboardCards` filter 注入）；主题/插件设置表单 ←
> `theme/{name}/settings`，按 `ALLOWED_FIELD_TYPES` 逐类型渲染
> （architecture.test.mjs 有三节守卫盯着，硬编码即红灯）。

`public/admin/admin.js` 1514 行单文件 → 入口 + 6 个基础模块 + 屏幕模块
（`js/screens/` 现有 24 个文件：注册表 `index.js` + 23 个屏幕/工具模块）。

### 落点

```
public/admin/
├── admin.js             入口：装配 + window.* 注册（< 120 行）+ boot 时 cachedMessages()
├── ui.js  icons.js      UI kit / 图标
└── js/
    ├── state.js         state + api/scoped/contentPath/postTypeInfo/loadContext（叶子模块）
    │                    loadContext 同取 admin-menus/prefs → state.hiddenMenus（与菜单同取：
    │                    切语言重跑 loadContext 时两者同时刷新）＋ state.plugins（每个块
    │                    页面的声明来源）
    ├── i18n.js          ★ 批次 5：t()/loadMessages/setUiLocale（叶子中的叶子，谁都能 import 它）
    ├── plugin-page.js   ★ 批次 10：声明式插件页面的**渲染器**（谁都能 import 它，无状态）
    │                    导出 RENDERED_BLOCK_TYPES / RENDERED_AGGREGATES /
    │                    RENDERED_CHANNEL_FIELD_TYPES，架构测试按集合与契约对比
    ├── nav.js           baseGroups（分组带稳定 id）/ applyMenuCustom（★ 站点定制唯一应用点，
    │                    纯函数，侧栏与编辑器共用）/ navGroups（应用定制 + 双层隐藏过滤）/
    │                    navGroups / sidebar / header（语言下拉）
    ├── shell.js         render + go + switchSite + pageHead + 屏幕注册表 + 页名分发 + 语言切换委托
    ├── auth.js          renderLogin / doLogin / logout / setThemeForTest（登录成功后 loadMessages）
    ├── table-form.js    字段类型 → 控件 的唯一映射 + 值往返
    └── screens/         index.js（注册表）+ 23 个屏幕/工具模块
                         ★ account.js / menu-config.js 是批次 5 新增（都走 data-* 委托，零新 window.*）
                         ★ menu-config.js = 站点菜单编辑器（改名/排序/跨组/隐藏/恢复默认，
                           结构性变更物化显式 order，标签 change 即存、Enter 提交）+ 我的偏好双面板
                         ★ plugin-page.js 是批次 10 新增：`plugin-page:<id>` 屏幕——
                           声明从 state.plugins 读（单一事实源），每块独立加载数据
```

**`i18n.js` 是叶子中的叶子**：不 import 任何东西，所以包括 `ui.js` 在内的所有模块都能
依赖它而不成环。菜单标签**不在**这里翻译——`admin-menus` API 已在服务端把 `label_key`
换成译文，切换语言时 `setUiLocale → loadContext() → render()` 重取上下文即可。

**`plugin-page.js`（渲染器）是第二个「谁都能 import」的叶子**：无状态、不读 `state`，
只吃 `(decl, dataBySource)` 返回 HTML。它存在的原因是**插件不能带可执行代码**
（Workers 禁 `eval`/`new Function`/动态 import），所以插件声明 `blocks[]`、宿主负责画。
这是同一个模式的第三次应用，前两次是 `tables[].fields[]`（宿主生成 CRUD 表单）与
`channels[].configSchema`（宿主生成设置表单）。**加了新块类型要改三处**——契约、
`RENDERED_BLOCK_TYPES`、渲染器 switch——漏一处是架构测试失败，而不是 200 的空面板。

**关键设计：`shell.js` 不 import 任何屏幕。** 屏幕通过 `setScreenTable(SCREENS)`
自注册，登录屏通过 `setLoginScreen(renderLogin)` 注入 —— 否则
`shell → screens → shell` 立即成环。`extension-install.js` 独立出来是为了
不让"主题屏"依赖"插件屏"。屏幕内的 `window.xxx()` 调用已全部改为直接调用导入的函数。

### 页名分发（批次 3 定形，批次 10 加第五个前缀）

`shell.js` 按前缀分发页名：`menu:<id>`（扩展菜单）、`table:<t>`（列表）、
`table-new:<t>`（新建）、`table-edit:<t>:<slug>`（编辑）、**`plugin-page:<id>`（批次 10）**。
**必须保持三前缀分离**——
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

### 配套测试 `tests/suites/admin-spa.test.mjs`（15 条）

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

**上一轮（多语言）**：`tests/tools/_i18n-browser.cjs`，22 条断言，见 §6。
它把「语言开关 → 编辑器语言版本条 → 建翻译 → 删翻译」这条链在真浏览器里走通，
并证明**界面上真的多了一块、又真的少回去**——而不是只证明接口返回了 200。

**本轮（菜单 + 生成式屏幕）**：`tests/tools/_admin-menus-browser.cjs`，31 条断言，见 §6。
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
26. **「声明了但没人读」缺陷族又添两员（批次 10）**：字段被校验、运行时没人消费 → **200 + 内容错**。
    ① 插件列表 API 把 `adminPages[]`/`channels[]` 存成 JSON **字符串**（透出了但读不了）；
    ② 渲染器读扁平 `data.fields` 而端点答 `data.def.fields`（每块都画"表没有这些字段"）；
    ③ `tableAggregate` 声明了 `status` 参数却从没消费它（空选择断言因此假绿）。
    **加字段时先找它的消费点，找不到就别加**——同一个病在本仓库已经出现七次。
27. **守卫的"观测面"决定了它能抓到什么（批次 10 的核心教训）**。渲染器字段路径的缺陷
    **在服务端断言里根本不可见**：`plugin-pages` 起初只查 API 与 DB，注入该缺陷后
    `admin-spa`（只查模块图）与 `plugin-pages`（只查服务端）**双双全绿**。
    修法不是再加一条服务端断言，而是**加一条把响应变成 HTML 再读回来的断言**（§9）。
    **推论**：一条守卫只能证它观测的那一层；"测试全绿"不代表"这个缺陷有人看着"。
28. **反向验证工具不要把「套件自己 abort」当成「读不到摘要」**。`_plugin-pages-inject.mjs`
    原本一见 `(aborted)` 就报"no summary"，于是"缺表"那个真实红（`18 passed, 5 failed`）
    被当成**坏了运行器**而不是**坏了守卫**。分开两个概念：`aborted` = **没有可解析的摘要**；
    `selfAborted` = 套件自己走进了 catch（摘要仍可读）。**没有摘要才算失败**，
    有摘要的 abort 就是一份真实证据。
29. **`_tenant-query-audit.mjs` 的裁决表键是 `file:line`**，任何上方编辑都会把一条
    已裁决语句挤成 `NEW`。改完 `src/api.ts` 之类的文件后跑一次，**报了 `NEW` 就重新键位**
    （本轮 `theme_installs` 那条从 `:1154` 移到 `:1187`）。`NEW` 是提示不是失败，
    但每条都要有人写一句为什么会话安全的裁决。
30. **注入工具用 `import().then(done)` 收尾 → 慢套件被读成 abort**（批次 11 新增的假绿形态）。
    `import()` 在模块体执行完就 resolve，**早于套件 `main()` 的第一个 `await`**；
    worker 线程由谁先结束谁说了算。esbuild 编译慢的套件（`features`）确定性输掉，
    症状是「注入后没有摘要」——**把一次真红读成运行器坏了**。修法：worker 入口
    **只由套件自己桩掉的 `process.exit` 收尾**，并用 `reported` 守卫保证只结算一次。
    已在 `_skeleton-inject` / `_launcher-inject` / `_plugin-pages-inject` 三处修掉。
31. **注入的缺陷让套件自己抛错时，红会被"崩溃"盖住**。开关场景把 settings key 改成
    `cfpress.features-typo` 后，断言 `rows[0].value` 在空数组上抛、逃出 `main()`、
    **摘要行根本没印** → 工具报 `no summary`（= abort）而不是「这条断言红了」。
    三层修法：① 断言先查 `rows.length` 再用带守卫的 `JSON.parse` 读元素；
    ② **每个 section 包 `section()`**，抛错记一条 FAIL 而不是中断整轮；
    ③ 夹具在**开头和结尾都前缀删**（`LIKE 'cfpress.features%'`）——中途崩溃不再留脏行。
32. **测试一条路由的权限，别用"匿名被拒"当判据**。`api.ts` 里 `requireAdmin` 是**全局闸门**，
    它下面每条路由都已过会话校验——所以"匿名请求被拒"**对任何一条路由都成立**，
    测不出这条路由自己的闸门。要验证 `settings.manage`，必须造一个**非管理员**用户
    （`features.test.mjs` 用 `/api/v1/users` 造了个 `author` 角色用户），
    否则 `can()` 会把 `role === "admin"` 短路成 true。这正是场景「drops its permission check」
    第一版**没变红**的原因。
33. **写入路径的判据必须是查询结果，不是入参形状**。`savePost` 对「带 id 的 PUT」曾只做
    UPDATE（SQLite 零行更新不报错）→ 孤儿翻译行 + 假成功 200；publish-only 的 PUT 又曾把
    URL 改名成 entityId（`tSlug || entityId` 兜底只在 CREATE 分支合法）。`deletePost` 曾
    不校验站点归属。三者同根：**先查行在不在、属不属于这个站，再写**。
34. **多套件顺序跑也可能偶发 1 红**（`menu-custom` / `plugin-pages` 各出现过 1 次，共享本地 D1）。
    症状：链内 1 条 FAIL、单独跑与链段重跑全绿、失败套件不碰你改的代码。先单独跑、
    再跑一次链段确认；**两次独立全绿才能写成基线**。别把偶发当成自己的改动引入的回归，
    也别不加验证就当成"环境问题"放过。
35. **`{{#each x}}` 不写 `as` 时绑定的是 `this`**——循环体内直接写 `{{字段}}` 得到空，
    200、零异常。必须 `{{#each x as item}}`。三处新主题模板同时踩过，探针/DOM 检查才现形。
36. **三条闸门都答 404 时，断言"404"等于没断言**（观测面层的又一例，批次 16）。
    `/media/<key>` 有租户 / 会话 / owner 三条独立闸门，全部返回 404。套件若只在三条全关时
    断言"取不到"，**删掉任何一条都不会变红**——另外两条还站着。修法两条：
    ① 决策函数返回**原因**（`site`/`session`/`owner`/`missing`）而不是布尔；
    ② 套件把闸门**逐条单独打开**（把其余策略放宽到只剩它），再断言那一刻的 404。
    `_media-inject.mjs` 7 个场景就是按这个形状逐条注入的。
37. **以 `env` 为键的"per-request" memo，实际生命周期是 isolate**（批次 16 抓到的真缺陷）。
    `platform/sites.ts` 的站点列表 memo 注释写着 per-request，但 `env` 在 Workers 里跨请求复用
    → 站点列表被冻结到 isolate 回收为止 → **新建站点在前台解析不到**（host 与 path 前缀都落到
    默认站），单站点安装完全看不出来。修法：入口每请求 `resetSiteListMemo(env)`。
    一般规律：**注释声称的作用域要和键的作用域一致**，否则缓存会替你记住不该记的东西。
38. **写测试时的两种假绿，本轮在自己的套件里各踩一次**（批次 16）。
    ① `setPolicy` 忘了带 `?site=` → 策略写到 `default` 站 → §4 那条断言红了（这次是好事，
    它暴露了问题），但 §10 三条断言**空转通过**，因为它们改的那行根本不存在；
    ② 修法是补 **non-vacuity 断言**（"策略确实落在这个站上" / "确实改动了 1 行"）。
    **写"某行被改坏后应当拒绝"的断言时，先断言那行真的存在且真的被改坏了。**
39. **`check(name, condition, detail)` 的 `condition` 传字面量，恒为真**（批次 16，第九种假绿）。
    `check("…", JSON.stringify(a), JSON.stringify(b))` 把**期望值与实际值当成了条件与详情**——
    读起来像在断言"两者相等"，实际断言的是"一个非空字符串为真"。架构套件**全绿**，
    是 `_skeleton-inject.mjs` 的场景报 `did NOT go red` 才发现的：
    **注入工具的价值不在于它跑得多，而在于它逼你把每条守卫看一次它的红。**
    修法两层：改掉那一条，并把元守卫从"禁集合当条件"扩到**"禁字面量当条件"**
    （字符串 / 模板串 / 数组 / 对象 / `true`）。
    ⚠️ 元守卫只扫 `architecture.test.mjs` 自己——**其它套件里同样的拼法只能靠注入工具抓**。
40. **契约漏掉一半时，症状是"控件渲染成一个空字段"**（批次 16）。
    `media-list` 的条目键原本由 `api.ts` 在出口处附加，契约本身不描述条目形状；
    于是**只用契约**（不经过 API）渲染控件时，画廊字段渲染成**没有任何输入框**的空字段。
    修法：把 `itemKeys` 声明在属性上（规则 61c）。
    **判据：一个控件如果需要调用方告诉它"你由什么组成"，那部分组成就还没被声明。**
    与 26 号坑（"声明了但没人读"）互为镜像：**这一族缺陷的两个方向都要有人看**。
41. **`check(name, condition, detail)` 的恒真断言在本仓库已出现三次，全在同一个文件**（批次 16）。
    ① 集合当条件（`check("…", offenders, [])`）；② `JSON.stringify(a)` 当条件；
    ③ **数组当条件、把期望值放进了 detail**（`check("…", controlOwners, ["…/media-picker.js"])`）。
    三次架构套件都**全绿**，三次都是 `_skeleton-inject` 报 `did NOT go red` 才发现的。
    **词法模式只能禁"想到的拼法"** —— 所以修法落在 `check()` 本身：
    **条件不是布尔就抛 `TypeError`**，把这一整类变成一声巨响；词法守卫（禁集合、禁字面量）
    保留为更早更友好的一层网。
    推论：**"我加了一条守卫"和"这条守卫能红"是两件事**，而只有注入工具能分辨它们。
    凡新增具名断言，必须先在注入工具里补一个场景——这不是纪律，是唯一可靠的检查。
42. **`await` 写进非 async 的委托函数**（批次 16）：`document.addEventListener("click", (e) => { … await … })`
    在**解析期**就是 `SyntaxError: Unexpected reserved word`，模块整体加载失败。
    症状不是"这个功能不生效"，而是**后台整个起不来**。
    抓它的是 `admin-spa.test.mjs` 的"入口能启动"那一条（真实 import 入口 + DOM 替身）——
    静态模块图检查看不见语法错误（它只解析 import 说明符）。
    **一条"真的 import 一次"的断言，价值高于十条文本扫描。**
43. **浏览器验收脚本不能用 `context.request` 调这个后台的 API**（批次 16）：
    会话 cookie 是 `Secure`，而 Playwright 的 `APIRequestContext` **不套用浏览器那条
    "localhost 可信"例外**，于是它一个 cookie 都不发，每个调用都是 401——
    而同一个 context 里的**页面**明明是已登录的。症状极具迷惑性：上传成功（页面发起）、
    随后用 `context.request` 查库却 401，看起来像"上传没落库"。
    **正解**：走页面自己的 `fetch`（`page.evaluate`），本目录既有的两个验收脚本就是这么做的。
    另一条同源陷阱：**先用 `context.request` 登录会把浏览器也登录掉**，登录屏因此永远不出现，
    `#u` 等到超时——登录必须由页面驱动。
44. **块编辑器不重渲染，所以"选完之后的样子"要自己刷新**（批次 16）。
    预览只在渲染时画一次 → 选完文件看不到缩略图，读起来像"没选上"。
    Node 断言"模板里有 `<img>`"永远是对的（它检查模板，不检查交互），**只有真浏览器能发现**。
    修法是控件里留一个可被就地刷新的槽（`[data-media-preview]`）。
    **推论：凡是"用户做了一个动作、界面应当立刻变化"的地方，都必须有真浏览器验收。**

## 9. 权威文档索引

| 文档 | 内容 |
|---|---|
| `docs/ARCHITECTURE.md` | **唯一权威**：多语言 §2、主题 §3、插件 §4、防错 §5、表总览 §6、分层 §7、路线图与进度 §8、已确认决策 §9、假绿记录 |
| `docs/design/PLUGIN-ARCHITECTURE.md` | 插件系统三支柱设计全文（自有表 / 通知渠道 / 声明式后台页面）+ 八步交付顺序 |
| `docs/history/HANDOVER-PLUGIN-BATCH.md` | 批次 10 过程存档（步骤 1–6 细节、用户拍板决策、本轮新坑） |
| `AGENTS.md` | 改代码前的硬规则清单（红线、清单规则、后台 SPA 规则、共用定义规则、菜单注册表规则 32–37、**插件规则 48–51**、**功能开关规则 52–55**、**多语言与 URL 规则 56–59 + `npm run gate`**、**媒体隔离规则 60**、**块 attrs 契约规则 61**、**媒体控件规则 62**、明确不做的事） |
| `docs/HANDOVER.md` | 本文 |
| `src/shared/features.ts` | **功能开关唯一词汇表 + 解析器**（`FEATURE_SWITCHES` / `featureEnabled()` / `featureSnapshot()`）——开关定义只此一处 |
| `public/admin/js/screens/features.js` | 功能开关后台屏（每开关一张卡：来源标注 / var 名 / 声明默认 / 继承值 / 重置为继承） |
| `tests/suites/features.test.mjs` | 功能开关 API 契约（两层鉴权 / 三层优先级 / 脏行降级 / 未知 key 400 / INSERT+UPDATE 分支 / 屏幕接线） |
| `tests/tools/_skeleton-inject.mjs` | 骨架 + 开关 + 数据驱动后台的反向验证工具（**23 场景**：schema/事件契约/断言拼法/开关/块面板/dashboard 卡/设置表单分支） |
| `tests/tools/_locale-url-inject.mjs` | 多语言与 URL 规则 56–59 的反向验证工具（4 场景） |
| `tests/suites/architecture.test.mjs` | 分层与越界守门人（分层红线 + 默认值 + 闭集合双表对比 + 规则 41 分类表 + **规则 52–55 开关守卫 + 规则 56–59 多语言守卫 + 块面板/dashboard/设置表单三节**） |
| `tests/suites/admin-menus.test.mjs` | 菜单注册表契约（归属隔离 / 安装级可见 / 停用只删自己 / 切主题切回） |
| `tests/suites/i18n.test.mjs` | 多语言四层契约（§5.4① 八条 + 翻译组 + 主题自有表 + 9b 段 `lang_group` 回归） |
| `tests/suites/locale-url.test.mjs` | 按语言 slug 的行为契约（两种存储形态的路由/404/唯一性/hreflang/按语言 feed/sitemap；规则 58 的行为面） |
| `src/platform/media-policy.ts` | **媒体访问策略的唯一定义**（规则 60）：`isolation` / `require_session`（站点设置行 `cfpress.media`）+ `mediaKeyBelongsToSite` + `mediaReadDecision`（**返回拒绝原因**）+ `mediaOwnerClause`——前台读取路径与后台 API 共用同一份 |
| `tests/suites/media.test.mjs` | 媒体两轴（租户 / 所有者）的契约：三闸门**逐条单独打开**再断言、删除顺序、legacy NULL 祖父条款、站点列表 memo 的 per-request 复位 |
| `tests/tools/_media-inject.mjs` | 上者的反向验证工具（7 场景，注入→具名断言变红→还原→哈希一致；手工跑，不在 gate 里） |
| `src/rendering/blocks.ts` | **块属性契约的唯一定义**（规则 61）：`CORE_BLOCKS`（每块的 `attrs[]`/`children`/`media-list` 的 `itemKeys`）+ `BLOCK_ATTR_TYPES` 闭集合——渲染器与编辑器控件都从它派生 |
| `public/admin/js/block-fields.js` | 块属性的**控件唯一映射**（`RENDERED_ATTR_TYPES` + `renderBlockAttr(s)`）+ **块树寻址与变更的纯函数**（无状态叶子，可脱离 DOM 测试） |
| `tests/suites/editor-blocks.test.mjs` | 块 attrs 的往返契约（契约 → 控件 → 写入的键 → 真实渲染器 markup + 嵌套寻址 + §8 反向对照） |
| `public/admin/js/media-picker.js` | **媒体控件的唯一定义**（规则 62）：`mediaUrl()`（唯一构造 `/media/<key>`）/ `mediaItem()` 归一化 / `mediaFieldHtml()`（唯一控件标记）/ `openMediaPicker()`（搜索 + 网格 + 上传 + 单选多选）——块属性、自定义字段、扩展设置三处共用 |
| `tests/suites/media-picker.test.mjs` | 上者的契约：URL 形状与读取路径一致 + 归一化 + 控件形态 + **"选择器给的 URL，真实渲染器画得出来"的闭环** + 三个消费点都走共享控件 |
| `tests/tools/_media-picker-browser.cjs` | 上者的**真浏览器**验收（25 条，自清理可重复）：登录 → 加图片块 → 对话框内上传 → 选中 → 落值 → **保存后确认写在 `url` 而非 `text`** → 会话/匿名两种读取 → 取消路径 |
| `docs/design/MEDIA-EDITOR-PLAN.md` | 批次 16 的四轨道拆分（**Track 0 / B1 / A3 已实现，A4 / B3 / B4 / B5 未实现**）——含已拍板的媒体语义与编辑器缺陷清单 |
| `tests/tools/_i18n-browser.cjs` | 多语言后台的真实浏览器验收（22 条，自清理，可重复跑） |
| `tests/tools/_admin-menus-browser.cjs` | 菜单 + 生成式屏幕的真实浏览器验收（31 条，自清理，可重复跑） |
| `tests/suites/admin-spa.test.mjs` | 后台 SPA 的结构守门人（模块图 + `window.*` 契约 + 逐屏渲染） |
| `tests/suites/account.test.mjs` | 账户自助与菜单偏好契约（当前密码闸门 / 稳定错误码 / prefs 隔离 / label_key 翻译端到端） |
| `tests/suites/plugin-pages.test.mjs` | 插件声明式后台页面契约（规则 49/50 + `form` 写入落真表 + `stats` 聚合 + 禁用清理 + **渲染器真渲染**） |
| `tests/tools/_plugin-pages-inject.mjs` | 上者的反向验证工具（10 场景，注入→具名断言变红→还原→哈希一致） |
| `tests/tools/_tenant-query-audit.mjs` | 租户查询审计（列出所有碰租户表但不带 `site_id` 的语句，逐条书面裁决；键是 `file:line`） |
| `.wrangler/eshop-verify.cjs` | 全链路真浏览器验收（语言状态自愈，需 `wrangler dev`） |
| `src/platform/seo.ts` | sitemap / robots / **feed（RSS 2.0，按站点+按语言）**——SEO 三端点都必须接收并使用 `siteId`（规则 59） |
| `src/shared/features.ts` 之外的第二词汇表：`src/rendering/blocks.ts` 的 `CORE_BLOCKS` | **可插入块类型的唯一定义**——编辑器面板经 `GET /api/v1/blocks` 下发，SPA 里出现块名字面量即架构红灯 |
| `docs/HANDOVER.md` | 本文 |
| `.workbuddy-ai/memory/` | 工作日志（按天）+ `MEMORY.md`（长期记忆）——本机文件，不入库 |
