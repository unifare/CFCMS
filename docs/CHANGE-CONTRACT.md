# 改动面契约（Definition of Done）

> 这份文档回答一个问题：**「这个改动做完了吗？」**
>
> 三份文档分工，别搞混：
>
> | 文档 | 回答 | 组织方式 |
> |---|---|---|
> | `AGENTS.md` | **不做会怎样变红** | 硬规则 + 跑什么命令 |
> | `docs/ARCHITECTURE.md` §10 | **每个面为什么存在** | 历史教训目录（规则 1–74） |
> | **本文** | **你正在做的事要覆盖哪些面** | 按「改动类型」组织 |
>
> §10 是**踩过的坑**，本文是**要做的清单**。坑会继续增加；清单不会——清单的条目数
> 等于这个系统的维度数（17 个），维度不会因为你多学一个教训而变多。

---

## 0. 三条铁律（先读这个）

**铁律 1 —— 任一**适用**维度未覆盖 = 没做完。**
不适用的维度要**写明为什么不适用**，不能默认跳过。一份改动说明里没有出现的维度，
默认等于「没想过」，而不是「不需要」。
> 本仓库历史上所有「丢三拉四」都是这一条的反面：改动者心里只有 1–2 个维度
> （"我加了个表" / "我加了个屏"），而系统有 17 个。

**铁律 2 —— 凡是「能存东西」的新东西，必须回答两个轴。**
租户（哪個站点：`site_id` / 派生 / 平台全局）与语言（逐语言 / 语言中立）。
`contract/schema.ts` 是唯一权威，**没分类 = `_schema-scope.mjs` 当场红**。
> 两个轴都不是从表名能猜出来的：`media_files` 看着全局其实是按站点；
> `locales` 看着按站点其实是平台全局（规则 43）。

**铁律 3 —— 每个新守卫必须反向验证。**
注入一次违规，确认它真的变红，再撤回。**测不出失败的检查等于没有检查**
（§12 记录了十五种假绿，每一种都是"检查存在但从没红过"）。

---

## 1. 十七个维度

「怎么验」一列写的是**命令**，不是建议。改动涉及的维度必须跑过；不涉及的要说明。

| # | 维度 | 判据（做对了长什么样） | 怎么验 | 规则 |
|---|---|---|---|---|
| 1 | **分层** | `shared ← platform ← rendering ← extensions ← index.ts`，只允许向右依赖；`shared/` 不 import 业务层；`platform`/`rendering` 不 import `extensions/`（要扩展就反转依赖、注入接口） | `architecture.test.mjs`（分层段） | 1–4 |
| 2 | **租户（站点隔离）** | 每张表在 `PLATFORM_SCHEMA` 有租户归属；每条触碰租户表的语句带 `site_id`（或已在 `REVIEWED` 里有书面裁决）；**站点删除后不留注册表残留** | `_schema-scope.mjs`、`_tenant-query-audit.mjs`、`multisite.test.mjs` | 43、44、46、47 |
| 3 | **语言：内容（L1）** | 每条内容行有 `lang_group`；每语言一行 `post_translations`；**每语言自己的 slug**；回退阶梯只有一份定义（`resolveContentLocale()`），调用点不写 `\|\| "en"` | `i18n.test.mjs`、`locale-url.test.mjs` | 5–7、10、71 |
| 4 | **语言：界面（L2）** | 每个用户可见串走 `t(key, fallback)`，key 带前缀（`core.` / `theme.{slug}.` / `plugin.{slug}.`）；**中英两套都在**；界面语言与内容语言不混用 | `i18n.test.mjs`、`admin-spa.test.mjs`、`_i18n-browser.cjs` | 8、9、63、67 |
| 5 | **语言：主题业务数据（L3）** | `tables[].language{strategy,translatable[]}` 显式声明；散文字段进 `translatable`、语言中立不进（`isProseFieldType()` 是唯一谓词）；`{table}_i18n` 只在站点服务 ≥2 语言时建、**永不 drop**；`theme_table_defs.i18n_table` 是门面唯一信任的字段 | `_schema-scope.mjs`、`theme-integration.test.mjs`、`_i18n-field-inject.mjs` | 12、12b、41、42、65 |
| 6 | **语言：菜单** | `menu_items.locale`：`''` = 全语言，指定语言只在该语言渲染（**故意不跨语言回退**）；菜单容器本身语言中立 | `menu-custom.test.mjs`、`theme-integration.test.mjs` | 73 |
| 7 | **语言：小工具** | `widget_instances.locale` 同上语义；每次读取带 `site_id` | `theme-integration.test.mjs`（§12 侧栏段） | 74 |
| 8 | **语言：URL / SEO** | 显式语言 URL 找不到返回 **404 不回退**；`alternates`/`hreflang` 指向各语言**自己的 slug**；per-locale feed 与 sitemap | `locale-url.test.mjs`、`theme-default.test.mjs` | 7、71 |
| 9 | **用户与权限** | 每个管理端点先过 `requireAdmin` + 能力检查；越权是 **403 不是 404**；每用户偏好（`ui_lang`/`menu_prefs`/autosave）带 `user_id`；**能力白名单** `CAPABILITIES` 是唯一权威 | `admin-contract.test.mjs`、`account.test.mjs` | 16、60 |
| 10 | **扩展契约（主题/插件）** | 清单每个声明**都被消费**（`routes[]`/`menuLocations[]`/`sidebars[]`/`tables[]`/`fields[]`/`blocks[]`/`adminMenus[]`/`adminPages[]`/`channels[]`/`settings[]`）；安装边界 `validateManifest` 拒绝非法（**失败必须抛**）；注册行 ≠ 安装（规则 69） | `manifest-validation.test.mjs`、`scaffold.test.mjs`、`theme-integration.test.mjs` | 13–17、42、66、69 |
| 11 | **hook 与事件** | `DECLARABLE_HOOKS` 是插件能声明的**全部**；`DOMAIN_EVENTS` 是**事实**（过去式）不是通道；事件名不得混进 hook 列表；payload 带版本兜底 | `architecture.test.mjs`（事件段）、`manifest-validation.test.mjs`、`plugin-hooks.test.mjs` | 45 |
| 12 | **渲染** | 模板引擎只解释不执行（禁 eval/动态 import 用户代码）；helper 调用形式固定；块属性集合只在 `rendering/blocks.ts` 的 `CORE_BLOCKS` 声明一次；`@include`/`@extends`/section 开闭配得上 | `template-engine.test.mjs`、`editor-blocks.test.mjs`、`theme-fixture.test.mjs`、`_skeleton-inject.mjs` | 61 |
| 13 | **缓存** | 改了内容/主题/设置必须 `bumpContentCache(env, siteId)`，否则前台继续吐旧 HTML（"改了没反应"的头号原因） | `theme-integration.test.mjs`、`multisite.test.mjs` | — |
| 14 | **后台 SPA** | 新屏在 `screens/index.js` 注册；markup 里调用的 handler 都登记进 `WINDOW_HANDLERS`（`window.*` 是外部契约）；从**服务端实际放置的层级**读字段；URL = 页面；**桩载荷必须非空** | `admin-spa.test.mjs`、`_admin-menus-browser.cjs` | 67、68 |
| 15 | **数据迁移** | 迁移**有序、只增不改**；SQLite 改不了 PK → 重建表（抄 0019/0020 套路）；遗留行**故意不回填**且读阶梯有唯一定义；新表同步进 `contract/schema.ts` | `_schema-scope.mjs`、`_apply-migrations.mjs` | 44、70 |
| 16 | **测试与文档** | 规则**三处同步**（`AGENTS.md` + `ARCHITECTURE.md` §10 + `architecture.test.mjs`）；新套件要进**四个注册表**（`package.json` test 链、`run-all.mjs`、`cfpress.sh`、`cfpress.ps1`）；文档里写的测试路径必须存在 | `architecture.test.mjs`（末节）、`launcher-parity.test.mjs` | 18–23 |
| 17 | **部署与启动器** | 配置**一份手写 + 一份生成**（真 id 绝不进 `wrangler.jsonc`）；主题随 assets 分发；**新增 manifest 声明后必须重新激活主题**（`ensureThemeCapabilities` 是"从零修复"不是"增量同步"）；改 `cfpress.ps1` 后 BOM 还在 | `launcher-parity.test.mjs`、`cfpress.sh doctor` | 52–55、66、69 |

---

## 2. 交织矩阵：碰了 X，就必须同时处理 Y

**这一节是本文最重要的部分。** 维度不是并列的格子，是**互相咬合**的：改一个东西
几乎总会牵动另外两三个，而牵动的那几个恰恰是「看不到、但线上会坏」的地方。

| 你改了… | 必须同时检查 | 为什么（不检查会怎样） |
|---|---|---|
| **加一张表 / 一个字段** | ① `contract/schema.ts` 分类（租户+语言）② 若是扩展表：`tables[].language{}` ③ 读它的每个查询带 `site_id` ④ 站点删除时清不清 ⑤ `_tenant-query-audit` 的裁决 | 不分类 → `_schema-scope` 红；不带 `site_id` → **多站点串台**（单站测不出来）；散文字段不标 `translatable` → 中文页显示英文分类名 |
| **加一条管理 API** | ① 权限（`requireAdmin` + capability）② `siteId` 从 `requestSiteId` 取而不是参数默认值 ③ 变更后 `bumpContentCache` ④ 返回的 payload 层级 = 屏幕读取的层级 ⑤ `admin-contract` 一条断言 | 少 ③ → "保存了但页面没变"；少 ④ → 屏幕读 `undefined` 静默空白 |
| **加一个后台屏 / 改屏** | ① 注册进 `SCREENS` ② 用到的 handler 登记 `WINDOW_HANDLERS` ③ 每个串走 `t()` 且中英齐 ④ URL 能表达（`pageToHash` 通用，无需特例）⑤ 桩载荷非空才能跑到行渲染 | 少 ② → 按钮点了没反应（无报错）；少 ③ → 半截英文界面；少 ⑤ → **少 import 一个标识符也能全绿到浏览器**（§12 #15） |
| **加一种语言** | ① `locales`（平台注册表）+ `site_locales`（本站点启用）② 界面词典两套 ③ 内容：每语言一行 + 自己的 slug ④ 菜单/小工具的 `locale` 语义 ⑤ feed/sitemap/hreflang ⑥ **不得在任何地方写 `if (locale === "en")` 或硬编码语言清单** | 少 ⑥ → 从 2 种语言扩到几十种时会静默坏（见 §3.5） |
| **改主题声明（`theme.json`）** | ① `validateManifest` 过 ② 声明**被消费**（不消费 = 声明面为空，规则 69）③ 已安装的站点**重新激活**才注册 ④ `theme-fixture`/`theme-default` 过 ⑤ 生成物 `public/themes/**` 同步（`sync-bundled-themes.mjs`） | 少 ③ → 线上 `/blog` 404（批次 23 真实事故）；少 ⑤ → 部署后主题文件不存在 |
| **改主题模板 / 部件（parts）** | ① 每个模板过**真实模板引擎**（有数据/无数据各一次）② `@include`/`@extends` 目标存在 ③ section 开闭配得上 ④ 模板里用到的 helper 在十个小写 helper 里 ⑤ 部件改动要检查**所有**引用它的模板 | 少 ① → 生成器/模板缺陷只有渲染一遍才现形（规则 4） |
| **加一个插件能力 / hook** | ① `CAPABILITIES` 白名单 ② `DECLARABLE_HOOKS` ③ 宿主**真的实现**了它（声明 ≠ 实现）④ `subscribes[]` 的事件名在 `DOMAIN_EVENTS` 里 ⑤ `manifest-validation` + `plugin-hooks` 各一条 | 少 ③ → 插件声明了能力但调不动；少 ④ → 事件名混进 hook 列表 |
| **加一个块类型 / 改块属性** | ① `CORE_BLOCKS` 是唯一声明 ② 三个消费点（块属性 / 自定义字段 / 扩展设置）共用媒体控件 ③ 渲染器与契约的集合**相等** ④ 编辑器与渲染器读**同一个**属性名 | 历史上六种块渲染成空（编辑器写 `attrs.text`、渲染器读别的） |
| **加迁移** | ① 迁移流有序、只增 ② 改 PK → 重建表（SQLite 限制）③ 新表进 `PLATFORM_SCHEMA` ④ 遗留行**不回填**、读阶梯有唯一定义 ⑤ 本地 + 线上都要 `migrations apply` | 少 ③ → `_schema-scope` 红；少 ④ → 老数据在新语言下消失 |
| **改启动器（`cfpress.sh`/`.ps1`）** | ① 两侧动作名/菜单号/套件表/退出码**完全对齐** ② `.ps1` 的 **UTF-8 BOM 还在** ③ 菜单提示走 stderr ④ 输入耗尽要退出 ⑤ 新套件进四张表 | `launcher-parity` 会红；BOM 掉了只有 PS 5.1 才看得出来（中文乱码） |
| **改 schema / 新增站点级表** | ① `PLATFORM_SCHEMA` ② `deleteSite` 是否该清它 ③ 若不该清，**写明理由**（内容按策略保留） | 不清 → 删除站点后 `GET admin-menus` 仍返回它的菜单（已知债） |
| **改内容保存路径** | ① `bumpContentCache` ② 每语言 slug ③ `meta` 按语言写（`resolveMetaByPost` 是唯一读阶梯）④ 修订/自动保存也带 locale | 少 ③ → 分类名不翻译；少 ② → 永久链接静默变成 post id |
| **改任何面向用户的东西** | ① 中英词典都补 ② 用 `t()` 不写字面量 ③ 跑 `_i18n-browser.cjs` | 缺键**是静默的**（`t()` 有英文兜底，界面其余部分已本地化） |

---

## 3. 按「改动类型」的清单

### 3.1 新增一个内容类型（CPT，主题声明）

1. `theme.json` 加 `postTypes[]`，`fields[]` 里**散文字段标 `translatable`**、语言中立不标。
2. 若该类型有自有数据表 → 走 §3.2。
3. 前台：`templates/` 里给 `single-<cpt>.html` / `archive-<cpt>.html`（或声明 `routes[]`）。
4. 后台：类型自动出现在内容菜单；列表/表单由声明生成，**不得手写**。
5. 语言：每语言自己的 slug；`post_meta` 按语言写。
6. 站点：类型注册在 `post_types`（**按站点**）——A 站激活的主题不该给 B 站加类型。
7. 验：`manifest-validation` + `theme-integration` + `i18n` + `_schema-scope`；改了声明要**重新激活**。

### 3.2 新增一张主题/插件表

1. `tables[]` 声明 `name/label/fields[]` + **`language{strategy,translatable}`**。
2. `contract/schema.ts`：表是**生成表**（`theme_{owner}_{table}`），不需要登记；但**若你的迁移手写了平台表**，必须登记租户+语言归属。
3. 主表必有 `site_id`；`{table}_i18n` **没有** `site_id`（键是 `row_id`+`locale`）——对它的任何删除必须**先在主表验站点归属**（规则 12b，用 `tableDelete` / `tableDeleteTranslation` 两个函数表达两件事）。
4. 站点删除：生成表**不 drop**（它属于平台、装着所有站点的行）；行按站点不可达即可。
5. 验：`_schema-scope`（声明 vs 真实列）、`theme-integration`（CRUD + 语言）、`_i18n-field-inject`。

### 3.3 新增一个后台屏

1. `public/admin/js/screens/<name>.js`，在 `screens/index.js` 注册。
2. 每个串 `t("core.<area>.<key>", "English fallback")`，**中英词典都补**（`core-pack.ts` 两处）。
3. handler 若被内联 `onclick` 调用 → 登记 `WINDOW_HANDLERS`（`admin.js`）。
4. 数据从服务端**实际层级**读（`d.items` 还是 `d.active_by_site` —— 读错永远是 `undefined`，且静默）。
5. 分页/过滤走 `scoped(...)`（带 `?site=`）。
6. URL：`pageToHash` 是通用映射，新屏名自动可用，**不要**写特例。
7. 验：`admin-spa.test.mjs`（会真渲染你的屏，桩载荷是**一行真记录**）+ 真实浏览器 `_i18n-browser.cjs` / `_admin-menus-browser.cjs`。

### 3.4 新增一条管理 API

1. `requireAdmin` + **能力检查**（`CAPABILITIES` 里的名字），越权 403。
2. `siteId` 从 `requestSiteId(url)` 取；**不得**给参数默认值、不得 `?? "default"`。
3. 任何写操作之后 `bumpContentCache(env, siteId)`。
4. 返回 `{items:[...]}` 或 `{ok:true}`，字段名与屏幕读取处一致。
5. 验：`admin-contract.test.mjs` 一条具名断言（含跨站点隔离）；新语句看 `_tenant-query-audit.mjs` 是否报 `NEW`，报了要**写一条书面裁决**。

### 3.5 新增一种语言（或为「几十种语言」做准备）

1. **平台注册表** `locales`（全局）+ **站点启用** `site_locales`（本站点）——两者不是一回事。
2. 界面词典：`core-pack.ts` 加一套；`i18n.test.mjs` 会检查 key 前缀与两套齐全。
3. 内容：每语言一行 `post_translations` + **各自的 slug**（共享同一个 `lang_group`）。
4. 菜单：`menu_items.locale`（`''` = 全语言）；小工具同理。
5. **不得引入任何"语言数量 = 2"的假设**：
   - ❌ `if (locale === "en")` / `locale === "zh-CN"` 这类分支
   - ❌ 把语言清单写死在数组里（唯一权威是 `locale-registry.ts`）
   - ❌ 用 `ORDER BY` 的第一个语言当默认（字典序巧合，规则 73 的同款陷阱）
   - ❌ 用 `MIN(locale)` / `items[0]` 代表"站点默认语言"——**站点默认语言只从 `site_locales.is_default` 读**
   - ✅ 语言字面量只允许出现在 i18n 层，且要有理由（`_locale-literal` 守卫会拦）
6. 验：`i18n.test.mjs`、`locale-url.test.mjs`、`node tests/tools/_locale-literal.mjs`。

### 3.6 新增一个插件能力 / hook

1. `CAPABILITIES` 加名字（白名单是唯一权威，不得在插件里自定义字符串）。
2. `DECLARABLE_HOOKS` 加 hook（若确实是"宿主提供实现"的那种）。
3. **宿主真的实现它**——声明 ≠ 实现（规则 69 的同款病：注册行不等于安装）。
4. 事件（"已经发生的事实"）放 `DOMAIN_EVENTS`，**不得**混进 hook 列表。
5. 验：`manifest-validation`、`plugin-hooks`、`architecture.test.mjs`（事件完整性/唯一性/payload 版本）。

### 3.7 改主题模板 / 部件

1. 模板只解释不执行：不用 eval、不动态 import 用户代码、不网络请求。
2. 每个 `@include`/`@extends` 目标存在；section 开闭配得上。
3. 用到的 helper 必须在十个之内（`len default lower upper truncate join number date contains`）。
4. 部件（`parts/`）改动要检查**所有**引用它的模板。
5. 改了 `content/themes/**` 要跑 `sync-bundled-themes.mjs`（`predeploy` 已挂），否则部署的是旧文件。
6. 验：`template-engine.test.mjs`、`theme-fixture.test.mjs`、`theme-default.test.mjs`、`_skeleton-inject.mjs`。

### 3.8 改 schema / 加迁移

1. 迁移**只增**、有序；改 PK 只能重建表（SQLite 限制）——抄 `0019_post_meta_locale.sql` / `0020_widget_site.sql`。
2. 新表进 `PLATFORM_SCHEMA`（租户 + 语言 + **理由**）。
3. 遗留行**故意不回填**，读阶梯只许一处定义（`resolveMetaByPost` 是范式）。
4. 本地 + 线上都要 `migrations apply`；`DROP` 时 **`_cf_KV` 内部表绝不能动**。
5. 验：`_schema-scope.mjs`（跑真实迁移流 + 真实 `syncThemeTables()`）、`_tenant-query-audit.mjs`。

### 3.9 改启动器 / 部署

1. `cfpress.sh` 与 `cfpress.ps1` 是**一个契约**：动作名、菜单号、套件表、退出码完全对齐。
2. 新套件进**四张表**：`package.json` test 链、`tests/run-all.mjs`、`cfpress.sh`、`cfpress.ps1`。
3. `.ps1` 的 BOM 必须还在（`head -c 3 scripts/cfpress.ps1 | xxd` → `efbbbf`）。
4. 真 id 只进 `wrangler.ids.json`（gitignore），`wrangler.jsonc` 只放占位符。
5. 验：`launcher-parity.test.mjs`、`node tests/tools/_launcher-inject.mjs`、`./scripts/cfpress.sh doctor`。

---

## 4. 端到端走查示例：新增「活动报名」

假设要给主题加一个内容类型 `event`（活动），带自有表 `registration`（报名）。

| 步骤 | 动作 | 维度 | 不做的后果 |
|---|---|---|---|
| 1 | `theme.json` 加 `postTypes[{name:"event"}]`、`fields[{key:"place",type:"text"}]`、`tables[{name:"registration",language:{strategy:"sidecar",translatable:["note"]}}]` | 10、5 | 声明面为空：类型建不出来，或表建出来但没有语言能力 |
| 2 | `place` 是散文 → 自动进 `translatable`；`seats` 是 `number` → 不进 | 5、41 | 中文活动页显示英文地点；或数字被翻译成字符串 |
| 3 | 迁移里若手写平台表 → 进 `PLATFORM_SCHEMA`；否则不用（生成表） | 2、15 | `_schema-scope` 红 |
| 4 | 前台：`templates/single-event.html` + `routes[]` 声明 `/events` 归档 | 12、8 | 活动没有可达 URL |
| 5 | 后台：类型自动出现在内容菜单；报名列表由声明生成 | 10、14 | 手写表单 → 违反规则 15 |
| 6 | 报名 CRUD API：`requireAdmin` + capability、`requestSiteId`、写后 `bumpContentCache` | 9、2、13 | 跨站串台 / 保存了页面不变 |
| 7 | 报名数据：主表带 `site_id`；`registration_i18n` 无 `site_id`，删除前先验主表站点 | 2、5、12b | 跨站误删（`WHERE row_id=?` 会删别的站） |
| 8 | 多语言：活动标题每语言一行 + 各自 slug；报名备注走 sidecar | 3、5 | 语言切换器指向错 URL |
| 9 | 站点：A 站激活主题才有 `event` 类型；B 站没有 | 2、10 | 类型泄漏到别的站 |
| 10 | 卸载主题：生成的表**不 drop**（行留着），`theme_table_defs` 清掉 | 10、15 | 重新装回来数据还在（这是设计） |
| 11 | 删除站点：`event` 行不可达即可；**注册表行要清** | 2 | 删除站点后 `admin-menus` 仍返回它的菜单 |
| 12 | 界面串：报名屏每个串 `t()` + 中英 | 4 | 半截英文界面 |
| 13 | 测试：`manifest-validation`（清单过）、`theme-integration`（CRUD+语言+跨站）、`admin-contract`（API+隔离）、`i18n`（若动了字段分类） | 16 | 没断言 = 没做 |
| 14 | 文档：若新增了"以后每次都要做"的东西，写进本文 + `AGENTS.md` + `architecture.test.mjs`（三处同步） | 16 | 下一个人还会漏 |
| 15 | 部署：`migrations apply --remote` → `deploy` → **重新激活主题**（新声明才注册） | 17 | 线上 `/events` 404（批次 23 真实事故） |

---

## 5. 「丢三拉四」长什么样（本仓库真实案例）

| 症状 | 缺的维度 | 真实案例 |
|---|---|---|
| 主题"装好了"、页面全渲染、但**字段一个都没有** | 10（声明被消费） | 规则 66/69：`seedBundledExtensions` 只写注册行、从不 `applyThemeCapabilities`；线上 12 次 200、`post_meta` 零行 |
| 线上 `/blog` 404，本地正常 | 17（重新激活） | 批次 23：`ensureThemeCapabilities` 是"从零修复"不是"增量同步"，新声明要重新激活 |
| 后台主题列表一堆**幽灵主题** | 16（测试卫生） | 套件只在开头清理 → 残留永久化；后来加了 `_residue-guard.mjs` |
| 菜单页 `attr is not defined`，测试全绿 | 14（桩载荷） | §12 #15：空载荷让行渲染代码从不执行 |
| 别的站点的侧栏出现在本站 | 2、7 | `widget_instances` 没有 `site_id`（迁移 0020 修的） |
| 后台菜单串成别的站点的 | 2、12b | `WHERE menu_id=?` 而 `menu_id` 只在本站点唯一（批次 16） |
| 中文站读写到英文行 | 3 | 六处各自写 `\|\| "en"`，同一个问题两种答案（规则 6） |
| 分类名不翻译 | 3、5 | `post_meta` 没有 locale（迁移 0019 修的，规则 70） |
| 保存了但页面没变 | 13 | 少了 `bumpContentCache` |
| 按钮点了没反应，无报错 | 14 | 内联 `onclick` 的 handler 没登记进 `window` |

---

## 6. 现状：哪些是机器强制、哪些还靠人肉

**这份表本身就是要维护的东西。** 一个维度从「人肉」变成「机器」，就是一次真正的加固。

| 维度 | 机器强制？ | 在哪 |
|---|---|---|
| 1 分层 | ✅ | `architecture.test.mjs` |
| 2 租户（声明） | ✅ | `_schema-scope.mjs` |
| 2 租户（查询） | ⚠️ 报告 + 书面裁决 | `_tenant-query-audit.mjs`（`--strict` 可作门，默认报告） |
| 2 租户（站点删除） | ✅ 已修（原为已知债） | 每张站点级表在 `contract/schema.ts` 声明 `onSiteDelete: purge/retain`，`PURGE_ON_SITE_DELETE` 派生、`deleteSite` 走它；`architecture.test.mjs` 强制"每张站点级表都声明策略"+ non-vacuity，`multisite.test.mjs` 断言删站后注册表行真的没了 |
| 3 内容语言 | ✅ | `i18n.test.mjs` |
| 4 界面语言 | ⚠️ 部分（缺键静默） | `i18n.test.mjs` + `admin-spa.test.mjs` |
| 5 主题数据语言 | ✅ | `_schema-scope` + `_i18n-field-inject` |
| 6/7 菜单/小工具语言 | ✅ | `theme-integration.test.mjs` |
| 8 URL/SEO | ✅ | `locale-url.test.mjs` |
| 9 权限 | ⚠️ 部分 | `admin-contract.test.mjs` |
| 10 扩展契约 | ✅ 部分（声明被消费） | `manifest-validation` + `theme-integration` |
| 11 hook/事件 | ✅ | `architecture.test.mjs` |
| 12 渲染 | ✅ | `template-engine` + `editor-blocks` |
| 13 缓存 | ⚠️ 靠断言 | `theme-integration.test.mjs` |
| 14 后台 SPA | ✅ | `admin-spa.test.mjs` |
| 15 迁移 | ✅ | `_schema-scope.mjs` |
| 16 测试与文档 | ✅ | `architecture.test.mjs` 末节 + `launcher-parity` |
| 17 部署 | ⚠️ 靠纪律 | `doctor` + 部署清单 |
| **语言数量无上限** | ✅ | `tests/tools/_locale-literal.mjs`：拦「把行为钉在某个语言上」（`locale === "xx"`、`/^xx/i.test(locale)`、写死的语言清单）与 i18n 层之外的语言字面量；每条白名单都要写理由。已知缺口：`frontend.ts` 的阅读时长标签仍是「zh 或非 zh」二分，待改成走语言包（见白名单里的 ⚠️） |

---

## 7. 当你发现一个"以后每次都要做"的东西

不要只写在这里。按这个顺序做，否则它会在下一次改动里消失：

1. **写进本文**（§1 加维度 / §2 加交织行 / §3 加清单项）——说明**判据**。
2. **写进 `AGENTS.md`** 的「改动面清单」——说明**不做会怎样**。
3. **尽量变成机器判据**：能在测试里断言的，别留在文档里。
4. **反向验证**它（铁律 3）。
5. 若它推翻/细化了某条既有规则，**三处同步**：`AGENTS.md` + `ARCHITECTURE.md` §10 + `architecture.test.mjs`。
