# 媒体子系统与内容编辑器 —— 批次 16 方案

> 状态：**Track 0 与 Track B1 已完成**（隔离地基：迁移 0018 / 读取路径三闸门 / 媒体 API 补全 /
> 媒体套件 / 注入工具 / 规则 60；块 attrs 契约：`CORE_BLOCKS` 契约 / `block-fields.js` 控件 /
> 往返套件 / 规则 61）。Track A（媒体子系统与统一控件）、B3（编辑器界面翻译）、
> B4（多语言编辑体验）、B5 的 `post_meta` 语言维度**仍未实现**。
> 落地后的编号已进 `ARCHITECTURE.md` §10 规则 60 与 `AGENTS.md`，过程记录进 `HANDOVER.md` §5。
> 读者：接下来实施本批次的会话。动手前先读 `AGENTS.md`（硬规则）与 `docs/HANDOVER.md` §8（坑位清单）。
>
> 本文是**唯一**记录批次 16 拆分的地方。之所以先写计划再动手：本批次同时触碰
> 数据（迁移）、渲染（块 attrs）、后台 SPA（编辑器 + 媒体 + 新控件）与访问控制
> （站点/用户隔离）四条线，任何一条单独改都会在另三条上留下"200 + 内容错"式的静默失败。

## 0b. 已拍板的语义（2026-10-09）

| 议题 | 决定 |
|---|---|
| 用户隔离强度 | **硬隔离，含管理员**（`isolation: "owner"`）。legacy `uploaded_by IS NULL` 的行按站点内可见的**祖父条款**处理，否则升级会让运营者已有的库整个消失 |
| `/media/<key>` 访问模型 | **站点校验 + 要求会话**（`require_session` 默认**开**）。⚠️ 后果：未登录访客取不到任何媒体，前台 `<img>` 会 404。已实现为站点设置，可一行放开 |
| 自定义字段（`post_meta`） | **给 `post_meta` 加 `locale` 列**（Track B5，未做） |
| 起手顺序 | **Track 0**（已完成） |

> 实施期新发现并已修掉的两件事，未在原始计划里：
> ① `platform/sites.ts` 的站点列表 memo 以 `env`（isolate）为键且从不清理 →
> 新建站点在前台解析不到（详见 `AGENTS.md` 规则 60 末段）；
> ② `media.test.mjs` 自己踩到的两个假绿（`setPolicy` 漏 `?site=`；§10 的 `UPDATE` 匹配 0 行
> 却让三条断言空转通过）——两个都补了 non-vacuity 断言。


---

## 0. 为什么是这四件事

用户本轮的原话拆成四条诉求：

| 诉求 | 现状 | 结论 |
|---|---|---|
| 后台文章/页面编辑要跟进 | 编辑器能存能取，但**写出的数据渲染器读不到**（见 §1.1） | 真缺陷，必修 |
| 多语言用户体验差 | 编辑器/媒体屏**零界面翻译**；语言版本条是只读导航；`#locale` 下拉会改行归属 | 真缺陷，必修 |
| 多媒体管理与上传要全平台统一控件 | 全仓库**不存在**任何媒体选择控件；图片块要手输 URL | 从零新建 |
| 站点独立 / 用户隔离 / 资源文件隔离 | 站点维度**只有一半**（写入有、读取没有）；用户维度**完全没有** | 真缺口，必修 |

---

## 1. 勘察结论（对着源码核过，不是推测）

### 1.1 十二种块里有六种从后台插入后前台渲染为空

`public/admin/js/screens/editor.js` 对**所有**块类型只维护一个 `attrs.text`：

- `addBlock(t)` → `{ type: t, attrs: { text: "" } }`
- `updateBlock(i, v)` → `attrs.text = v`
- 界面：`drawBlocks()` 每个块画一个 `<textarea data-block-input>`

而 `src/platform/frontend.ts` 的 `renderBlocks` 按类型读**不同的** attr：

| 块类型 | 渲染器读 | 编辑器写 | 结果 |
|---|---|---|---|
| `core/paragraph` `core/heading` `core/quote` `core/code` `core/list` | `attrs.text` | `attrs.text` | ✅ |
| `core/image` | `attrs.url` + `attrs.alt` | `attrs.text` | ❌ **渲染为空** |
| `core/gallery` | `attrs.items[]` | `attrs.text` | ❌ **渲染为空** |
| `core/button` | `attrs.url` + `attrs.text` | `attrs.text` | ⚠️ 文字在、链接丢（永远 `#`） |
| `core/html` | `attrs.html` | `attrs.text` | ❌ **渲染为空** |
| `core/group` `core/columns` | `block.content[]`（嵌套） | 无嵌套概念 | ❌ **渲染为空** |
| `core/separator` | 无 | `attrs.text` | ✅（多余字段） |

症状是 **HTTP 200 + 空正文、零异常、零 5xx**——正是本仓库记录在案的
「声明先于运行时」缺陷族的**第八例**（前七例见 `ARCHITECTURE.md` §12 与 `HANDOVER.md` §8 坑位 26）。

根因不是"写错了一个字段名"，而是**块的 attrs 契约没有唯一定义**：
渲染器 switch 里的 attr 名是隐式的，编辑器只能猜。所以修法必须是
**把 attrs 契约提成一份声明，编辑器与渲染器同时从它派生**（§4 Track B1），
而不是把 `attrs.text` 换成六个 `if`。

### 1.2 媒体：写入有站点维度，读取没有

- `media_files` 建表于 `0003_admin.sql`，`0009_v080_multisite.sql` 只加了 `site_id`。
  **没有 `uploaded_by`** → 用户维度完全不存在。
- R2 键形如 `uploads/{siteId}/{YYYY-MM-DD}/{id}-{safe}` → **写入侧站点隔离是对的**。
- 但 `src/index.ts` 的 `/media/` 分支在**站点解析之前**、**鉴权之前**直接
  `env.MEDIA.get(key)` 并原样返回：

  ```
  if(u.pathname.startsWith("/media/"))return media(env,u);   // 站点解析在它下面几十行
  ```

  所以：① 任何站点、任何未登录访客，只要知道 key 就能取；② 没有"这个 key 属于本站"的校验
  ——把 A 站的 key 拼到 B 站域名下同样返回 200。这是**资源文件隔离**的缺口。
- `media_files` 有 `width` / `height` 两列，**从建表至今没有任何代码写过**（"声明了没人写"）。
- 无删除、无更新 alt/title、无分页（`LIMIT 200` 硬编码）、无搜索、无类型过滤。
- `alt_text` / `title` 在 `contract/schema.ts` 里明确标注为**语言中立**（by design）。
  这是决策不是缺陷，但后台 UI 必须说清楚，否则多语言站上作者会以为每个语言有自己的 alt。

### 1.3 界面翻译只覆盖了四个模块

接了 `t()` 的只有 `js/nav.js`、`js/auth.js`、`js/shell.js` 与
`screens/{account,languages,menu-config}.js`。**编辑器、媒体、内容列表、Dashboard、
插件屏、表屏、设置屏全部是硬编码英文**（`grep -c '\bt('` 均为 0）。

核心语言包 `core-pack.ts` 现有约 120 个 key，**没有任何 `core.editor.*` / `core.media.*`**。
所以"切到简体中文"之后，用户看到的编辑器仍然是英文——这就是"多语言用户体验差"最直接的那一层。

### 1.4 编辑器的其余多语言问题

- `#locale` 下拉在**编辑既有内容**时是危险的：`saveContent` 把它的值直接当 `body.locale` 发出，
  于是"切到法文版"被实现成"把这一行改成法文版"，与语言版本条（真正正确的入口）语义冲突。
- `publishAt` 是 `datetime-local`，但 `editContent` **不回填** `publish_at` → 编辑一篇已排期文章
  并保存，会把排期时间清成 `null`（静默取消排期）。
- 自动保存的 `setInterval` 只在 `[data-back]` 与保存成功时 `clearInterval`；
  从侧栏切到别的页面（走 `go()`，不经 `[data-back]`）**不清** → 定时器泄漏，在别的屏幕上继续 POST。
- 自定义字段（`fieldInputs`）文案硬编码（"Custom fields" / "Yes" / "No"），
  且背后是 `post_meta`（schema 里 `locale: null`）→ **跨语言共享**，界面上毫无提示。

### 1.5 全平台统一控件：目前不存在

"统一的控件"在本仓库有现成范式，且已经用过两次：
`i18n.js`（叶子中的叶子，谁都能 import）与 `js/plugin-page.js`（无状态渲染器）。
媒体选择器应当是**第三次应用**：一个无状态叶子模块，被编辑器块、自定义字段、
主题/插件设置表单共同复用——而不是每个调用点各写一个 `<input type="file">`。

---

## 2. 三条要拍板的语义（实施前必须定）

这三条不是实现细节，是**产品语义**；定错了后面每一步都要返工。

### 2.1 用户隔离的强度

| 方案 | 含义 | 代价 |
|---|---|---|
| **A. 记录上传者 + 全站可见**（推荐） | `uploaded_by` 落库，媒体库是**站点资产**；提供"只看我上传的"筛选；`admin`/`editor` 都能看全站 | 最弱隔离，但符合 CMS 常识：作者要复用别人的图 |
| B. 角色 × 上传者 | `editor` 只看自己的；`admin` 看全站 | 作者之间无法复用素材，容易"同一张图传十遍" |
| C. 硬隔离 | 每个用户只看自己的，管理员也不跨 | 站点级主题配图/logo 无法被普通作者引用 |

**推荐 A**，并把隔离强度做成**站点设置里的一个开关**（与 `features.ts` 同一模式，
但这是站点级策略而非平台开关，落在 `settings` 表的 `cfpress.media.isolation`）。
这样"用户隔离"是真的（可开启），且默认不破坏可用性。

### 2.2 `/media/<key>` 的访问模型

| 方案 | 含义 |
|---|---|
| **A. 站点校验 + 保持公开**（推荐） | 在站点解析**之后**再匹配 `/media/`，校验 `object_key` 前缀属于当前站点；仍是公开静态资源 |
| B. 站点校验 + 要求会话 | 未登录不可取图 → **主题与前台文章页的图片会全挂**（前台无会话），不可行 |
| C. 服务端签发短时签名 URL | 最严，但需要主题配合改 URL 形态，改动面远超本批次 |

**推荐 A**：把 `/media/` 分支移到站点解析之后，并加一条
「key 的 `uploads/{siteId}/` 段必须等于解析出的站点」的校验。
这同时修掉"跨站拼 key"和"未发布站点资源被任意人读取"的一半（另一半需要签名，登记为后续）。

### 2.3 自定义字段（`post_meta`）的语言归属

现状是**语言中立**（`contract/schema.ts` 明确写了）。规则 41 要求"每个承载数据的字段都有语言维度"，
但 `post_meta` 走的是"由 post 派生租户"的路线，语言维度为空。

两条路：① 保持中立，**在编辑器 UI 上明确标注**"这些字段在所有语言间共享"（低成本、诚实）；
② 给 `post_meta` 加 `locale` 列并按语言存取（贵，且会让 `post_meta` 与
`post_translations` 的关系变复杂）。**推荐 ①**，本批次只做标注与文案。

---

## 3. 交付顺序（四条轨道，可独立验证）

```
Track 0  隔离地基（迁移 + 读取路径）        ← 必须最先，其余轨道都依赖它
Track A  媒体子系统（API → 控件 → 屏幕）
Track B  编辑器（attrs 契约 → 控件 → 翻译 → 多语言体验）
Track C  守卫与反向验证（每步配套）
Track D  文档（AGENTS 规则 / ARCHITECTURE / HANDOVER）
```

Track C 与 D 不是"最后做"，而是**每一步做完就补**——本仓库的纪律是
"新增具名断言必须在某个注入工具里补一个场景"，跳过的代价见 `AGENTS.md` 第 8 条。

---

## 4. 步骤明细

### Track 0 —— 隔离地基 ✅ 已完成

三步全部落地，并且**每一步都带一条会红的守卫**（见 §4 与 `AGENTS.md` 规则 60）。
下面保留原始设计意图，便于核对实现是否走样。

**0.1 `/media/` 移到站点解析之后 + key 归属校验** ✅
- `src/index.ts`：删除当前 `if(u.pathname.startsWith("/media/"))` 的早匹配分支，
  在站点解析完成后（与 sitemap/robots 同层）加 `/media/` 处理，传入 `siteId`。
- `media(env,u,siteId)`：取 key → 断言 `key.startsWith('uploads/' + siteId + '/')`，
  否则 **404**（不是 403——不泄露"这个 key 存在但属于别人"）。
- 保留 `ETag` / `httpMetadata` / 长缓存头。
- ⚠️ 这是一条**行为变更**：任何硬编码了别站 key 的旧内容会开始 404。发布前需在线上
  抽查一遍 `post_translations.content` 里的 `/media/` 引用是否都指向本站。

**0.2 迁移 0018 + schema 同步**
- `content/migrations/0018_media_ownership.sql`：`ALTER TABLE media_files ADD COLUMN uploaded_by TEXT`
  （`ALTER TABLE ADD COLUMN` 是 SQLite 允许的形式；不要加 UNIQUE / 复合主键）。
  按 2.1 若选"开关式隔离"，**不需要**新列以外的结构变更（策略放 `settings`）。
- `src/extensions/contract/schema.ts`：`media_files` 那行的 note 更新（当前 note 写着
  "site_id added in migration 0009"，要补 uploaded_by 与语言中立的说明）。
- 本地迁移应用用现成的迁移应用器；`tests/tools/_schema-scope.mjs` 必须仍绿。
- ⚠️ 跑 `tests/tools/_tenant-query-audit.mjs`：它的裁决表**键是 `file:line`**，
  `index.ts` / `api.ts` 一改行号就会把已裁决语句挤成 `NEW` → **重新键位**（这是已知坑位 29）。

**0.3 读取路径的站点维度收口**
- `mediaList` 已是 `WHERE site_id=?`，保留。
- 新增：`GET /api/v1/media` 支持 `q`（文件名）、`type`（mime 前缀）、`uploaded_by`（按 2.1）、
  `page`/`limit`（与 `listPosts` 同形，`limit` 上限 100）。

### Track A —— 媒体子系统

**A1 媒体 API 补全**（`src/api.ts`）—— 部分已完成
- `POST /api/v1/media`：写入 `uploaded_by = user.id` ✅；**仍未做**：用 `image/*` 时**探测宽高**
  并写进已有的 `width`/`height` 列（这两列至今是死的——注意 Workers 里没有 `Image` 解码器，
  需要走纯字节解析 PNG/JPEG/GIF/WebP 头，**不要**引入 `sharp` 类依赖）
- `PATCH /api/v1/media/:id`：更新 `alt_text` / `title`（按站点归属校验，先查行再写）✅
- `DELETE /api/v1/media/:id`：**先查行验归属 → 删 R2 对象 → 删行**（顺序重要：
  先删行会让对象成为孤儿且再也找不到 key）。删除失败要如实报错，不能只删行 ✅
- 全部按 `requirePermission(env,user,"media.write")` 闸门；读走 `media.read`。

**A2 用户隔离策略落地**（按 2.1 的拍板）
- 若选 A：`GET /api/v1/media?mine=1` 过滤；后台屏加"只看我的"开关。
- 若选 B/C：在 `mediaList` / `PATCH` / `DELETE` 上加 `uploaded_by` 过滤，
  并且**必须**用"非管理员用户"写测试（坑位 32：匿名被拒对任何路由都成立，测不出这条路由自己的闸门）。

**A3 `public/admin/js/media-picker.js` —— 全平台统一控件**（本批次的核心交付物）
- 形态：**无状态叶子模块**（第三个"谁都能 import"的模块，与 `i18n.js` / `plugin-page.js` 同模式）。
- 导出 `openMediaPicker({ multiple, accept, onPick })`：一个对话框，内含
  ① 已有文件网格（本站、可分页/搜索）② 上传区（拖拽 + 点击，多文件，逐个进度）
  ③ 选中后编辑 alt ④ 确认回调返回 `[{id,url,alt,width,height}]`。
- **不改 `state`**，只吃参数、只回调——这样它可以在任何屏幕里用。
- 消费点（同一控件，三处复用，这正是"全平台统一"的意思）：
  1. 编辑器的 `core/image` / `core/gallery` 块；
  2. 编辑器自定义字段里类型为 image/url 的字段；
  3. 主题/插件设置表单（`screens/theme-menu.js` 的字段渲染分支）里的 image 字段。
- ⚠️ 新增模块要过 `tests/suites/admin-spa.test.mjs` 的模块图检查（无环、无孤儿、相对 import 层级正确）。
- ⚠️ 不要新增 `window.*` 处理器：全部走 `data-*` 委托 + 回调，避免踩坑位 9。

**A4 媒体屏升级**（`screens/media.js`）
- 网格/列表切换、拖拽上传、多文件、alt 内联编辑、删除（带确认）、搜索、类型过滤、分页。
- 文案全部接 `t()`（新增 `core.media.*` key，en + zh-CN **同步扩**——语言包必须两语言同时加）。
- 保留"复制 URL"与"打开"。

### Track B —— 编辑器

**B1 块的 attrs 契约提成唯一定义** ✅ **已完成**（见 `AGENTS.md` 规则 61）
**B2 编辑器按类型渲染控件** ✅ **已完成**
**B5 块往返的行为断言** ✅ **已完成**（`tests/suites/editor-blocks.test.mjs`，40 条）

落地形态与原计划的两处差异，都是有意的：

1. **契约里多了 `itemKeys`**。原计划只声明属性的 key 与类型，条目形状留在渲染器里；
   实测发现控件因此**渲染成一个没有任何输入框的空字段**（`media-list` 的条目键若由 API
   在出口附加，只用契约时就没有）。所以条目键成为属性声明的一部分（规则 61c）。
2. **编辑器的块树寻址放进了 `block-fields.js` 的纯函数**（`locateBlock`/`insertBlock`/
   `setAttrAt`/…），而不是留在屏幕模块里。理由：写入"哪个块的哪个属性"正是原缺陷的所在，
   留在 DOM 里就没法被测试驱动；放进纯函数后 `editor-blocks.test.mjs` 可以整条链跑一遍。

下面保留原始设计意图，便于核对实现是否走样。

**B1 块的 attrs 契约提成唯一定义**（本批次的地基，先做）
- 现在 attr 名隐式写在 `renderBlocks` 的 switch 里。提出一份声明，形如
  每种块 `{ name, title, category, attrs: [{key, type, label}] }`，
  放在 `src/rendering/blocks.ts`（`CORE_BLOCKS` 扩展）或新建 `contract/blocks.ts`。
- **渲染器从它派生**（至少派生"读哪个 attr"），**编辑器从它派生**（画什么控件），
  `GET /api/v1/blocks` 把它下发（现在是 `{type,label,category}`，扩展为带 `attrs`）。
- 新增架构守卫：**闭集合双表对比**——渲染器消费的 attr 集合 == 契约声明的 attr 集合，
  且编辑器的控件表对每种 `type` 都有分支（照抄 §5 的"13 类型逐个有 case"手法）。
- 这一步做完，`core/separator` 的假 `attrs.text` 之类也会被守卫抓出来。

**B2 编辑器按类型渲染控件** ✅（已实现；见上文差异说明）
- text 家族 → `<textarea>`；`core/image` → 媒体选择器 + alt 输入；`core/gallery` → 多选网格；
  `core/button` → text + url 两个输入；`core/html` → `<textarea>`（并明确"原样输出"）；
  `core/separator` → 无输入；`core/group`/`core/columns` → 嵌套容器（可先只支持一层，但
  **必须显式支持或显式拒绝**，不能像现在这样画一个 textarea 却写进没人读的字段）。
- `updateBlock` 改成 `setBlockAttr(i, key, value)`，不再只写 `text`。

**B3 编辑器界面全量接 `t()`**
- 新增 `core.editor.*`（Title / Content / Excerpt / Slug / Status / Publish at / Save /
  Revisions / Delete / Custom fields / Locale / Back / 状态名 draft|published|private|scheduled /
  语言版本条文案 / 各对话框标题与按钮 / toast 文案）。
- 状态值（`draft` 等）**落库仍是英文小写**，只在显示层翻译——不要改数据。
- 语言版本条与自定义字段一并翻译。

**B4 多语言编辑体验**
- `#locale` 下拉改为**只读显示当前语言** + 一个"切换/新建语言版本"按钮（即版本条的入口），
  彻底消除"改这一行 locale"的路径。服务端 `savePost` 的 locale 分支**保留**（API 兼容），
  但后台不再产生这种调用。
- 版本条加"当前"强指示 + "缺失 N 种语言"的翻译文案。
- `editContent` 回填 `publish_at` 到 `#publishAt`（修静默取消排期的缺陷）。
- 自动保存生命周期：`go()` / 离开编辑器时统一 `clearInterval`；加"有未保存修改时离开要确认"。
- 自定义字段按 2.3 的拍板加"所有语言共享"标注。

**B5 块往返的行为断言** ✅（已实现；见上文差异说明）
- 新增（或并入 `admin-contract`）一条**往返断言**：对 12 种块逐个
  "编辑器写出的 attrs → `renderBlocks` 产出非空 HTML"。这是唯一能抓住 §1.1 那类缺陷的观测面
  ——服务端断言与静态检查都看不见它（坑位 27：守卫只能证它观测的那一层）。

### Track C —— 守卫与反向验证

| 编号 | 内容 |
|---|---|
| C1 | 新套件 `tests/suites/media.test.mjs`：站点隔离（A 站列表不含 B 站）/ key 归属（跨站 key → 404）/ 用户隔离（按 2.1）/ 删除真删 R2 对象 / alt 往返 / 分页与搜索 / **非管理员用户的 `media.write` 闸门** |
| C2 | 块往返断言（B5）+ 新套件 `tests/suites/editor-blocks.test.mjs`：契约 → 渲染器 → 编辑器三方一致 |
| C3 | 注入工具 `tests/tools/_media-inject.mjs`：① 去掉 key 站点校验 ② 去掉 `uploaded_by` 过滤 ③ 把某个块的 attr 名改错 ④ 删除只删行不删对象 ⑤ `/media/` 挪回站点解析之前。每个场景断言**具名断言**变红、还原、哈希一致（Worker 线程、`assertPristine` 双向） |
| C4 | `architecture.test.mjs` 新守卫：块 attrs 闭集合双表对比；后台屏无硬编码文案（若决定纳入）；若新增屏幕名，**同时**改 `contract/manifest.ts` 的 `ALLOWED_ADMIN_SCREENS` 与测试里的 `EXPECTED_SCREENS`（双向钉住） |
| C5 | 真浏览器验收 `tests/tools/_media-browser.cjs`：上传 → 编辑器插图 → 保存 → **前台 HTML 里真的有 `<img src>`** → 改 alt → 删 → 前台 404。**必须放在全部套件之后跑**（坑位 21） |
| C6 | `tests/suites/admin-spa.test.mjs`：新模块（`media-picker.js`）进模块图；若媒体屏文案接了 `t()`，逐屏渲染仍须非空且不含错误面板 |

### Track D —— 文档

- `AGENTS.md` 新规则：**媒体隔离**（读取路径必须校验 key 归属站点；`uploaded_by` 语义）、
  **块 attrs 唯一定义**（渲染器与编辑器同源，禁在任一侧硬编码 attr 名）、
  以及"新增媒体消费点必须走统一控件"。
- `ARCHITECTURE.md`：§2（多语言，媒体 alt 语言中立）、§3（主题/渲染，块 attrs 契约）、
  §5（防错，新守卫）、§12（假绿：本次新增的观测面教训）。
- `docs/guides/THEME-DEV.md`：块 attrs 的权威列表（主题作者要照着写模板/样式）。
- `HANDOVER.md`：批次 16 叙述 + 新坑位。
- `docs/README.md`：本文件进 `docs/design/` 索引。

---

## 5. 每步的完成判据（不许自证）

沿用本仓库的既有纪律，逐条都是"能红才算有"：

1. 逐个跑相关套件，**判据 0 failures**（不写死断言数）。
2. 本机 `run-all.mjs` 与任何 `spawnSync` 一律 `EBUSY` → **逐个跑**；
   套件**不并行**（共享同一本地 D1，并行会让套件没有摘要行）。
3. 新增具名断言 → 在某个注入工具里补一个场景，注入后**必须变红**，还原后**必须变绿**。
4. 每次跑完架构套件确认**摘要行存在**（没有摘要 = 失败）。
5. 改 `src/api.ts` / `src/index.ts` 后跑一次租户查询审计，`NEW` 逐条书面裁决 + 重新键位。
6. `npx tsc --noEmit` 对 `src/` 0 错误。
7. 浏览器验收**最后**跑，且脚本对语言状态自愈（`ui_lang` 按用户持久化）。

## 6. 已知风险

| 风险 | 说明 |
|---|---|
| `/media/` 移位的兼容性 | 见 0.1：线上旧内容若引用了别站 key 会开始 404。发布前抽查线上 `content` 里的 `/media/` 引用 |
| 块 attrs 契约会**同时**改渲染器与编辑器 | 主题的 CSS 选择器（`.gallery` / `.wp-button` / `.wp-columns`）不能变，否则已发布主题样式失效。**只改数据形状，不改产出 HTML 的类名与结构** |
| `width`/`height` 需要纯字节解析 | Workers 无图像解码器；PNG/JPEG/GIF/WebP 头解析要自己写（约 60 行），**不许引依赖**。若成本超预算，允许先只对 PNG/JPEG 做，其余留 NULL（诚实留空好过猜） |
| 翻译工作量 | `core.editor.*` + `core.media.*` 约 80–100 个 key × 2 语言。语言包必须**两语言同步扩**，只加 en 会让 zh-CN 回退英文 |
| 用户隔离语义 | 见 §2.1，**未拍板前不要动 Track A2** |
| 迁移与守卫的联动 | 新列会动 `_schema-scope` 的期望与 `_tenant-query-audit` 的键位，两处都要同步 |
