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
   ⚠️ 本机 `npm test` 会因沙箱锁住 node 二元文件而**整体报 SKIP（`EBUSY`）**——
   那不是测试失败。可靠做法是逐个 `node tests/<name>.test.mjs`。

## 改完代码后

3. 再跑一次全部套件与 `npx tsc --noEmit`，都必须绿。
4. 如果改了扩展的声明能力（主题清单 / 插件清单的字段），同步更新
   `tests/architecture.test.mjs` 与 `docs/ARCHITECTURE.md`。
5. 如果改了多语言（`src/platform/i18n/`、翻译组、主题自有表），跑
   `node tests/i18n.test.mjs`，并同步 `docs/ARCHITECTURE.md` §2.7 / §5.4①。
   **如果动了字段分类表（`PROSE_FIELD_TYPES` / `LANGUAGE_NEUTRAL_FIELD_TYPES`）
   或规则 41 的任一强制点，必须跑 `node tests/_i18n-field-inject.mjs`** ——
   它注入 6 个缺陷、断言每个都真的变红（含"断言注入确实生效"与"还原也验证"）。
6. 如果改了后台界面，跑 `node tests/admin-spa.test.mjs`，并跑一次真实浏览器验收
   `node tests/_i18n-browser.cjs` / `node tests/_admin-menus-browser.cjs`
   （需要另开 `npx wrangler dev --port 8787 --ip 127.0.0.1`）。
7. 如果改了 `src/rendering/template-engine.ts`、`src/extensions/contract/*`、
   或 `scripts/make-*.mjs`，跑 `node tests/scaffold.test.mjs`。它用**真实校验器**与
   **真实模板引擎**跑生成的骨架——**生成器的缺陷只有渲染一遍才会现形**（见下方规则 4）。
7b. **如果加了数据库表、改了表的租户/语言归属、或改了 `contract/schema.ts`**，跑
   `node tests/_schema-scope.mjs`（已进 `npm test`）。它把迁移流应用到**临时 SQLite**
   并驱动**真实 `syncThemeTables()`**，逐表检验声明与真实列一致。
   同时跑一次 `node tests/_tenant-query-audit.mjs`：新语句会打印为 `NEW`，
   **必须补一条书面裁决**（为什么不带 `site_id` 是安全的）。
7c. **如果改了 `contract/events.ts` 或插件的 `subscribes[]`**，跑
   `node tests/manifest-validation.test.mjs` 与 `node tests/architecture.test.mjs`
   （后者守 `DOMAIN_EVENTS` 的完整性、唯一性、payload 版本兜底，以及
   "事件名不得混进 hook 列表"）。
7d. **如果动了 `scripts/cfpress.sh` 或 `scripts/cfpress.ps1`（加动作、改菜单编号、
   改套件表）**，跑 `node tests/launcher-parity.test.mjs`。它要求两份文件
   **动作名、菜单编号、套件表、退出码**完全对齐，并且套件表要覆盖
   `package.json` 的 `test` 链（增删套件时两边都要改，它会告诉你漏了哪边）。
   ⚠️ 改 `cfpress.ps1` 后**必须确认 BOM 还在**（`head -c 3 scripts/cfpress.ps1 | xxd`
   应显示 `efbbbf`）——多数编辑器/写入工具会把它吃掉，而症状要到 Windows
   PowerShell 5.1 下才出现（中文变乱码），PS 7 与文本编辑器都看不出来。
8. **加了新的架构规则，必须同时做一次「反向验证」**：故意注入一次违规，
   确认测试真的会 FAIL，再撤回。**测不出失败的检查等于没有检查**——
   本仓库已经发生过**八种**（见下方「守卫失效记录」与「同一意图的两种写法」）。
   工具：`node tests/_skeleton-inject.mjs`（schema / 事件契约 / 断言拼法，11 个场景）、
   `node tests/_launcher-inject.mjs`（启动器两侧对齐 / BOM / stderr 提示 / EOF 退出，13 个场景）、
   `node tests/_eshop-inject.mjs`、`node tests/_i18n-field-inject.mjs`。
   ⚠️ 这四个工具**用 Worker 线程在进程内跑套件**——本沙箱 `spawnSync` 一律 `EBUSY`，
   用子进程会把"跑不起来"伪装成"没变红"。

**当前源码布局**（已重整完毕，新代码必须放对位置）：

```
src/
├── index.ts              前台路由      ← 唯一可以知道所有层的地方
├── api.ts                管理 API
├── shared/               叶子层：types crypto repo cache scheduler
├── rendering/            纯渲染：template-engine template-resolver blocks
├── platform/             auth permissions sites frontend seo revisions
│   ├── admin-menus.ts   ★ 后台菜单注册表（主题/插件/核心共用的唯一读写入口）
│   └── i18n/             多语言四层：core-pack translate resolve
│                         locale-registry packs index
└── extensions/
    ├── contract/         ★ 主题与插件共享的词汇与接口（依赖倒置的支点）
    │   ├── hooks.ts         HostHooks + DECLARABLE_HOOKS（宿主提供实现）
    │   ├── events.ts      ★ DOMAIN_EVENTS + EventEnvelope（事实，不是通道，规则 45）
    │   ├── schema.ts      ★ PLATFORM_SCHEMA：每张表的租户/语言归属（规则 43）
    │   ├── manifest.ts      词汇表：保留列 / 字段类型 / 后台屏幕 / 语言策略 / 各种正则
    │   ├── capabilities.ts  CAPABILITIES 白名单
    │   └── validation.ts    安装边界：validateManifest（失败必须抛错）
    ├── security.ts       只剩 safeZipPath / sha256（校验已移入 contract/）
    ├── theme/            runtime-declarative runtime-worker capabilities
    │                     templates tables table-facade packs
    └── plugin/           runtime packs menus

scripts/                  脚手架（生成器必须可被 import，见 tests/scaffold.test.mjs）
├── _scaffold.mjs         共用：parseArgs / writeTree / CliError / isMain
├── make-theme.mjs        themeFiles() 纯函数 + main(argv, io)
├── make-plugin.mjs       pluginFiles() 纯函数 + main(argv, io)
├── make-table.mjs        tableDeclarations() 纯函数 + main(argv, io)
├── cfpress.sh            ★ 启动/部署入口（POSIX sh）：数字菜单 + 命令模式
└── cfpress.ps1           ★ 同上，Windows PowerShell 5.1 版
```

**启动器两份文件是一个契约**：`cfpress.sh` 与 `cfpress.ps1` 承诺"同一套动作、同一套
菜单编号、同一套退出码"。`tests/launcher-parity.test.mjs` **解析**两份文件的
`case`/`switch` 分支与套件表再比对——不是 grep 子串。改任一侧都要改另一侧，
否则套件变红。（为什么必须解析结构：见下方「十种假绿」。）

launcher 侧已经踩过、并已写进测试的四条：
① **`.ps1` 必须有 UTF-8 BOM**——Windows PowerShell 5.1 把无 BOM 文件按 ANSI/GBK 读，
菜单里的中文在**解析期**就变乱码（PS 7 与文本编辑器都看不出来）。
② **`.ps1` 不得用 `$ErrorActionPreference = 'Stop'`**——PS 5.1 会把原生命令的每一行
stderr 包成 `NativeCommandError`，`Stop` 让它变**终止性**错误；本仓库每个套件都打
`ExperimentalWarning` 到 stderr，于是 launcher 跑第一个套件就死。
③ **菜单提示必须走 stderr**——`choice=$(menu_read ...)` 会把 stdout 一起捕进去，
提示写 stdout 时每个答案都变成 `"  > 9"`，**没有任何分支能匹配**（界面看着正常）。
④ **输入耗尽必须退出**——把 EOF 当"再问一次"会无限刷菜单（PS 版实测**一分钟 9.7 MB 日志**）。
`sh` 版读 stdin（管道可驱动），`ps1` 版在调 `Read-Host` **之前**用
`[Console]::IsInputRedirected -and -not [Console]::In.Peek()` 判断——事后无法区分
"没有控制台"和"用户按了回车"。

**`contract/manifest.ts` 为什么单独存在**：`tests/architecture.test.mjs` 需要**读**这些
词汇表（后台屏幕白名单、字段类型、保留列）。词汇表住在校验器内部时，唯一的检查办法
是**抄一份**，而抄本永远先过期。两个地方需要同一个答案时，共享定义，而不是共享结论。
同一理由把 `tests/_extension-rules.mjs` 抽了出来，供 `architecture.test.mjs` 与
`scaffold.test.mjs` 共用。

**脚手架必须可被 import**：本机沙箱**无法 spawn 任何子进程**（node 二元文件被锁，
`spawnSync` 一律 `EBUSY`，与 `tests/run-all.mjs` 报 SKIP 同因）。所以三个生成器都写成
`main(argv, io)` + 纯内容构造函数 + `isMain()` 守卫，`tests/scaffold.test.mjs` 直接调用。
只能以命令形式运行的生成器，等于**输出永远没被检查过的**生成器。

`platform/admin-menus.ts` 放在 `platform/` 而不是任一扩展里，理由是**两种扩展都要写它，
而它们互不 import（规则 3）**——放在任一侧都会逼出一次越界 import。
`platform/i18n/packs.ts` 的 `setPackProviders()` 与 `contract/hooks.ts` 的
`setHostHooks()` 是**同一个模式**：平台只认接口，实现在 boot 时由 `index.ts` 注入。
`platform/` 因此不需要认识 `extensions/`（分层规则 1）。

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

`tests/architecture.test.mjs` 自己出过**三次假绿**，都是「检查存在但从不触发」。
**全库累计十种**——`docs/ARCHITECTURE.md` §12 是完整表，这里列前三种：

| 检查 | 曾经的写法 | 为什么失效 | 现状 |
|---|---|---|---|
| `siteId` 默认值 | 只匹配 `= "default"` 字面量 | `siteId = DEFAULT_SITE_ID` 完全匹配不到，6 处长期漏网 | 已同时匹配字符串与常量，并锚定到参数列表 |
| 主题/插件互不 import | `spec.includes("/extensions/plugin/")` | 真实写法是 `"../plugin/runtime"`，**不含 `/extensions/`** | 已改为按文件目录**解析路径**再比较 |
| 语言包 key 前缀 | 检查存在，但所有 `langs/` 目录都是空的 | **对空集合的检查是空转**——直到批次 2 才第一次有真文件 | `themes/aurora/langs/*.json` 已落地并反向验证过 |

**教训**：文本匹配容易被"同一意图的另一种写法"绕过（前两行），
而**对空集合的检查等于没有检查**（第三行）。凡是要守卫结构，就解析结构
（路径、AST、类型），别匹配字符串；凡是守卫集合，先确认集合非空。
**每次新增守卫，都要注入一次违规确认它会红。**

### 反向验证本身也会假绿：fixture 必须只有一处差异

批次 3 发现第四种失败，**不在被守卫的代码里，而在验证用的 fixture 里**：

> 为 `clearOwnerMenus` 写的"归属隔离"用例，原本拿**主题 owner** 对**插件 owner**。
> 于是把 `WHERE` 里的 `owner_name` 整条删掉，测试**依然全绿**——因为两个 fixture 的
> `owner_type` 本来就不同，`owner_name` 在这一次比较里是多余的。

**规则**：反向验证时，被删掉的那一半必须是**唯一区分 fixture 的那一项**。
写用例时先问一句「我把这一条删了，哪个断言会变红」——答不上来就说明 fixture 没设对。
（修正后：再加一个**同类型**的第二个 owner，注入后产生 3 个 FAIL。）

### 第五种假绿：断言描述的是上一轮的产物（清理失败被吞掉）

批次 4 在 `tests/scaffold.test.mjs` 上踩到，**不在被测代码里，也不在 fixture 里，
而在"测试到底在看哪个文件"上**：

> 套件开头 `rmSync(SCRATCH, { recursive: true, force: true })`。Windows 上这一步会因
> `EBUSY` 失败，而 `force: true` **把错误吞掉**。生成器又刻意拒绝覆盖已存在的文件，
> 于是残留的旧文件全部存活——整套断言描述的是**这一次根本没有写出来的内容**。
> 症状极具误导性：套件全绿，而把缺陷注入生成器之后，红的是"另一件事"。

**规则**：**清理之后要验证清理成功**（`if (existsSync(dir)) throw new Error(...)`）。
凡是"先清空再生成"的套件，都必须能区分"这次生成的"与"上次剩下的"。

同源的第二条，关于**注入脚本自己**：

> 第一次注入脚本打印 `closers removed: 2 -> 2` —— 它什么都没改，
> 而我把随后出现的红色当成了证据。那次"反向验证"证明的不是我想证明的东西。

**规则**：注入后必须断言"目标确实从 N 变成 M"（`if (left !== 0) throw`），
恢复后同样断言。**不能证明自己注入成功的注入，不是注入。**

### 第六种假绿：没有摘要行的一跑，被当成了通过

批次 4 写 `themes/eshop/` 的反向验证时踩到，**不在被测代码里，不在 fixture 里，
也不在"看哪个文件"上，而在"我怎么读测试结果"上**：

> 套件的摘要在 `main()` 末尾打印。模板渲染一旦抛错（未闭合的 `{{/section}}`
> 会让引擎直接抛），控制流跳出，**`N passed, M failed` 这一行永远不会打印**。
> 我的校验脚本用 `grep '^[0-9]+ passed'` 读结果——匹配不到就什么也不输出，
> 而我把"没有输出"读成了"没有失败"。**同一次会话里犯了两次。**

**规则**：**没有摘要 = 失败**。一跑的产出必须能自证它跑完了；`grep` 匹配不到，
是"我不知道"，不是"它没事"。两层都要修：

1. **套件侧**：摘要抽成 `summary()`，`catch` 分支里也调用，并把异常计为一条失败。
   任何一跑都必然有摘要行，崩溃标注 `(aborted)`。
   ⚠️ `tests/theme-aurora.test.mjs` 原本只打印 `${failed} failure(s)`、**没有 passed 计数**，
   已统一。**摘要格式不一致，脚本就分不清"绿"和"崩"。**
2. **校验脚本侧**：`grep -qE '^[0-9]+ passed, [0-9]+ failed'` 失败即 `exit 1`。

### 反向验证工具自身的两个陷阱（都在批次 4 踩到）

| 陷阱 | 症状 | 修法 |
|---|---|---|
| **字节数守卫看不见等长替换** | `"/shop/"` → `"/blog/"` 长度完全相同，守卫打印"什么都没改"，而注入**其实生效了** —— 防假阴的工具自己产出假阴 | 比**内容哈希**，不比长度 |
| **快照取自脏树** | `git checkout -- <path>` **修不了 git 从没见过的文件**（新主题是 untracked），还原静默失败 → 场景逐层叠加；更糟的是脏状态被**拍进快照**，"还原"忠实还原了损坏，套件连续七轮红在**没有任何场景引入过**的缺陷上 | 不用 `git checkout`：快照前 `assertPristine()`，还原后**再** `assertPristine()`。**还原也要被验证** |

参考实现：`tests/_eshop-inject.mjs`（7 个场景，每个都断言"确实注入了"→"红在哪一条"→"还原成功"）。
它**不进 `npm test`** —— 它是工具，跟 `_i18n-browser.cjs` 同一性质。

### 第七种假绿：守卫守的是「写法」，不是「语义」

`architecture.test.mjs` 的 `siteId` 零容忍检查出过**第四次失效**，形态与前三次同源但更隐蔽：

> 它匹配 `siteId = "default"`（参数默认值），**匹配不到 `o.siteId ?? "default"`**。
> 于是 v0.7.1 审查时发现 `??`/`||` 形式的兜底又悄悄长回来了——
> **问题没被消灭，只是从 `=` 被挤进了 `??`**。

同类，**本次新增守卫时自己又踩了两次**（都是"守卫本身不生效"）：

| 症状 | 原因 | 修法 |
|---|---|---|
| 新写的兜底正则对 `o.siteId ?? "default"` **不匹配** | `\b` 在 `"default"` 的 **尾引号后**不成立（`\b` 要求两侧一为词字符），`(?:"default")\b` 恒假 | 去掉尾 `\b`；**逐写法实测**，不靠推断 |
| 豁免范围元守卫**注入后不变红** | 它只统计"既带标记、又有违规"的文件 → 第二个文件**没有违规就能白拿豁免** | 统计**标记本身**，不统计"标记有没有起作用" |

**规则**：① 守卫要覆盖**同一意图的每一种写法**（`=`、`??`、`||`、三元），
新增一条就用一批真实样例**逐条实测**它命中；② 守卫**自身的守门逻辑**也要反向验证，
**一个"只在没违规时才通过"的检查，看不见自己的范围失控**。

### 第八种假绿：断言**拼法**让它不可能失败

批次 6 新增 schema / 事件契约守卫时，本文件的格式被抄了一遍：

```js
check("no domain event is declared twice", dupes, []);   // ← 不可能失败
```

`check(name, condition, detail)` 测的是 **真值**，而**空数组恒为真**。
于是七条新守卫**全部无法失败**——注入一个重复的 `MediaUploaded` 到 `DOMAIN_EVENTS`，
磁盘上确实是两份，测试**依然 40/40 全绿**。这是唯一一次假绿发生在**守卫自己内部**。

**修法两层**：

1. `checkEmpty(name, offenders)` —— 意图可表达，不必在每处重复 `len === 0`；
2. **元守卫**扫本文件，禁止 `check(<字符串>, <任意表达式>, [])` 这种拼法，并断言
   扫描到的 `check*` 调用数 **> 20**（否则扫一个空文件也"通过"）。

> 第一版元守卫只匹配**裸标识符**（`check("x", someList, [])`），
> 结果两条条件写成 `.filter(...)` 的假绿调用溜过去了。**守卫的守卫也要覆盖每种写法**
> ——这正是第七种的教训，隔一节又犯了一次。

### 反向验证工具自身的三条铁律（`tests/_skeleton-inject.mjs`、`_launcher-inject.mjs`）

本轮把 11 个场景全部跑通了，途中工具自己假绿过三次：

| 坑 | 症状 | 修法 |
|---|---|---|
| **量字节数看不见等长替换** | `"site"`→`"sote"` 长度相同 → 守卫打印"什么都没改"，而注入**其实生效了** | 比**内容哈希**（SHA-256） |
| **快照取自脏树** | 还原失败（`git checkout` 修不了 untracked 文件）→ 场景逐层叠加；脏状态被拍进快照 → "还原"忠实还原了损坏，**连续几轮红在没人引入过的缺陷上** | 快照前 `assertPristine()`，还原后**再**跑一次——**还原也要被验证** |
| **用子进程跑套件** | 本沙箱 `spawnSync` 一律 `EBUSY` → 每个场景报"没有摘要"，**"跑不起来"伪装成"没变红"** | 改用 **Worker 线程**（同进程，无需二元文件）。⚠️ 从 ESM 父进程 `eval` 出的 worker 里 `require` **未定义** → 必须用 `import()` |

第 2、3 条合起来的后果很值得记：**一次未还原的注入，会让后续所有场景的结论作废**，
而 `assertPristine` 之所以没拦住，是因为它的基准快照本身取自已经脏掉的树。**先修树，再快照。**

### 第九种假绿：守卫被**另一半**满足（`_launcher-inject.mjs` 第 5 场景）

写启动器对齐检查时，`deploy` 守卫的断言是"`Test-DeployPrecheck` 在定义体之外出现过一次"。
注入时只删掉了 `Invoke-Deploy` 里的那一次调用，`Invoke-DeployFull` 里的**另一处调用**
继续满足断言 → **套件全绿，而部署路径已经不再检查占位符**。

**规则**：断言"某函数被调用"时，要问一句"它有几个调用点"。
**每个调用点各写一条断言**（现在是 `(Invoke-Deploy)` 与 `(Invoke-DeployFull)` 两条），
并且**按函数体切出来单独检查**，不要在整个文件的文本里搜。
这跟第七种（`resetPluginRuntime` 只测了一个 sink）是同一个病，
跟「fixture 只有一处差异」是同一条反向推理。

### 第十种假绿：**期望值写反了**，于是"红得不对"被读成"没红"（同工具第 3、9 场景）

`checkEmpty("no suite name is listed only by .sh", onlySh)` —— 从 `.ps1` 里删掉一个套件时，
这个断言**正确地红了**（`.sh` 有、`.ps1` 没有 = "只有 .sh 列出"）。
但我在场景里把 `expect` 写成了 `... only by .ps1`，工具于是报
`<- went red, but not where expected`，我第一反应是"套件有 bug"，差点去改**对的代码**。

**规则**：出现"红了但不是这一条"时，先怀疑**期望值**，再怀疑代码。
断言名里的方向词（only by X / missing from X / left / right）要**照着集合差集的定义读一遍**
再写进场景。顺带：工具必须把**实际红了哪几条**打印出来（`[…|…]`），
否则"红得不对"和"没红"在输出上无法区分。同一次会话里，第 9 场景也是同一个错误。

### 合法豁免要写在源码里，不要写在测试里

`resolveSite()` 确实需要兜底（请求总得属于某个站点）。用 `?? DEFAULT_SITE_ID`
写在测试里当例外清单，读者在 `sites.ts` 里看不到它为什么合法。
改为标记 `// ARCH-RULE-EXEMPT: site-default` 放在该行上方，**全库只允许一处并计数守卫**。
好处是不豁免集合看不见：标记在源码、计数在测试，两边都要动才能扩大范围。

## 多语言（§10 规则 5、7、8）

| # | 规则 |
|---|---|
| 10 | 回退顺序恒为：当前语言 → 站点默认语言 → 空。**不抛错** |
| 11 | 语言包 key 必须带前缀：`core.` / `theme.{name}.` / `plugin.{name}.` |
| 12 | **界面语言**（后台菜单）与**内容语言**（前台文章）是两件事，不得混用 |
| 13 | 显式语言的 URL（`/en/x`）找不到时返回 404，**不回退到别的语言** |
| 13b | `lang_group` 可空，**「没有它就是自己」这条规则必须只写一次**：JS 用 `groupOf()`，SQL 用 `GROUP_SQL`（`src/api.ts`），两处共用同一个定义 |
| 13c | 语言开关（启用/停用/加语言/改默认）改动后**必须刷新后台上下文**（`loadContext()`），否则编辑器的语言版本条会整条不渲染 |
| 13d | 扩展菜单的 `label_key` 必须带 owner 前缀（`theme.{name}.` / `plugin.{name}.`，规则 11 的延伸——`validateAdminMenus` 用 ownerName 构造正则拒绝越界 key）。**菜单标签的翻译发生在服务端**（`admin-menus` GET 命中字典即替换 `label`），SPA 不做二次翻译 |
| 41 | **所有数据都必须有多语言能力，不是可选项**。表字段按承载内容分两类，分类表是 `contract/manifest.ts` 的 `PROSE_FIELD_TYPES` / `LANGUAGE_NEUTRAL_FIELD_TYPES`，`isProseFieldType()` 是唯一谓词：散文（`text`/`longtext`）**必须**在 `translatable`，语言中立（`number`/`boolean`/`date`/`datetime`）**必须不在**。两个方向都在安装边界、架构测试、脚手架默认值三处强制 |
| 42 | 主题/插件表**必须显式声明语言结构** `tables[].language{strategy,translatable,fallback,requiredLocales}`。`strategy` ∈ `none`/`sidecar`（`versioned` 声明了但**未实现 → 校验器拒绝，不是忽略**）。`strategy:"none"` 而表里有散文 = **断言为假，拒绝**；`language.translatable` 与扁平 `translatable` 不一致 = **两个权威，拒绝**；`fallback`/`requiredLocales` 里的非法 locale 码拒绝 |
| 43 | 平台 schema 的租户/语言归属**只有一份声明**：`contract/schema.ts` 的 `PLATFORM_SCHEMA`。`TENANT_TABLES` / `PLATFORM_TABLES` / `DERIVED_TENANT_TABLES` / `LOCALE_COLUMN_TABLES` **全部派生自它，不得手写**。每一条必须写 `note`（≥10 字）说明理由，派生租户（`derivedTenant`）必须写明 FK 路径（`post_id → posts.site_id`） |
| 44 | schema 声明**必须被真实数据库检验**（`tests/_schema-scope.mjs`，进了 `npm test`）：数据库里的表没被分类 = 红；租户表没有 `site_id` = 红；平台表**有** `site_id` = 红；`_i18n` 边车**有** `site_id` = 红。它跑在**临时 SQLite**（迁移流）上而非 `.wrangler/`，并**驱动真实的 `syncThemeTables()`** 造出生成表——否则那些断言全是空转 |
| 45 | 领域事件是**独立于 hook 的契约**（`contract/events.ts`）：**事件是事实**（过去式 + `payloadVersion` + 必带 `siteId`，分语言的事实带 `locale`），**hook 是通道**。`DOMAIN_EVENTS` 与 `DECLARABLE_HOOKS` **不得互相掺入**（hooks 里出现事件名 = 红）。插件的 `subscribes[]` 在**安装边界**对照 `DOMAIN_EVENTS` 校验——**订阅一个不存在的事件名是 400，不是"永远不触发的 hook"** |
| 46 | 表有租户字段 **≠** 查询用了它。`tests/_tenant-query-audit.mjs` 列出所有触碰租户表却不带 `site_id` 的语句；**每一处都必须有书面裁决**（`REVIEWED` 表）。没有裁决的新语句打印为 `NEW`。它是报告工具，**不进 `npm test`** |
| 47 | 平台表（`theme_installs` 等）上的跨站聚合是**设计不是泄漏**：`active` 的含义就是"有站点在用它"。判断是否泄漏看**声明**（`schema.ts` 的 `tenant`），**不看表名前缀**——`theme_installs` 匹配 `theme_*` 但它是平台表 |

规则 42 的后果：`strategy` 不是文档装饰。写 `"versioned"` 会**装不进去**而不是静默降级——
把一个存在但不可用的选项留在白名单里，等于承诺了没实现的能力。

规则 43 的后果：`theme_installs` / `theme_settings` / `plugin_installs` / `plugin_settings`
都匹配 `^(?:theme|plugin)_` 前缀，但它们是**平台注册表**、设计上**没有** `site_id`。
所以判别器是 `isGeneratedBusinessTable()`（先查声明），**不是那个正则**——
首次运行 `_schema-scope.mjs` 就在这 6 张表上假红过。

规则 45 的后果：`DOMAIN_EVENTS`（21 个）与 `DECLARABLE_HOOKS`（7 个）**数量不同是正常的**，
因为问题不同——"有几个可挂载的通道" ≠ "有几件值得知道的事"。

### 越界不变量：查询级（规则 46、47）

表声明守的是**形状**，规则 46 守的是**用法**。一条语句可以完全合法地写出来，
却装着"跨站读别人的行"：

规则 11 的后果：`themes/aurora/langs/zh-CN.json` 里写 `"nav.home"` 会让测试失败，
必须写 `"theme.aurora.nav.home"`。**这不是风格要求**——两个扩展都定义 `nav.home`
时，谁生效取决于加载顺序，且没有正确的修复位置。

规则 13b 的后果：只写 `WHERE p.lang_group = ?` 会**排除掉组名所指的那一行自己**
（它的 `lang_group` 是 NULL），于是组看起来是空的，编辑器报告语言缺失并诱导用户
**再建一个已经存在的语言的副本**——不报错，只是悄悄多出一份内容。
守卫在 `tests/i18n.test.mjs` 第 9b 段，两处调用点都反向验证过。

规则 13c 的后果：`state.locales` 是缓存，语言开关是它的事实源。改了开关不刷新缓存，
`loadVersions()` 会以为站点是单语言的，于是**整个语言版本条不渲染**——
屏幕上没有任何东西是红的，因为"少一块"不会报错。

### 规则 41：为什么必须"强制"而不是"支持"

多语言能力曾经是**可选**的：`tables[].translatable` 写了就生效，不写就静默退化为单语言。
缺了它，**安装成功、单语言下渲染完全正确**，直到启用第二种语言才暴露——
那时修复成本已经是「迁移 + 重译」。这就是「声明先于运行时」缺陷族的又一员：
**校验器问的是「已声明的字段分对类了吗」，从不问「字段声明了吗」。**

三个消费者共用一处分类，**不得各自重写**（规则 23 精神）：

| 层 | 位置 | 作用 |
|---|---|---|
| 安装边界 | `contract/validation.ts` | 第三方 zip 装不进来——架构测试**永远看不到**还没落盘的扩展 |
| 架构测试 | `tests/architecture.test.mjs` | 已发布主题当场变红，报错指名 `file:table:field` |
| 脚手架 | `scripts/make-table.mjs` | 新主题天生合规——生成器不守规则，规则第一天就漏 |

**为什么 B 方向（语言中立不得声明）不是多余的**：把 `price` 标成可翻译
等于**每种语言一个价格**——数据模型错误，但不会崩。**「不报错」和「正确」是两件事。**

**为什么分类表本身也要被守**：规则 41 若只跑已发布主题，新增第七种字段类型时会
全绿通过（集合里没人用它）。`tests/architecture.test.mjs` 因此额外断言：
两表不重叠 / 每个允许类型都被分类 / 无幽灵类型 / **扫到的表数 > 0**。
最后一条是关键——把 `themes/` 改名会让「所有主题都合规」**恒真**。
**对空集合的检查是空转**（本仓库第三种假绿）。

**标识符不是散文**：SKU、券码、外部 id 必须用 `number`/中性类型，不要用 `text`。
用 `text` 等于宣称「这段文字值得翻译」。`tests/i18n.test.mjs` 的夹具原本就把 `sku`
写成 `text` 却在注释里说它跨语言共享——**规则抓出了这个自相矛盾的建模**。

反向验证：`node tests/_i18n-field-inject.mjs`（6 场景，工具不进 `npm test`）。
清点剩余数据承载类：`node tests/_i18n-data-inventory.mjs`。

> **`settings[]` 为什么不加语言维度**：`theme_settings` 键为 `(theme_name, key)`，
> 且**前台没有任何读取路径**（`grep` 过 `rendering/`、`runtime-*.ts`、`public/admin/`，
> 只有后台 `theme-settings` 屏读它）。它是**配置**不是内容。加一个没人读的字段，
> 正是本轮要消灭的「声明先于运行时」缺陷。**结论记录在案，字段不加。**

## 主题 / 插件清单（§5.3）

| # | 规则 |
|---|---|
| 14 | 声明的 `templates[]` 必须真的存在对应文件（`runtime: "worker"` 的主题豁免） |
| 15 | `routes[].resolve.table` 必须已在 `tables[]` 里声明 |
| 16 | `tables[].translatable` 里的 key 必须是该表声明过的字段 |
| 17 | 表的字段名不得与保留列冲突：`id`/`site_id`/`slug`/`lang_group`/`status`/`created_at`/`updated_at` |
| 18 | `runtime: "worker"` 的主题必须真的提供 `entry` 指向的文件 |
| 19 | `blocks[].name` 是**纯标识符、不带斜杠**（`property-card` ✅ / `theme/property-card` ❌）。`core/` 前缀是平台内置专用的 |
| 20 | 内联语言包 `langs{}`：locale 必须是合法代码、value 必须是字符串、key 必须带 `theme.{name}.` / `plugin.{name}.` / `core.` 前缀 |
| 21 | `routes[].template` 必须**在 `templates[]` 里**、且对应文件真的存在（`runtime: "worker"` 豁免）。渲染器按名字优先选中它 |
| 22 | `routes[].resolve` 必须**恰好**声明 `type` 或 `table` **之一**——两个都写抛错，一个都不写也抛错 |
| 23 | `routes[].resolve.by` 只能是 `"slug"` 或 `"id"` |
| 24 | `routes[].query.as` 必须是合法的**模板作用域名**（`SCOPE_NAME_RE` = `[A-Za-z_$][A-Za-z0-9_$]*`），**不能带连字符** |

**理由**：清单是主题唯一能出错的地方，那就在这里出错。放行会变成渲染期的报错，
而那个报错会指向渲染器，不指向清单——排查成本高一个数量级。

**规则 20 为什么存在**：`uploadExtension` 把插件包当 zip 原样存进 R2、**从不解包**，
所以插件没有 `langs/` 目录可读，只能把语言包内联在清单里。主题有目录
（`themes/<name>/langs/<locale>.json`，运行时从 R2 读）。两条路径，同一套前缀规则。

**规则 21–24 的共同教训**：这四条对应的四个字段，曾经都是「**声明被校验了、但运行时没人读**」。
校验器认它、架构测试认它，前台却按 `kind` 猜模板、按 `postType` 猜内容，
于是**页面返回 200 而内容是错的**——最贵的一类 bug。判据是：
**一个字段被写进校验器还不够，必须找到它的消费点**；找不到就别加这个字段。

**规则 24 为什么不能用连字符**：`query.as` 会成为模板里的作用域变量名，而表达式分词器
按 `[A-Za-z_$][A-Za-z0-9_$]*` 切标识符。`my-list` 是合法 JS 属性名，但在模板里
`{{#each my-list}}` 会被解析成 `my` 减 `list`，而引擎**没有算术运算符**。
放行等于给出一个**谁都读不到**的绑定。

**校验失败必须抛出、必须让安装失败**，不能警告后继续。写法是 `validateManifest` 抛
`Error`，`src/api.ts` 的 `uploadExtension()` 捕获后返回 400。一个装不上的主题
胜过半个能跑的主题。规则 14–24 每一条都在 `tests/manifest-validation.test.mjs` 里
有对应的"注入缺陷 → 断言必须抛错"用例；改校验逻辑时那道套件必须跟着改。

---

## 模板语言：写主题前必须知道的五条

**这五条都会让整页渲染抛错、或静默走错分支，而且没有编译期提示。**
`scripts/make-theme.mjs` 生成的骨架把这五条都演示了一遍，`tests/scaffold.test.mjs`
用**真实引擎**把它们逐条钉住。

| # | 规则 | 写错的症状 |
|---|---|---|
| 1 | helper 用 `f(a, b)` **调用**：`{{len(posts)}}` ✅ / `{{len posts}}` ❌ | 抛 `Trailing tokens` → **整页降级成空白壳层** |
| 2 | **不支持 `../`**。`{{#each}}` 内部是 `Object.create(scope)`，父级变量**按名字直接可见** | 取到 `undefined`，静默 |
| 3 | `@first` / `@last` / `@index` 绑在**迭代作用域**，不在 item 上。裸写 `{{#if @first}}` | 分支**永不渲染**，静默 |
| 4 | **`{{/section}}` 是必须的**（见下） | 子模板的 section 被误判成 slot → 布局渲染空 `<main>`，**HTTP 200、无异常** |
| 5 | `@extends` 的插槽是 `{{@section "content"}}`，**不是** `{{@block}}` | 内容不出现，静默 |

helper 只有 9 个：`len` / `default` / `lower` / `upper` / `truncate` / `join` / `number` / `date` / `contains`
（外加指令 `@extends` / `@section` / `@include` / `@query`）。
支持 `{{#if}}`/`{{#unless}}`/`{{#each … as x}}`/`{{! 注释 }}`、`===`/`!==`/`&&`/`||`/`>`/`<`。
**没有算术运算符。**

### 规则 4 详解：为什么 `{{/section}}` 不能省

引擎要区分一个 `{{@section "x"}}` 是**定义**（子模板，有 body）还是**插槽**（布局，无 body）。
判据是**向后扫描有没有配对的 `{{/section}}`**。所以：

- 布局 `parts/layout.html` 里的 `{{@section "content"}}` **故意不闭合** —— 它是插槽。
- 子模板里**必须闭合**。不闭合时它被当成插槽，不进 `@sections`，布局渲染空内容。

这个猜测有一个**可以证明**的错法，所以引擎现在直接拒绝它：**一个 `@extends` 了的文件
是子模板，子模板永远不提供插槽**。于是"既 `@extends` 又有未闭合 section"不再是猜测，
而是**结构性错误**，`parseTemplate` 抛
`Template @extends "…" but leaves section(s) unclosed: …`。
判据是文件事实（`extendsName` 是解析结果），不是文本匹配——这正是本仓库反复强调的做法。

> 批次 4 的骨架**真的漏了这四个 `{{/section}}`**，`tests/scaffold.test.mjs` 才发现的。
> 症状就是上面那行：200、无异常、空白页。**只有真正渲染一遍才会暴露。**

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
js/table-form.js       ★ 字段类型 → 控件 的唯一映射 + 值往返（date/datetime 转换）
js/screens/index.js    页名 → 屏幕 注册表（唯一 import 全部屏幕的模块）
js/screens/<name>.js   一屏一模块
```

| # | 规则 |
|---|---|
| 21 | `js/shell.js` **不得 import 任何屏幕**（屏幕经 `setScreenTable()` 自注册），否则立即成环 |
| 22 | 屏幕之间**不得互相 import**；共用逻辑抽独立模块（如 `extension-install.js`） |
| 23 | 每个被 markup 调用的处理器**必须登记进入口的 `WINDOW_HANDLERS`** |
| 24 | 不得引入打包器；不得删 `index.html` `<head>` 里的绘制前主题脚本 |

**理由（规则 21–22）**：屏幕要调 `render()`，`render()` 要调屏幕——直接互相
import 就是环。环在部分浏览器能跑、部分不能，且让"改一个屏幕"重新变成
"必须理解全部屏幕"。自注册把这条边反转成单向。

**理由（规则 23）**：markup 用内联 `onclick="name(...)"`，浏览器把它解析在
`window` 上、**不在模块作用域**。少登记一个**不会有任何报错**——
不编译、不报 console、不发失败请求，按钮就是点了没反应。这是最贵的一类回归。

> 新代码优先用 `data-action` + document 级委托，这样根本不产生新的
> `WINDOW_HANDLERS` 条目（`screens/languages.js` 就是这么做的）。

规则 21–24 由 `tests/admin-spa.test.mjs` 强制（模块图无环 + 无孤儿模块 +
`window.*` 契约 + 每个屏幕真渲染一次）。**改后台结构时那道套件必须跟着改。**

> ⚠️ 该套件有一处**已修过的假绿**：它最初断言"`render()` 没有抛错"，
> 而 `render()` 自己 catch 住屏幕异常并换成 "Something went wrong" 面板，
> 于是注入一个未定义标识符后测试依然全绿。现在断言的是**写进 DOM 的内容**
> （非空、不含错误面板）。**别把它改回"断言没抛错"。**

---

## 主题自有表（§6.3）

| # | 规则 |
|---|---|
| 25 | 表名**只由平台拼**（`theme_{theme}_{table}`）。主题清单里写逻辑名（`product`），**不得出现物理表名** |
| 26 | `{table}_i18n` **只在站点服务 ≥2 种语言时创建**；语言被停用后**永不清回、永不 drop** |
| 27 | 主表字段用 `ALTER TABLE ADD COLUMN` 增量补，**从不删列** |
| 28 | `theme_table_defs` 记录 `逻辑名 → 物理表名` 映射，**切主题时不清**（清了数据就没入口了） |
| 29 | 主题只能读**自己**声明过的表：`resolveThemeTable()` 按 `theme_name` 过滤 |

**理由（规则 26）**：把 `_i18n` 表当成"多语言才有的东西"，好处是「我们不做多语言」
变成**数据库里可验证的事实**，而不是代码里的承诺。反过来，语言停用时删表就是
WordPress 那个坑——用户关掉一个语言，翻译就没了。**只隐藏，不删除。**

**理由（规则 28）**：物理表名如果每次都从清单现推，那么主题一旦停用、清单没了，
那些数据就永远找不到入口。所以映射要记在平台自己的表里。

> 单语言站点上，可翻译字段**仍然存在主表上**——否则单语言站连产品名都存不了。
> 主表那一列同时充当**默认语言的值**，所以启用第二种语言**不需要数据迁移**。

---

## 一条反复踩到的坑：同一意图的两种写法

本仓库已经**三次**因为"同一个概念有两处表达"而出现假绿或静默错误：

| 概念 | 写法 A | 写法 B | 后果 |
|---|---|---|---|
| 默认站点 | `siteId = "default"` | `siteId = DEFAULT_SITE_ID` | 守卫只匹配 A，6 处漏网 |
| 跨层依赖 | `spec.includes("/extensions/plugin/")` | `"../plugin/runtime"` | 守卫从不触发 |
| 翻译组 | JS `lang_group ?? id` | SQL `lang_group = ?` | 组里丢了组名所指的那一行，编辑器诱导建重复内容 |

**规则（30）**：凡是一个概念需要在两处表达（JS ↔ SQL、字符串 ↔ 常量、路径 ↔ 正则），
**让两处共用同一个定义**，不要各写一份"看起来等价"的版本。`src/api.ts` 的
`GROUP_SQL` + `groupOf()` 就是范例：SQL 片段是常量，JS 函数在它旁边，
注释里写明两者必须同步。

**规则（31）**：新增守卫后，**必须注入一次违规确认它会红**。已经发生过两次
「检查存在但从不触发」——**守不住东西的守卫比没有守卫更糟，因为它是被信任的**。

---

## 后台菜单注册表与生成式屏幕（§3.5 / §4.4 / §6.1）

| # | 规则 |
|---|---|
| 32 | 后台菜单**只有一个来源**：`admin_menu_registry`。`theme_admin_menus` 已退役——`src/` 与 0012 之后的迁移**不得再引用它**（架构测试会扫，比对前剥注释） |
| 33 | 菜单必须带**归属**：`owner_type` + `owner_name`。「停用插件只消失它自己的菜单」是这个 `WHERE` 子句的直接结果，**不是特例逻辑** |
| 34 | 主题菜单**按站点**（主题是按站点激活的）；插件菜单**只写一次 `site_id = '*'`**，读时匹配 `site_id = ? OR site_id = '*'` |
| 35 | 后台页名用**三个前缀**：`table:<t>`（列表）/ `table-new:<t>`（新建）/ `table-edit:<t>:<slug>`（编辑）。**不得合并成一个带可选后缀的前缀** |
| 36 | `table-list` / `table-edit` 的列表列与表单控件**必须由 `tables[].fields[]` 生成**；主题不得手写后台表单 |
| 37 | 插件清单**不得声明 `tables[]`**（校验器直接拒绝，不是忽略），也**不得使用 `table-list` / `table-edit`** screen |
| 38 | 菜单显示分**两层**：① **站点级定制**（改名/排序/跨组移动/对所有人隐藏）存 `settings` 的 `admin.menu.custom`（每站一份 JSON），PUT/DELETE 需 `settings.manage`，GET 任何登录用户可读；② **每用户隐藏**存 `site_users.menu_prefs`（UI 层）。两者都**只影响侧边栏渲染**——capability 过滤仍在各端点，藏菜单不授/撤任何权限。`dashboard` 永远显示（逃生门） |
| 39 | 站点菜单定制的**唯一应用点是 `nav.js` 的 `applyMenuCustom()`**（纯函数；侧栏与编辑器共用，别写第二份应用逻辑）。改名覆盖叠加在服务端 label_key 翻译**之上**（解析：override[locale] → override.en → 内置文案）；排序是**稳定排序**（显式 order 升序在前，未排序的按内置顺序殿后）；**移动到不存在的分组=忽略**（项留在原地，绝不丢弃）；结构性变更（排序/移动）必须**物化整组显式 order**，否则隐式/显式混排没法读。标签输入**change（失焦）即保存**，Enter 提交——`fill()` 类工具只派发 `input` 不派发 `change`，自动化测试 fill 后必须 blur |
| 40 | 后台**界面语言列表是数据驱动的**，宇宙 = 内置核心包（`CORE_PACKS`，保证完整）∪ 平台语言字典 enabled 项（`locales`）∪ 覆盖层出现过的 locale（`i18n_overrides`）。**唯一定义是 `packs.ts` 的 `availableUiLocaleEntries()`**：它既生成切换列表（`i18n/messages` 的 `ui_locales`），也投影成 `ui-locale` 的校验集（`availableUiLocales`）——切换器提供的与服务器接受的永远不会不一致。**加语言在 Languages 屏完成，零代码**；没有翻译的 key 由 SPA `t()` 的英文 fallback 兜底，翻译通过覆盖层补。内置包的名字在 `CORE_PACK_NAMES`（与 `CORE_PACKS` 同文件相邻）。客户端只从 `ui_locales` 派生（`i18n.js setUiLanguages()`，en 恒第一），**不得在任何一侧硬编码语言清单**。菜单 label 语言数上限 `LABEL_MAX_LOCALES`(8) |

**理由（规则 34）**：插件只有一个**安装级** `enabled` 标志，主题是**按站点**激活的。
所以插件菜单写一次 `site_id='*'`、读时用 `OR` 匹配；按站点扇出会需要"新建站点时补菜单"
的钩子，而那个钩子**目前不存在**——少了它，新建的站点会静默地没有任何插件菜单，
而且没有任何报错。用一个 `OR` 换掉一个不存在的钩子，是这笔交易里唯一划算的一侧。

**理由（规则 35）**：这一条是**真实浏览器验收**抓出来的产品缺陷。页名曾经是
`table:<t>[:<slug>]`，"列表"和"新建"因此是**同一个页名**：点 Add 时路由判断"我已经在
这个页面上了"→ 不重渲染 → **按钮看起来完全没反应**（无报错、无失败请求）。
单元测试看不见它，因为两边的 DOM 都能单独渲染出来。

**理由（规则 32–33）**：注册表把"谁声明的"变成数据，而不是调用顺序。合并前，
主题菜单和插件菜单是两张表、两套读取路径，"插件也能注册菜单"要靠特例代码实现；
合并后它只是 `owner_type` 的一个取值。

**反向验证要求**：规则 33 的用例必须包含**同类型的两个 owner**。只拿"主题 owner vs
插件 owner"对比是**假绿**——删掉 `owner_name` 依然通过（见上「反向验证本身也会假绿」）。

---

## 允许做的事

- ✅ 加新的 `screen` 类型（同时更新 `ALLOWED_ADMIN_SCREENS`、`docs/ARCHITECTURE.md` §3.5，
  以及 `tests/architecture.test.mjs` 里**钉住**的那个集合——三者必须一致）
- ✅ 加新的 capability（同时更新 `CAPABILITIES` 与 §4.3）
- ✅ 加新的 `DECLARABLE_HOOKS`（同时更新 §4.2）
- ✅ 加新的后台菜单 screen 实现（`public/admin/js/screens/`，须在 `screens/index.js` 注册）
- ✅ 重构实现，只要不跨越上面的规则

## 明确不做的事

- ❌ 往 `platform/` 里 import 某个具体主题
- ❌ 在主题里写 `env.DB.prepare(…)`
- ❌ 让 `extensions/theme/` import `extensions/plugin/`（走 `contract/hooks.ts`）
- ❌ 给数据访问函数补一个"方便的" `siteId = "default"` 默认值（**常量形式也不行**）
- ❌ 在主题/插件里自己写鉴权（`jwt.verify` / 检查 `role`）
- ❌ 手写后台表单（应由 `fields[]` 声明生成）
- ❌ 主题切换时删除业务数据（只隐藏，不删除）
- ❌ 语言停用时 drop `{table}_i18n` 表（翻译要留住）
- ❌ 在 `src/` 或新迁移里引用已退役的 `theme_admin_menus`（唯一来源是 `admin_menu_registry`）
- ❌ 把后台"新建"与"列表"合并成同一个页名（会让 Add 静默失效）
- ❌ 让插件声明 `tables[]` 或使用 `table-list` / `table-edit`（属批次 4）
- ❌ 新增架构规则却不做反向验证（测不出失败的检查不是检查）
- ❌ 把一个概念在 JS 和 SQL 里各写一遍（共用定义，见规则 30）

---

## 已知的、有意保留的偏离

| 事项 | 现状 | 原因 |
|---|---|---|
| 后台 SPA 的目录位置 | 模块结构已按 §7.2 拆好，但仍在 `public/admin/` 而非仓库根的 `admin/` | `wrangler.jsonc` 的 `assets.directory` 只接受一个目录，而 `/admin/*` 必须保留；搬迁需与 `public/` 的资源归属一并规划 |
| `public/admin/ui.js` | 仍是 303 行单文件（UI kit 未再细分） | 与屏幕拆分正交；真要拆应等后台多语言（L2）落地时一起做 |
| `extensions/contract/` | 目前只有 `hooks.ts`；`manifest.ts`/`validation.ts`/`capabilities.ts` 未拆 | 批次 4（纯结构重构，无行为变化） |
| 插件自有表 | 插件**不能**声明 `tables[]`（校验器拒绝） | `theme_table_defs` 只有 `theme_name` 列，支持插件必须**重建该表**（SQLite 不能 `ALTER` 主键/UNIQUE）；批次 4 |

这些**不是"可以随意违反规则"的许可证**——它们是**已登记的技术债**，
每一项都有明确的归属批次。新增类似问题时，登记到这里，不要静默放行。
