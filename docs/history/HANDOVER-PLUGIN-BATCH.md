# CFPress 批次 10 交接文档 —— 插件系统（步骤 1–6 完成）

> ⚠️ **状态：已归档（ARCHIVED）**。本批次 8 步**全部完成**（步骤 7+8 见下方 §4 的补记）。
> **正式交接请看 `docs/HANDOVER.md`**（已把本批次的提交脉络、进度、套件数、坑位续上）。
> 本文只保留步骤 1–6 的过程细节与用户拍板决策，供追溯，**不要再当成"待办清单"读**。

> 更新时间：2026-09-29 19:40 (GMT+8) ｜ 当前 HEAD：**`9fd19db`**（已推送，三路校验一致）
> 读者：接手本批次的开发者或 AI 会话。**先读本文，再读 `docs/design/PLUGIN-ARCHITECTURE.md`（设计全文）、
> `docs/ARCHITECTURE.md`（分层与红线）、`AGENTS.md`（规则 48–51 全文）。**
> 状态：八步交付顺序完成 **6/8**；17 套件 **848 条 0 失败**；`npx tsc --noEmit` src/ 0 错误。

---

## 0. 一段话现状

批次 10 把插件系统从"菜单 + hooks"扩成完整三支柱：**自有表（owner-agnostic）→
通知渠道（declare → host delivers）→ 声明式后台页面（declare → host renders）**。
设计全文在 `docs/design/PLUGIN-ARCHITECTURE.md`，其 §5 定了八步交付顺序，每步独立可验证、
每条新守卫都要反向验证（注入违规 → 确认红 → 还原 → 哈希一致）。**步骤 1–6 已完成并推送；
剩步骤 7（`plugins/notify` 示例插件）与步骤 8（`tests/suites/plugin-pages.test.mjs` + 反向验证）。**

## 1. 本轮提交脉络（全部已推送，每次三路验证：本地 == `git ls-remote` == `gh api`）

```
576fe6a  删除旧主题/插件 + 第十一种假绿修复（批次 10 步骤 1）
34c0bc9  扩展自有表 owner-agnostic：theme_table_defs 重建出 owner_type（步骤 2）
bcc856c  渠道契约 + 插件页面契约 + 规则 48–51 校验（步骤 3+4）
9487b40  渠道运行时：webhook 实现 + 去重台账 + PluginApi.notify（步骤 5）
9fd19db  后台渲染器：plugin-page 块渲染 + 渠道设置表单（步骤 6）  ← 当前 HEAD
```

## 2. 用户拍板的设计决策（不要再"待确认"）

| 决策 | 内容 |
|---|---|
| 删除范围 | 旧主题 + 旧插件全删；`themes/_fixture` 改名 `themes/fixture` 保留测试能力；被删源码 stash 在 `.wrangler/retired-extensions-reference/`（**不进 git**） |
| 渠道类型 | 只做 notification |
| `mail` 渠道 | **删掉，只留 `webhook`**——宿主 wrangler.jsonc 无邮件绑定，声明了却没人实现正是规则 51 要抓的分歧 |
| 插件页面 | 完整自定义页面，形态 = `adminPages[].blocks[]` 声明式（三种块），不是 SDK 路由 |
| shortcodes 机制 | 保留在宿主（hooks 套件在用），只是没有插件再声明它 |

## 3. 步骤 1–6 各自做了什么（接手前必读的小节）

### 步骤 1 `576fe6a` — 清场
39 个文件删除 + 重接线；`theme-fixture` 套件修复中发现**第十一种假绿**
（守卫数 token 时被注释里的 token 骗过——数出来的数对，但数的对象错了）。
新增 `_fixture-inject.mjs`（10 场景）+ `_fixture-inject-verify.mjs`（进程内驱动，
本沙箱不能 spawn 子进程）。`.gitattributes` 钉死 `*.html` 行尾。

### 步骤 2 `34c0bc9` — 自有表 owner-agnostic
`theme_table_defs` 重建出 `owner_type`（'theme'|'plugin'）；物理表名
`{owner_type}_{owner_name}_{logical}`；`syncThemeTables` → **`syncOwnerTables(env, ownerType, ownerName, manifest, siteId)`**。
**设计文档里的 0014 迁移是错的**：它 drop `id`/`site_id`、唯一键漏 site——
用真实 SQLite 先跑会 `UNIQUE constraint failed`（两站点同主题同表 → 整条 INSERT…SELECT 中断，
多站安装丢注册表）。`id` 是承重列（`refreshThemeTableI18n` 按 `WHERE id=?` 更新）。
修法：保留 `id`+`site_id`，加 `owner_type`，唯一键 `(site_id,owner_type,owner_name,logical_name)`。
反向验证：注入"前缀无视 ownerType"→ 恰好 3 条断言红 → 还原哈希一致。

### 步骤 3+4 `bcc856c` — 契约与校验（规则 48–51）
- `contract/channels.ts`：`NotificationChannel`/`ChannelConfigField`/`ChannelMessage`(含 `dedupKey`)/`ChannelSendResult`；
  **`HOST_CHANNEL_CODES = ["webhook"]`**；`ALLOWED_CHANNEL_FIELD_TYPES = ["text","password","url","number","boolean"]`
- `contract/manifest.ts`：`ALLOWED_PAGE_BLOCKS = ["table","stats","form"]`、`PLUGIN_PAGE_SCREEN_PREFIX`、`pluginPageScreen(id)`、`AdminPageDecl`/`PageBlockDecl`
- `contract/validation.ts`：`validateTables` 抽出共享（主题/插件同一段校验）；`validatePluginManifest` 实现规则 48–51；
  `validateAdminMenus` 加第 5 参 `declaredPages`（`plugin-page:` 必须指向真实声明的页面）
- `tests/suites/manifest-validation.test.mjs` 80 → **104 条**；反向验证两轮（规则 48 键表 → 6 红；规则 51 类型 → 1 红）

### 步骤 5 `9487b40` — 渠道运行时
- `plugin/channels/index.ts`：`CHANNEL_IMPLS` + `sendThroughChannel()`（**永不 throw**——
  调用方是页面渲染路径上的 hook，端点挂了不能变成 500）。webhook：先验 URL 再 fetch（仅 http/https）、5s AbortController
- `plugin/notify.ts`：`readChannelConfig()`（只读 manifest `configSchema` 声明过的 key，
  存量行不能变成配置）+ `deliverNotification()`——**去重是 claim-before-send**：
  先 INSERT 抢占（部分唯一索引裁决），失败即 `{ok:true,deduped:true}`，发送后回写结果。
  SELECT-then-send 是构造性竞态，是这模块存在的理由
- `migrations/0015_notification_log.sql`：发送台账 + 部分唯一索引
  `(site_id,plugin_name,channel,dedup_key) WHERE dedup_key IS NOT NULL`——**site 必须在索引里**，
  否则 A 站的日报吞掉 B 站的同名 key
- `PluginApi.notify()`：声明即授权（manifest 是权威），配置从本插件自己的 settings 读——插件永不经手自己的凭据
- `tests/suites/plugin-channels.test.mjs` **55 条**：计数 fetch stub（"端点被调了几次"是直接事实）。
  反向验证：把 claim-before-send 换回 SELECT-then-send → **7 条红**，其中
  `端点被恰好调用一次` expected 1 / actual 2——守卫证的是发送次数，不是返回值

### 步骤 6 `9fd19db` — 后台渲染器
- `public/admin/js/plugin-page.js`：渲染器模块。**导出 `RENDERED_BLOCK_TYPES` 与
  `RENDERED_CHANNEL_FIELD_TYPES`**——`tests/suites/architecture.test.mjs` 按集合对比契约列表。
  解析 switch 是猜结构，导出列表是被告知结构（"同一意图的两种写法"教训）
- 三种块渲染器：`table`（列来自声明，未知列画解释不画空白）、`stats`（count/sum/latest，
  未知聚合报配置问题而非画 0——0 是值，不该被捏造）、`form`（POST 到与内置表格屏同一条写路径）
- `screens/plugin-page.js`：`plugin-page:<id>` 屏幕。声明从插件列表读（单一事实源）；
  每块独立加载数据，一张表挂了不拖垮整页。**渠道设置按面板作用域读回**——
  两个渠道都声明 `url` 字段时各自保值（flat query 只会读到第一个）
- `shell.js`：`plugin-page:` 前缀加入分派（现在 5 个动态前缀）；`state.js`：`state.plugins` 在 `loadContext()` 填充
- `api.ts`：插件列表**服务端解析 manifest** 并透出 `adminPages[]`/`channels[]` 数组——
  原来存的是 JSON 字符串，声明了但没人能读（"声明先于运行时"家族再添一员，这次在 API 层）
- 反向验证：两列表各删一项 → 两条守卫红在**不匹配分支**（与"文件不存在"分支不同路），
  错误信息并排打出两侧列表 → 还原哈希 `66040d89` 一致

## 4. 待办（接手人从这里开始）

> ✅ **本节已全部完成，以下保留原文供追溯。**

### 步骤 7：`plugins/notify/` 示例插件 —— ✅ 完成
- 声明 `webhook` 渠道 + 一个 `adminPages`（用全三种块）+ `notify-settings` 菜单 ✅
- **`plugin.json` 真实存在于磁盘**（`tests/suites/admin-menus.test.mjs` 从磁盘读它，43 条通过）✅
- 真实校验器 `validateManifest(manifest, "plugin")` 接受 ✅
- 实际落盘：`hooks: ["html","afterSavePost"]`、`subscribes: ["PostPublished"]`、
  `tables[]` 一张 `log`（`event`/`target` text、`severity` number、`note` longtext，
  `translatable: ["event","target","note"]`）、`webhook` 渠道四字段配置、
  `deliveries` 页面四块（`stats`×2 / `table` / `form`）、两个菜单、内联 en/zh-CN 语言包

### 步骤 8：`tests/suites/plugin-pages.test.mjs` + 反向验证 —— ✅ 完成
- **56 条断言**，驱动真实 Worker 对真实本地 D1 覆盖：未声明页面 id 被拒（规则 50）、
  块类型闭集合（规则 49）、`form` 块写入落到**真实物理行**、`stats` 聚合数字正确、
  禁用插件菜单与页面从注册表消失，外加按站点租户边界与 **§9 渲染器真渲染**
- **`tests/tools/_plugin-pages-inject.mjs`**：10 个场景，每个注入真实缺陷 → 断言**具名断言**变红
  → 还原 → 哈希一致。**10 场景 0 problem**
- 顺带补上**「插件自有表」的最后一段未接线**：`syncOwnerTables` 早支持 `"plugin"` 但没人调用，
  经 `PluginTableSync` 提供者注入（规则 3 不允许 `plugin/` import `theme/`）按站点扇出

### 收尾杂项 —— ✅ 完成
- `_tenant-query-audit.mjs` 的 `REVIEWED` 键是 `file:line`——`api.ts` 新增行后
  `theme_installs` 那条从 `:1154` 移到 **`:1187`**，已重新键位；并补了
  `notify.ts:108`（去重台账回写）的裁决。现在 **8/8 全部有裁决** ✅
- `tests/suites/manifest-validation.test.mjs` 的重复小节号已修（`11.`→`7.`，后续顺延）✅
- **`docs/HANDOVER.md` 已刷新**（§2 提交脉络、§5 批次 6–10、§6 套件表 19 套件 925 条、
  §7 SPA 落点、§8 坑位 26–29）；**本文档已降级为批次存档** ✅


## 5. 验证命令（全在本机沙箱可直接跑）

```bash
npx tsc --noEmit                                   # src/ 0 错误
node tests/<name>.test.mjs                         # 逐个跑；判据 0 failed，别数断言总数
# ⚠️ 不要用 node tests/run-all.mjs（本沙箱 EBUSY 整体 SKIP，不是绿）
# 推送后三路校验：
git rev-parse HEAD && git ls-remote origin main && gh api repos/unifare/CFCMS/commits/main --jq .sha
```

当前基线：**17 套件 848 条 0 失败**（account 27 / admin-contract 32 / admin-menus 43 /
admin-spa 15 / architecture 45 / i18n 66 / launcher-parity 55 / manifest-validation 104 /
menu-custom 40 / multisite 74 / plugin-channels 55 / plugin-hooks 32 / scaffold 71 /
template-engine 49 / theme-fixture 47 / theme-integration 65 / theme-worker 28）。

## 6. 本轮新踩的坑（叠加在既有"十二种假绿"之上）

1. **设计文档的迁移要先用真 SQLite 跑**——`INSERT…SELECT` 的 UNIQUE 冲突会让
   整条语句中断而不是跳过（步骤 2，§3）。
2. **"端点被调了几次"要用计数 stub 直证**——只断言返回值 `deduped:true` 的守卫，
   对"发了两次然后撒谎"的实现免疫（步骤 5 的 7 红里最关键一条）。
3. **去重索引必须含 site_id**——没有它 A 站吞 B 站的 key；测试要双向断言
   （他站能发 + 本站仍被去重），单边断言两边都看不见。
4. **测试自己的断言也会错**——渠道套件首轮 2 红，全是断言错（跨站行被当重复数；
   错误台账的检查放在了清台账的小节之后）。先查证据（打日志看真实行）再改断言，
   别急着改实现。
5. **`plugin_settings` 是 `(plugin_id,key)→value`**，没有 `id` 列没有时间戳——
   写夹具前先 `PRAGMA table_info`。
6. **API 透出的声明字段要服务端解析**——manifest 存的是 JSON 字符串，
   "透出了但读不了"与"校验了但没人读"同族。
7. **多渠道同名字段的读写要按面板作用域**——flat `querySelector("[data-ch]")`
   永远命中第一个渠道的输入框，第二个渠道的 endpoint 静默不可配。
8. **`.git/COMMIT_MSG.txt` 会在 `&&` 链短路时残留**——提交链用 `;` 分隔 rm，
   或提交前先删。
9. **admin SPA 的相对导入层级**：`js/screens/*` 用 `../../ui.js`，`js/*` 用 `../ui.js`；
   `admin-spa.test.mjs` 的模块图检查会立刻抓错（本轮被它抓回来一次）。

## 7. 关键不变量（本批次新增，违者架构测试会红）

- 规则 48：插件 manifest 不得含可执行代码（`hooks` 是名字，实现永远在宿主 `HOOK_IMPLS`）
- 规则 49：`adminPages[].blocks[].type` 是闭集合（`ALLOWED_PAGE_BLOCKS`），每种类型
  必须在 `validation.ts` 有校验、在后台 SPA 有渲染器（`RENDERED_BLOCK_TYPES` 导出对比）
- 规则 50：菜单 `screen: "plugin-page:<id>"` 必须指向该插件真实声明的 `adminPages[].id`
- 规则 51：渠道 `code` ∈ `HOST_CHANNEL_CODES`；`configSchema[].type` ∈
  `ALLOWED_CHANNEL_FIELD_TYPES`；两侧都由架构测试与 `RENDERED_CHANNEL_FIELD_TYPES` 双向核对
- 渠道配置的存储命名空间 `channel.<code>.<key>` **是线格式**：SPA 写入与
  `readChannelConfig` 读取拼写必须一致（各只许出现一次）
- `{table}_i18n` 永不 drop；主表只 ADD COLUMN；`theme_table_defs` 记 `owner_type`+
  `owner_name`+`logical_name`，切主题/禁插件**不清**（幂等 sync 负责收敛）
