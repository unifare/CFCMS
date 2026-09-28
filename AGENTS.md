# AGENTS.md — 硬规则

这份文件是给 AI（以及人类）改这个仓库时的**强制约束**。完整设计理由见
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。这里只列会**导致测试失败**的规则。

> 有疑问时：规则本身由 `tests/architecture.test.mjs` 强制执行。
> 改规则必须同时改测试，否则规则不存在。

---

## 改代码前

1. 跑 `npm test`，确认基线是绿的（**判据是 0 failures**；断言数会随套件增减变化）。
2. 跑 `npx tsc --noEmit`，`src/` 必须 0 错误。
   （`node_modules` 里 `lib.dom.d.ts` 与 `@cloudflare/workers-types` 的冲突是上游问题，可忽略。）

## 改完代码后

3. 再跑一次 `npm test` 与 `npx tsc --noEmit`，两个都必须绿。
4. 如果改了扩展的声明能力（主题清单 / 插件清单的字段），同步更新
   `tests/architecture.test.mjs` 与 `docs/ARCHITECTURE.md`。
5. **加了新的架构规则，必须同时做一次「反向验证」**：故意注入一次违规，
   确认测试真的会 FAIL，再撤回。**测不出失败的检查等于没有检查**——
   本仓库已经发生过两次（见下方「守卫失效记录」）。

**当前源码布局**（已重整完毕，新代码必须放对位置）：

```
src/
├── index.ts              前台路由      ← 唯一可以知道所有层的地方
├── api.ts                管理 API
├── shared/               叶子层：types crypto repo cache scheduler
├── rendering/            纯渲染：template-engine template-resolver blocks
├── platform/             auth permissions sites frontend seo revisions
└── extensions/
    ├── contract/hooks.ts ★ 主题与插件共享的接口（依赖倒置的支点）
    ├── security.ts
    ├── theme/            runtime-declarative runtime-worker capabilities templates
    └── plugin/           runtime
```

---

## 分层（§7.3）

| # | 规则 |
|---|---|
| 1 | `src/platform/` 不得 import `src/extensions/` |
| 2 | `src/rendering/` 不得 import `src/extensions/` |
| 3 | `src/extensions/theme/` 与 `src/extensions/plugin/` **互不 import** |
| 4 | `src/shared/` 不得 import 任何业务层 |
| 5 | 只有 `src/index.ts` 可以知道所有层 |

**理由**：主题和插件消费的是**同一套宿主接口**。这条守住了，"插件也能注册后台菜单"
才是免费的而不是特例；守不住，两者就会长成两套无法合并的东西。

**规则 3 的具体做法（别绕过它）**：主题渲染需要给插件机会改输出（`beforeRender`、
`html` filter、短代码），但**主题绝对不能 `import` `plugin/`**。正确姿势是：

```ts
// extensions/theme/… 里 —— 只认接口，不认识 plugin/
import { hostHooks } from "../contract/hooks";
const hooks = o.hooks ?? hostHooks();
await hooks.applyFilters("html", ctx, out);
```

真正的实现由 `index.ts` 在 boot 时用 `setHostHooks({...})` 注入一次。
没有注入时 `hostHooks()` 返回 `NULL_HOOKS`（空实现、原样返回）——
**行为与"本站没装插件"完全一致，所以调用点不需要 null 判断**。

> 违反这条的典型症状：功能全对、测试全绿，但插件变成了每个主题的硬依赖，
> 删掉插件主题就编译不过。`tests/architecture.test.mjs` 现在会拦住它。

## 数据访问（§10 规则 4、9）

| # | 规则 |
|---|---|
| 6 | 数据访问函数**必须显式接收** `siteId` 与 `locale`，**不得有默认值** |
| 7 | 主题/插件**不得直接写 SQL**（`env.DB.prepare("SELECT…")` 一律禁止），只能用宿主 facade |
| 8 | 表名由平台生成（`theme_{owner}_{table}`），**不得硬编码** |
| 9 | 只读本主题/本插件声明过的表 |

规则 6 现状：**已清零**（26 处字符串字面量 + 6 处 `DEFAULT_SITE_ID` 常量形式全部移除）。
棘轮常量 `ALLOW_KNOWN_DEFAULTS` 已删除，现在是**零容忍硬规则**。

> ⚠️ 注意 **`siteId = DEFAULT_SITE_ID` 也算违规**。用常量拼写不会让它变成好设计，
> 只会让正则更难发现它——这正是它藏了很久的原因。

**理由**：`siteId = "default"` 是多站点 bug 的藏身处——调用点能编译、能运行、
静默读错站点的数据。上一轮修的 `activeTheme()` 缺陷就是这个模式的产物。

**唯一合法的兜底位置**：把「请求 → 站点」的解析收敛到 `requestSiteId(url)` 一处。
那里必须给出兜底，因为这是唯一真正需要做选择的地方；它写成**表达式**而非参数默认值。

## 守卫失效记录（READ THIS）

`tests/architecture.test.mjs` 自己出过两次**假绿**，两次都是「检查存在但从不触发」：

| 检查 | 曾经的写法 | 为什么失效 | 现状 |
|---|---|---|---|
| `siteId` 默认值 | 只匹配 `= "default"` 字面量 | `siteId = DEFAULT_SITE_ID` 完全匹配不到，6 处长期漏网 | 已同时匹配字符串与常量，并锚定到参数列表 |
| 主题/插件互不 import | `spec.includes("/extensions/plugin/")` | 真实写法是 `"../plugin/runtime"`，**不含 `/extensions/`** | 已改为按文件目录**解析路径**再比较 |

**教训**：文本匹配容易被"同一意图的另一种写法"绕过。凡是要守卫结构，就解析结构
（路径、AST、类型），别匹配字符串。**每次新增守卫，都要注入一次违规确认它会红。**

## 多语言（§10 规则 5、7、8）

| # | 规则 |
|---|---|
| 10 | 回退顺序恒为：当前语言 → 站点默认语言 → 空。**不抛错** |
| 11 | 语言包 key 必须带前缀：`core.` / `theme.{name}.` / `plugin.{name}.` |
| 12 | **界面语言**（后台菜单）与**内容语言**（前台文章）是两件事，不得混用 |
| 13 | 显式语言的 URL（`/en/x`）找不到时返回 404，**不回退到别的语言** |

规则 11 的后果：`themes/aurora/langs/zh-CN.json` 里写 `"nav.home"` 会让测试失败，
必须写 `"theme.aurora.nav.home"`。**这不是风格要求**——两个扩展都定义 `nav.home`
时，谁生效取决于加载顺序，且没有正确的修复位置。

## 主题 / 插件清单（§5.3）

| # | 规则 |
|---|---|
| 14 | 声明的 `templates[]` 必须真的存在对应文件（`runtime: "worker"` 的主题豁免） |
| 15 | `routes[].resolve.table` 必须已在 `tables[]` 里声明 |
| 16 | `tables[].translatable` 里的 key 必须是该表声明过的字段 |
| 17 | 表的字段名不得与保留列冲突：`id`/`site_id`/`slug`/`lang_group`/`status`/`created_at`/`updated_at` |
| 18 | `runtime: "worker"` 的主题必须真的提供 `entry` 指向的文件 |
| 19 | `blocks[].name` 是**纯标识符、不带斜杠**（`property-card` ✅ / `theme/property-card` ❌）。`core/` 前缀是平台内置专用的 |

**理由**：清单是主题唯一能出错的地方，那就在这里出错。放行会变成渲染期的报错，
而那个报错会指向渲染器，不指向清单——排查成本高一个数量级。

**校验失败必须抛出、必须让安装失败**，不能警告后继续。写法是 `validateManifest` 抛
`Error`，`src/api.ts` 的 `uploadExtension()` 捕获后返回 400。一个装不上的主题
胜过半个能跑的主题。规则 14–19 每一条都在 `tests/manifest-validation.test.mjs` 里
有对应的"注入缺陷 → 断言必须抛错"用例；改校验逻辑时那道套件必须跟着改。

---

## 后台 SPA（`public/admin/`）

后台是**零构建**的原生 ESM，分层顺序是
`admin.css`（令牌→组件）→ `icons.js` → `ui.js` → `admin.js` → `js/**`。

```
admin.js               入口：只做装配与 window.* 注册（< 120 行）
js/state.js            共享 state + API 帮手（叶子模块，不 import 任何东西）
js/nav.js              导航模型 / 侧栏 / header（纯 markup 构造）
js/shell.js            render 循环 + 页面骨架 + 导航动作 + 屏幕注册表
js/auth.js             登录屏 / 登录 / 登出
js/screens/index.js    页名 → 屏幕 注册表（唯一 import 全部屏幕的模块）
js/screens/<name>.js   一屏一模块
```

| # | 规则 |
|---|---|
| 20 | `js/shell.js` **不得 import 任何屏幕**（屏幕经 `setScreenTable()` 自注册），否则立即成环 |
| 21 | 屏幕之间**不得互相 import**；共用逻辑抽独立模块（如 `extension-install.js`） |
| 22 | 每个被 markup 调用的处理器**必须登记进入口的 `WINDOW_HANDLERS`** |
| 23 | 不得引入打包器；不得删 `index.html` `<head>` 里的绘制前主题脚本 |

**理由（规则 20–21）**：屏幕要调 `render()`，`render()` 要调屏幕——直接互相
import 就是环。环在部分浏览器能跑、部分不能，且让"改一个屏幕"重新变成
"必须理解全部屏幕"。自注册把这条边反转成单向。

**理由（规则 22）**：markup 用内联 `onclick="name(...)"`，浏览器把它解析在
`window` 上、**不在模块作用域**。少登记一个**不会有任何报错**——
不编译、不报 console、不发失败请求，按钮就是点了没反应。这是最贵的一类回归。

规则 20–23 由 `tests/admin-spa.test.mjs` 强制（模块图无环 + 无孤儿模块 +
`window.*` 契约 + 每个屏幕真渲染一次）。**改后台结构时那道套件必须跟着改。**

> ⚠️ 该套件有一处**已修过的假绿**：它最初断言"`render()` 没有抛错"，
> 而 `render()` 自己 catch 住屏幕异常并换成 "Something went wrong" 面板，
> 于是注入一个未定义标识符后测试依然全绿。现在断言的是**写进 DOM 的内容**
> （非空、不含错误面板）。**别把它改回"断言没抛错"。**

---

## 允许做的事

- ✅ 加新的 `screen` 类型（同时更新 `ALLOWED_ADMIN_SCREENS` 与 `docs/ARCHITECTURE.md` §3.5）
- ✅ 加新的 capability（同时更新 `CAPABILITIES` 与 §4.3）
- ✅ 加新的 `DECLARABLE_HOOKS`（同时更新 §4.2）
- ✅ 重构实现，只要不跨越上面的规则

## 明确不做的事

- ❌ 往 `platform/` 里 import 某个具体主题
- ❌ 在主题里写 `env.DB.prepare(…)`
- ❌ 让 `extensions/theme/` import `extensions/plugin/`（走 `contract/hooks.ts`）
- ❌ 给数据访问函数补一个"方便的" `siteId = "default"` 默认值（**常量形式也不行**）
- ❌ 在主题/插件里自己写鉴权（`jwt.verify` / 检查 `role`）
- ❌ 手写后台表单（应由 `fields[]` 声明生成）
- ❌ 主题切换时删除业务数据（只隐藏，不删除）
- ❌ 新增架构规则却不做反向验证（测不出失败的检查不是检查）

---

## 已知的、有意保留的偏离

| 事项 | 现状 | 原因 |
|---|---|---|
| `theme_admin_menus` 与插件菜单 | 尚未合并为 `admin_menu_registry` | 批次 3（已决定：迁移时 drop 旧表） |
| 后台 SPA 的目录位置 | 模块结构已按 §7.2 拆好，但仍在 `public/admin/` 而非仓库根的 `admin/` | `wrangler.jsonc` 的 `assets.directory` 只接受一个目录，而 `/admin/*` 必须保留；搬迁需与 `public/` 的资源归属一并规划 |
| `public/admin/ui.js` | 仍是 303 行单文件（UI kit 未再细分） | 与屏幕拆分正交；真要拆应等后台多语言（L2）落地时一起做 |
| `extensions/contract/` | 目前只有 `hooks.ts`；`manifest.ts`/`validation.ts`/`capabilities.ts` 未拆 | 批次 3 |

这些**不是"可以随意违反规则"的许可证**——它们是**已登记的技术债**，
每一项都有明确的归属批次。新增类似问题时，登记到这里，不要静默放行。
