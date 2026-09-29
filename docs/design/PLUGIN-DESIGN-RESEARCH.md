# 插件设计研究：nodecms 参考实现 vs CFPress

> 研究日期 2026-09-29。目的：在写新插件前，先把参考实现的设计读清楚，
> 判断哪些该借、哪些**不能**借（因为运行时约束不同）。
>
> 参考仓库：`D:\1Dev\nodecms\nodecms`（Node/Express + Sequelize，另有 NestJS 增量层，可部署到 Workers）
> 目标仓库：CFPress（无构建 TypeScript + Cloudflare Workers / D1 / R2 / KV）

---

## 1. 参考实现有两套插件系统（这是个信号）

| | **老系统** `core/plugin-*.js` | **新系统** `nest-core/modules/plugin-system/` |
|---|---|---|
| 定位 | Express + Sequelize，运行时 `require()` 磁盘文件 | NestJS，DI + `EventEmitter2` |
| 发现 | `plugins/*/plugin.json` | 同左（**兼容同一份目录约定**） |
| 入口 | `index.js` 导出 `activate(ctx)` | 同左 |
| 钩子 | 自建 `hooks`/`filters` 表 + 优先级排序 | 桥接到 Nest 事件总线 |
| 备注 | 文件头写着「`app=null`，Express 已退役」 | 自称是兼容层 |

**关键观察**：`plugin.loader.ts` 的注释说得很直白——

> 「兼容层（Express 退役）：老插件 `activate({app, addHook, ...})` 依赖的参数由本加载器提供
> 兼容对象——`app=null`（插件需条件跳过 Express 路由）」

也就是说：**新架构无法继续支持「插件注册 HTTP 路由」这件事**，只能给一个打印
`logger.warn("请通过 API 控制器注册")` 的空壳。`compatContext()` 里的
`registerPluginRouter` 是个**只警告不做事**的桩。

> ⚠️ **这是参考实现里最重要的一条教训，而且和 CFPress 强相关。**
> CFPress 的根约束更硬：Workers 里**根本不能 `eval` / `new Function` / 动态 `import` 用户代码**。
> 参考实现里所有「`require(entryPath)` 然后让插件自己 `express.Router()`」的路子，
> 在 CFPress 里**从第一行就不可能**。所以参考实现的**执行模型不能抄**，
> 只能抄它的**声明模型**。

---

## 2. 参考实现的钩子目录（这是最有价值的部分）

`core/hooks.js` 是一份**纯词汇表**：`ACTION_HOOKS`（约 90 个）+ `FILTER_HOOKS`（约 45 个），
每个都是 `名字 → 一句中文说明`。

命名约定是**`域:时机`** 或 **`域:子域:时机`**：

```
wp:init / wp:ready / wp:shutdown / wp:hookFired     系统生命周期
post:beforeCreate / post:afterUpdate / post:published   文章 CRUD
user:login / user:register / user:deleted
media:beforeUpload / media:afterUpload
theme:beforeSwitch / plugin:afterActivate           主题/插件自身生命周期
frontend:head:start / admin:sidebar:end             渲染插槽（成对 start/end）
cron:minute / cron:hourly                           定时
content:body / post:data / menu:items               过滤器（改名：名词）
```

**值得借的三点**：

1. **`start`/`end` 成对**。`frontend:head:start` + `frontend:head:end` 让插件能在
   `<head>` 的开头或结尾插入，而不是只给一个 `head`。这个小设计显著减少了
   「我要插在 jquery 之后、我的脚本之前」这类真实冲突。
2. **动作 vs 过滤器分开命名**：动作是 `域:时机`（`post:afterCreate`），
   过滤器是 `域:名词`（`post:data`）。语义一眼可辨。
3. **`wp:hookFired` 通配广播**：任何钩子触发时额外广播一次 `(eventName, ...args)`，
   供「通知系统」这类全局订阅者使用。代码里**显式跳过自身避免无限递归**，
   且「无订阅者则零开销」。

**不能照搬的一点**：这 ~135 个钩子**没有任何一个被消费点校验过**。
`getAllHooks()` 只是把两张表返回给后台页面显示。插件声明了一个拼错的钩子名，
`addHook` 会照样存进 `hooks[name]`，而**永远不会有人调用它**。
这正是 CFPress 已经踩过并修过的缺陷族——「声明先于运行时：字段被校验、运行时没人读」。

---

## 3. 参考实现的 `plugin.json`：声明了但没人读的字段

我把参考仓库所有 `plugin.json` 的 key 汇总，逐个核对**是否有代码消费**：

| key | 出现频率 | 是否被消费 | 说明 |
|---|---|---|---|
| `name` | 全部 | ✅ | 加载器用它当 slug |
| `version` | 全部 | ✅ | 写入 D1 `plugins` 表 |
| `description` / `author` | 常见 | ✅ | 写库 + 后台显示 |
| `entry` / `entryFile` | 常见 | ✅ | **两个名字并存**，见下 |
| `hooks[]` | 部分 | ❌ | **只声明，无校验无消费**（`ai-article-assistant` 声明 3 个） |
| `assets.css/js[]` | 部分 | ⚠️ 半 | 后台模板里可能有注入，但不在加载器 |
| `config{}` | 部分 | ❌ | `position`/`trigger`/`shortcuts` 全无读取路径 |
| `channels{}` | 少数 | ✅ | **真有消费**（见 §4） |
| `components[]` | 少数 | ⚠️ | 新系统声明了 `ComponentRegistry`，但注册发生在插件入口里 |
| `requires[]` | 少数 | ❌ | 依赖声明无解析逻辑 |
| `type: "extension"` | 部分 | ❌ | 无分支读取 |

**`entry` vs `entryFile` 是同一个字段的两个拼法**，而且**两处代码读的不是同一个**：

- `core/plugin-loader.js`（老系统）读 `info.entryFile`
- `nest-core/.../plugin.manifest.ts`（新系统）声明 `entry: string`，加载器读 `manifest.entry`

老插件写 `entryFile`、新系统读 `entry` → **新系统加载这批插件时 `entry` 是 `undefined`**，
落到兜底 `'index.js'` 才没炸。这是一个**活着的、靠巧合工作**的双拼法。

> ⚠️ 这是第二条重要教训：**允许两个名字指同一件事，等于两个权威**。
> CFPress 已经有对应规则（规则 42：「两个权威，拒绝」）。这条经验直接印证它。

---

## 4. 参考实现里最漂亮的设计：**渠道（channels）**

这是我认为整个参考实现里**唯一真正值得抄**的机制。

`plugin.json`：
```json
{ "channels": { "notification": ["channel.feishu.js"] } }
```

`channel.feishu.js` 导出一个**类**，遵守一个约定形状：
```js
class FeishuChannel {
  code = 'feishu';  name = '飞书';  icon = 'bi-bell';
  configSchema = [{ key:'webhook_url', label:'Webhook 地址', type:'text' }, ...];
  async isConfigured() { return !!this._config.webhook_url; }
  async send(message) { /* ... */ }
}
module.exports = { FeishuChannel };
```

**为什么这个设计好**：

1. **宿主定义规范，插件提供实现**——不是插件随便挂钩子，而是宿主说
   「我要一个能 `send(message)` 的东西」，插件填进来。这是**依赖倒置的教科书用法**，
   和 CFPress 已经在用的 `contract/hooks.ts` + `setHostHooks()` 是同一个模式。
2. **`configSchema` 由插件声明，后台自动渲染设置表单**——插件不需要写后台 UI，
   只描述「我有这几个配置项」，宿主负责画出来。这解决了插件最烦的一件事。
3. **一个插件可以贡献多个渠道**，彼此独立。
4. **`isConfigured()` 与 `send()` 分离**——后台可以先问「你配好了吗」再决定是否
   把它列进可选渠道，而不是等到发消息才失败。

**和 CFPress 的契合度**：这个概念能直接映射。CFPress 已经有
`DECLARABLE_HOOKS`（宿主声明的、会被真正调用的钩子白名单）。渠道就是
**第二类扩展点**：不是「往流程里插一段」而是「提供一个具名能力的实现」。
而且它**天然适合 Workers**——纯数据声明 + 一个纯函数式实现，不需要动态加载。

---

## 5. 参考实现的插件自有表：**不存在**

我专门找了，结论是**参考实现不支持插件声明自己的数据库表**。

- 老系统靠 `sdk.loadModels(sequelize, {...})`，插件**运行时**调 Sequelize 建表。
  注释里还留着一句很说明问题的话：
  > 「只同步本次注册的插件模型，避免全库 sync 触发其它插件（同库不同表）的索引重建冲突」
- 新系统 `PluginManifest` 里**根本没有 `tables` 字段**。
- 所有插件表**共享同一个数据库、同一套表名空间**，没有任何前缀隔离。
  插件作者按要求「用有意义的模型名称，避免与系统模型冲突」——**靠自觉**。

> ⚠️ 第三条教训：**没有命名空间隔离 = 插件之间以及插件与核心之间争表名**。
> CFPress 在这点上**已经比参考实现强**（`theme_{owner}_{table}` 由平台生成，
> AGENTS.md 规则 8 明令「表名不得硬编码」）。**不要因为参考实现没有就觉得自己多余。**

---

## 6. 两边的结构性对比

| 维度 | nodecms 参考实现 | CFPress 现状 |
|---|---|---|
| 运行时 | Node + `require()` 动态加载磁盘文件 | **Workers：禁 eval / 动态 import** |
| 插件代码何时执行 | 进程启动时 `require` 并 `activate` | 只能在**安装时校验+存起来**，运行期靠声明驱动 |
| 钩子定义 | ~135 个，**无消费点校验** | 7 个 `DECLARABLE_HOOKS`，**校验器拒绝拼错的** |
| 声明校验 | 基本没有（JSON 随便写） | `validateManifest()`，失败**抛错**（安装边界） |
| 表命名空间 | 无，靠自觉 | `theme_{owner}_{table}`，平台生成 |
| 插件自有表 | ❌ 不支持声明 | ⬜ **未完成**（`theme_table_defs` 只有 `theme_name`） |
| 渠道/能力扩展点 | ✅ `channels{}` | ❌ 无 |
| 配置表单 | ✅ `configSchema` 自动渲染 | ⚠️ `settings[]` 声明了，表单能力有限 |
| 后台菜单 | ✅ `setAdminMenu()` + `menu:items` filter | ✅ `adminMenus[]` + 统一菜单注册表 |
| 多语言 | `plugins/{slug}/langs/*.json` 运行时注册 | 插件**无目录可读**（zip 原样存）→ 只能内联 `plugin.json` 的 `langs{}` |
| 事件 | `wp:hookFired` 通配广播 | `contract/events.ts`（21 个事实）+ hook 通道，**两者禁止互相掺入** |

**一句话总结**：参考实现的**声明模型很粗糙但很全**（什么都想到了：渠道、配置、
菜单、依赖、组件），**执行模型很灵活但不可移植**（动态 require、Express 中间件、
Sequelize 运行时建表）。CFPress 必须走**声明优先、校验严格、执行期只读声明**的路线。

---

## 7. 结论：我要做什么

### 直接借（设计）

1. **渠道（channels）机制** —— 第二类扩展点。宿主定义接口，插件提供实现。
   `configSchema` 由插件声明、后台自动渲染设置表单。这是参考实现最好的部分。
2. **`start`/`end` 成对插槽** —— 渲染钩子成对出现，减少插入位置冲突。
3. **动作 / 过滤器命名区分** —— 动作 `域:时机`，过滤器 `域:名词`；语义自明。
4. **`isConfigured()` 与执行分离** —— 后台先问配置状态，再决定是否列出。

### 明确不借（执行模型）

1. **动态 `require` 插件入口** —— Workers 不可能。改为**声明驱动**：
   插件只交 `plugin.json` + 静态资源，行为由宿主按声明执行。
2. **运行时 `sequelize.define` 建表** —— 改为**安装时把声明翻译成迁移 SQL**（CFPress 已有此路）。
3. **`entry` / `entryFile` 双拼法** —— 一个字段一个名字，否则「两个权威」。
4. **无人消费的声明字段** —— 这条是 CFPress 的**红线**（规则 42/43 的精神）：
   每个新字段必须先找到消费点，找不到就不加。

### 要**加强**超过参考实现的地方

1. **钩子白名单必须被消费点校验**（参考实现的 135 个钩子全无校验，是反面教材）。
2. **插件表必须有命名空间**（参考实现靠自觉）。
3. **`channels` 也要进 `validateManifest`**——渠道类型、实现文件、`configSchema`
   的字段类型都要在安装边界拒绝非法值，而不是运行到一半才发现。

---

## 8. 待确认的三件事（开工前问用户）

1. **第一版做哪些渠道类型？** 参考实现有 `payment` 与 `notification` 两类。
   notification（邮件/飞书/Telegram/webhook）显然先做，payment 要不要现在做？
2. **插件是否需要「后台自己一屏」？** 参考实现有 `adminPage()` 注册任意页面。
   CFPress 的菜单注册表支持 `screen: "plugin-settings"`，但**不支持插件自定义页面**。
   要不要加？这是一个不小的能力面。
3. **现有三个插件全删，是从 `plugins/` 删掉，还是保留 `example` 当模板？**
   （用户说「把主题上插件都删除了」——需确认是删插件还是连主题一起删。）
