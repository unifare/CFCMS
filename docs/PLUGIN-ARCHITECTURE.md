# 插件架构决策（v0.8.0 批次 10）

> 前置：`docs/PLUGIN-DESIGN-RESEARCH.md`（参考实现研究）。
> 本文是把研究结论落成**可执行的决策**，回答「新插件长什么样」。

---

## 0. 用户已确认的三件事

| 问题 | 答复 |
|---|---|
| 删除范围 | **插件 + 主题都清**（`plugins/` 与 `themes/` 里除 `default` 外全删） |
| 第一版渠道 | **只做 notification**（邮件 + webhook 抽象），payment 留接口不实现 |
| 插件自定义页面 | **完整自定义页面** |

第三条需要一次设计解释，因为「完整自定义页面」有个常见的误读。

---

## 1. 「完整自定义页面」在 Workers 里到底意味着什么

### ❌ 误读：把参考实现的 `adminPage(path, handler)` 搬过来

参考实现的做法是——
```js
sdk.adminPage('/your-plugin', (req, res) => { res.render('index', {...}); });
```
它成立的**唯一前提**是「插件的 `index.js` 能被 `require()` 进进程，然后自己注册路由」。
在 Cloudflare Workers 里这是**彻底的禁区**：

- `eval` / `new Function` → 平台禁止
- 动态 `import(userCode)` → 平台禁止
- 就算能加载，也等于**在宿主进程里跑任意第三方代码**，与 CFPress 的
  `capabilities.ts` 能力白名单模型直接冲突

所以 `adminPage(path, handler)` 这条路**不是"没做"，是"不能做"**。

### ✅ 正解：**声明式页面** —— 插件描述页面，宿主渲染页面

插件交的是**数据**，不是可执行代码：

```json
{
  "adminPages": [
    {
      "id": "feishu-logs",
      "path": "logs",
      "title": "通知发送记录",
      "blocks": [
        { "type": "table", "source": "notify_log", "columns": ["sent_at","channel","ok","error"] },
        { "type": "stats", "source": "notify_log", "aggregate": "count", "groupBy": "ok" },
        { "type": "form", "source": "notify_test", "fields": ["channel","title","body"] }
      ]
    }
  ]
}
```

宿主按 `blocks[]` 渲染出**真实的、可交互的**后台页面。
这就是「完整自定义页面」在无构建 Workers 架构下的**正确形态**：
**能力不打折**（插件真能有自己的页面、表格、表单、统计），
**信任边界不破**（插件永远不执行自己的代码，只声明意图）。

这套机制与仓库里已经验证过的两件事**同源**：

| 已有机制 | 同一原理 |
|---|---|
| `tables[].fields[]` → 后台自动生成增删改查表单 | 声明 → 宿主渲染 |
| `channels[].configSchema[]` → 后台自动生成设置表单 | 声明 → 宿主渲染 |
| **`adminPages[].blocks[]` → 后台自动生成页面** | **同一原理的第三次应用** |

> 换句话说：这不是新发明，是把仓库里已经跑了两个月的模式**再推一层**。
> 参考实现花费了 `PluginSDK` 65 行代码 + Express 依赖来换「插件能写页面」，
> 我们用一个 `blocks[]` 数组换同一件事，**且不需要执行任何插件代码**。

### 交付边界（这一版做到哪）

**做**：
- `blocks[]` 三种类型：`table`（宿主自有表数据）、`stats`（聚合）、`form`（写入宿主接口）
- 页面出现在**统一菜单注册表**里（`screen: "plugin-page:<id>"`），走既有站点级/用户级菜单逻辑
- `path` 在 `/admin` 下的稳定 URL，可直接分享

**不做（明确记下来，别让人以为是漏了）**：
- 插件自定义前端 JS/CSS（那会重新引入"可执行代码"问题）
- 任意 HTML 注入（`html` 模板串 = 注入面；`blocks[]` 是结构化白名单）
- 插件间页面互调

---

## 2. 渠道（notification）：这是本批次的主能力

### 2.1 契约在 `contract/channels.ts`

借鉴参考实现**唯一真正值得抄**的东西，但按 CFPress 的规矩重写。

参考实现里这个契约已经成型，写在
`nest-core/modules/notification/channels/notification-channel.abstract.ts`
（`ChannelMessage` / `ChannelSendResult` / `abstract class NotificationChannel`），
它的自我描述一句话说清了原理：

> 「与支付 PaymentChannel 同构：**规范在底层，实现在插件，展示在主题/通知中心**。」

这句话值得原样采纳——它就是 CFPress 已经在用的依赖倒置。
但**注册方式必须改**：参考实现用
`const mod = require(\`${dir}/${file}\`)` + `mod.default || mod[Object.keys(mod)[0]]`
去猜导出名。那个 `Object.keys(mod)[0]` 是**猜**——插件多导出一个辅助函数就会注册错东西，
而且又一次踩了动态加载红线。

我们的写法：

```ts
/** 宿主定义的通知渠道规范。实现由宿主提供——插件只声明要提供哪个 code。 */
export interface NotificationChannel {
  /** 稳定 id，`plugin.json` 里声明，全局唯一 */
  code: string;
  /** 后台显示名的语言包 key（不硬编码文案，规则 11 前缀） */
  labelKey: string;
  /** 配置项声明 → 后台自动渲染设置表单（type 是闭集合，见 2.2） */
  configSchema: ChannelConfigField[];
}

export interface ChannelConfigField {
  key: string;
  labelKey: string;
  type: "text" | "password" | "url" | "number" | "boolean";
  required?: boolean;
}

/** 一条待发送的通知。字段名沿用参考实现，因为它确实够用。 */
export interface ChannelMessage {
  title: string;
  content: string;
  payload: Record<string, unknown>;
  /** 幂等键：同一 dedupKey 不重复发送 */
  dedupKey?: string;
}

export interface ChannelSendResult {
  ok: boolean;
  error?: string;
}
```

声明：
```json
{
  "channels": {
    "notification": [
      { "code": "webhook", "configSchema": [
        { "key": "url", "labelKey": "plugin.notify.channel.webhook.url", "type": "url", "required": true }
      ]}
    ]
  }
}
```

**`dedupKey` 值得保留**：通知类插件最常见的真实 bug 就是「同一事件发两遍」
（重试、并发、hook 被多次触发）。把它放进契约而不是让每个插件自己造，
是参考实现做得对的一处。

**为什么 `configSchema` 的类型要白名单**：与 `ALLOWED_TABLE_FIELD_TYPES` 同一条规矩——
「每个类型必须有且只有一个后台控件，否则渲染出一个空输入框，看起来像数据坏了」。
所以 `ChannelConfigField.type` 必须是**闭集合**，加类型时必须同时加控件。
（参考实现的 `configSchema.type` 是裸 `string`，`channel.feishu.js` 里出现了
`type: 'password'` 而**没有对应的控件约定**——这是我们要修掉的那类模糊。）

### 2.2 谁执行发送

宿主。`channels` 是**声明**，真正 `send()` 的实现在宿主侧
（`extensions/plugin/channels/` 里每个 `code` 一个函数）。
插件声明「我要提供 feishu 渠道」，宿主说「好，feishu 的实现是我写的，你的配置我读」。

> 这听起来像"插件没干活"，但**这正是无构建架构下唯一诚实的做法**：
> 插件的价值在于**它声明了什么、配置了什么、数据存在哪**，
> 不在于它能在宿主进程里跑代码。参考实现最后也是被迫承认这一点
> （`app=null` + `registerPluginRouter` 只 warn）。

### 2.3 V1 交付的渠道

| code | 说明 |
|---|---|
| `webhook` | 通用 HTTP POST JSON —— **抽象出的最小可用渠道** |
| `mail` | 走既有邮件能力（若宿主没有则先在 `SendEmail` 能力下留桩） |

**只做 notification**（用户已定）。`payment` 不定义、不留空壳——
「把一个存在但不可用的选项留在白名单里，等于承诺了没实现的能力」（仓库已有此判据）。

---

## 3. 插件自有表：补上批次 4 的欠账

批次 4 记录：「⬜ 仅剩插件自有表（需重建 `theme_table_defs`）」。
本批次必须做完，否则任何插件都无法存数据。

**问题**：`theme_table_defs` 表只有 `theme_name` 一列，没有 `owner_type`，
所以**插件表无法登记**。而 SQLite **不能加 UNIQUE 约束、不能加复合主键**（`ALTER TABLE` 限制）
→ 必须**重建表**。

**迁移**（新文件 `migrations/00XX_plugin_tables.sql`）：
```sql
CREATE TABLE theme_table_defs_new (
  owner_type TEXT NOT NULL,   -- 'theme' | 'plugin'
  owner_name TEXT NOT NULL,
  logical_name TEXT NOT NULL,
  physical_name TEXT NOT NULL,
  PRIMARY KEY (owner_type, owner_name, logical_name)
);
INSERT INTO theme_table_defs_new (owner_type, owner_name, logical_name, physical_name)
  SELECT 'theme', theme_name, logical_name, physical_name FROM theme_table_defs;
DROP TABLE theme_table_defs;
ALTER TABLE theme_table_defs_new RENAME TO theme_table_defs;
```

**为什么物理表名必须带 owner 类型**：主题 `foo` 与插件 `foo` 是两个东西，
如果物理名都算成 `theme_foo_bar` 就会**撞表**。
参考实现在这里没有任何隔离，是靠作者自觉——我们不加这个前缀就等于退回到它的水平。

结论：物理名生成改为 `{owner_type}_{owner_name}_{logical}`（`theme_` / `plugin_`），
现有主题表名**不变**（迁移里 `owner_type='theme'` 已保证向后兼容）。

**多语言**：插件自有表**同样适用规则 41**——散文字段必须 `_i18n` 边车。
`{table}_i18n` 由 `syncOwnerTables()` 一并生成，与主题路径**共用同一份代码**。

---

## 4. 新增的架构规则（要同时改三处）

| # | 规则 | 强制点 |
|---|---|---|
| 48 | **插件不自带可执行代码**。`plugin.json` 里不得出现函数体/脚本路径；所有能力都是声明 | `validateManifest` 拒绝未知 key + `architecture.test.mjs` 扫描已交付插件目录，禁止 `.js` 文件 |
| 49 | **`adminPages[].blocks[]` 的类型是闭集合**，且每个类型必须在 `validation.ts` 有校验、在后台 SPA 有渲染器 | `ALLOWED_PAGE_BLOCKS`（`contract/manifest.ts`）+ 架构测试双向核对 |
| 50 | **`channels` 与 `ALLOWED_ADMIN_SCREENS` 同源**：`plugin-page:<id>` 前缀的 screen 必须对应 manifest 里真实存在的 `adminPages[].id` | 菜单注册时校验；`plugin-page:` 指向不存在的 id = 安装期拒绝 |
| 51 | **渠道 `configSchema.type` 是闭集合**，且每个类型有且仅有一个后台控件 | `ALLOWED_CHANNEL_FIELD_TYPES` + 架构测试 |

规则 48 是**本批次的地基**：它把「为什么不能照抄参考实现」写成机器可读的约束，
下次有人想加 `entry: "index.js"` 会被校验器直接拒绝，并给出理由。

---

## 5. 交付顺序（每步都要能独立验证）

1. **删旧**：`plugins/` 三个目录、`themes/` 除 `default` 外全删；同步 `tests/` 里引用它们的用例
2. **迁移**：`theme_table_defs` 重建 + `syncOwnerTables()` 支持 `owner_type`
3. **契约**：`contract/channels.ts`（新）+ `manifest.ts` 加 `adminPages` / `channels` / `ALLOWED_PAGE_BLOCKS` / `ALLOWED_CHANNEL_FIELD_TYPES`
4. **校验**：`validation.ts` 实现规则 48–51（失败抛错）
5. **运行时**：`runtime.ts` 的 `HOOK_IMPLS` 增渠道下发；`channels/` 实现 `webhook`
6. **后台**：`public/admin/` 加 `plugin-page` 渲染器（三种 block）+ 渠道设置表单
7. **新插件**：`plugins/notify/` 作为**范例插件**（声明 webhook 渠道 + 一个 adminPage）
8. **测试**：`tests/plugin-channels.test.mjs` + `tests/plugin-pages.test.mjs` + 反向验证

**验证判据**：`npx tsc --noEmit` src/scripts 0 错误；
全部套件 0 failures；新插件在真实浏览器里能配 webhook 并看到发送记录页。

---

## 6. 与参考实现的最终取舍（一页总结）

| 参考实现 | 我们 | 为什么 |
|---|---|---|
| `require(plugin/index.js)` + `activate()` | ❌ 不抄 | Workers 禁动态加载；且 = 跑任意代码 |
| `sdk.adminPage(path, handler)` | ⚠️ 改造为 `adminPages[].blocks[]` | 保留"插件有自己的页面"，去掉"执行插件代码" |
| `channels{}` + `configSchema` | ✅ **抄** | 宿主定规范/插件填实现的依赖倒置，教科书级 |
| ~135 个钩子无消费点校验 | ❌ 反例 | 拼错钩子静默失效，正是本仓库修过的缺陷族 |
| `entry` / `entryFile` 双拼法 | ❌ 反例 | 两个名字指同一件事 = 两个权威 |
| 插件表无命名空间 | ❌ 反例 | 靠自觉必然撞名；我们已有 `owner_type` |
| 运行时 `sequelize.define` 建表 | ⚠️ 改造为安装时生成迁移 | D1 表结构由迁移驱动 |
| `wp:hookFired` 通配广播 | ⚠️ 已有 `contract/events.ts` | 事件与 hook 是两层，禁止互相掺入（规则 45） |
