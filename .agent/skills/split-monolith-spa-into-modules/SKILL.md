---
name: split-monolith-spa-into-modules
description: 当要把一个无构建（零打包）的浏览器 ESM 单体文件拆成多模块并保住全部功能时使用，尤其是后台 SPA。覆盖：拆分前先清点 window.* 契约（它是唯一外部可见面，且文档里的数字常是错的）、避免 shell↔screens 循环 import 的自注册模式、给拆分写一份真跑得起来的结构契约测试（在 Node 里 import 浏览器 ESM 的办法）、以及那个最容易骗过自己的假绿陷阱（断言"没抛错"是无效断言）。触发词：拆分单文件、拆成模块、admin.js 太大、SPA 重构、模块化、循环 import、window 上找不到函数、按钮点了没反应。
agent_created: true
---

# 把无构建 SPA 单体安全拆成模块

**这是重构，不是重写。** 判定标准是「行为逐字不变，只是文件变多了」。
下面每一步都是为了让「我改对了」变成机器可判定的，而不是靠眼睛看。

先读 `port-design-system-to-spa`（如果存在）：那份讲的是换皮时的分层与令牌，
这份讲的是**已有代码的拆分**。两者的坑 1（内联 `onclick` 解析在 `window` 上）重叠，
但那份没讲「拆完之后这条契约会变成静默失效的」。

## 第 0 步（不可跳过）：先清点外部契约，别信文档里的数字

渲染出来的标记用内联 `onclick="name(...)"`，浏览器在**全局作用域**找 `name`。
所以「挂在 `window` 上的函数」是这个 SPA 唯一的外部可见面。
拆分必然要重新分配这些挂载点 —— 先把它们**逐个列出来**：

```bash
git show HEAD:public/admin/admin.js | grep -oE "window\.[a-zA-Z]+ *=" | sort -u
```

实测教训：交接文档写着「18 个 `window.*` 处理器」，实际数出来是 **17**。
文档是手写的、会漂；`grep` 出来的才是真的。
**文档与实测冲突时以实测为准，并顺手把文档改对**（否则下一个会话继续被骗）。

同时把「标记里真正调用了哪些名字」也扫出来，两边对照：

```bash
grep -oE 'onclick\s*=\s*["'"'"']([A-Za-z_$][\w$]*)\s*\(' -r public/admin | sort -u
```

注意 `onclick="this.querySelector('input').focus()"` 这类**不是** window 处理器，
只匹配「裸标识符紧跟 `(`」。**扫描前必须剥掉注释**，否则文档里写的
`onclick="name(...)"` 示例会被当成真实调用，报出一个叫 `name` 的幽灵缺失。

## 拆分结构：让环不可能出现

单体里的典型结构是：`state` + `导航/壳层` + `render()` + `N 个屏幕`。
直接照搬会立刻成环 —— **屏幕要调 `render()`，而 `render()` 要调屏幕**。

标准解法（三层，依赖方向单向）：

```
state.js     共享 state + API 帮手。**叶子模块：不 import 任何东西。** 所有模块都可以依赖它
shell.js     render 循环 + 页面骨架 + 屏幕注册表。**不 import 任何屏幕**
screens/*   每个屏幕一个模块，import state + shell
screens/index.js   页名 → 屏幕 的注册表（唯一 import 全部屏幕的模块）
admin.js     入口：setScreenTable(SCREENS) + 注册 window.* + 启动
```

三条具体做法，缺一个就会成环：

1. **屏幕自注册，而不是被 shell import**：`setScreenTable(SCREENS)`。
   shell 只认 `Map<页名, 函数>`，不认识任何具体屏幕。
2. **登录屏/错误屏用注入**：`setLoginScreen(renderLogin)`。因为 `render()`
   在无会话时要显示登录屏，而 auth 模块又要 `render()` —— 用 setter 把这条边反转。
3. **屏幕之间不互相 import，共用逻辑抽独立模块。**
   实测例子：主题屏和插件屏都要上传扩展 ZIP，于是抽出 `extension-install.js`，
   而不是让主题屏 import 插件屏。

**顺带清理**：单体里内部调用常写成 `window.go(...)`、`window.editContent(...)`。
拆完后应改成**直接调用导入的函数**。留着 `window.` 会让「有没有注册」和
「能不能调用」两件事纠缠在一起。

**别把「挪目录」混进这次拆分。** 实测踩过：想顺手把 `public/admin/` 搬到仓库根的
`admin/`，但 `wrangler.jsonc` 的 `assets.directory` 只接受**一个**目录，
而 `/admin/*` 这个 URL 空间必须保留。挪位置要么再加一个静态目录、要么重构整个
`public/` —— 与「拆 JS」正交。**登记进技术债，不要静默一起做**（静默混做会让
出问题时分不清是哪一步的锅）。

## 写结构契约测试（这才是拆分的验收）

放在 `tests/`，纳入 `npm test`。四组断言：

### 1. 模块图：可解析 + 无环 + 无孤儿

自己写 DFS，**报出完整环路径**（`a.js → b.js → a.js`），只报"有环"没用。
「无孤儿」= 每个模块都能从入口走到 —— 抓「写了但没人 import」的死代码，
这在拆分过程中极容易出现。

### 2. `window.*` 契约

- 入口有一个**显眼的** `WINDOW_HANDLERS` 映射（把契约集中到一处，人能一眼看全）
- 第 0 步数出来的那 N 个名字**一个都没少**（写死成常量数组，删一个就红）
- 标记里调用的每个名字都在注册集里

### 3. 在 Node 里**真实 import** 整个模块图

文本扫描只能证明文件存在。真实 import 才能证明没有语法错误、没有缺失导出、
顶层没有 `ReferenceError`。

浏览器 ESM 的 `.js` 在 Node 里默认按 CJS 解析（`import` 直接报错），所以：

```js
const tmp = mkdtempSync(join(tmpdir(), "spa-"));
cpSync(ADMIN_DIR, tmp, { recursive: true });
writeFileSync(join(tmp, "package.json"), '{"type":"module"}\n');
await import(pathToFileURL(join(tmp, "admin.js")).href);
```

配一套最小 DOM 替身：`window`（含 `matchMedia`）、`document`（`querySelector`
返回持久化的 `#app` / `#content` 元素、`addEventListener` 空实现）、
`localStorage`、`fetch`（返回 `{ok:true, json:async()=>({user:null})}` 之类）、
`CustomEvent`、`CSS.escape`。

> ⚠️ **Node 22 的 `globalThis.navigator` 是只读 getter**，赋值会
> `TypeError: Cannot set property navigator`。别赋它（真要用就 `Object.defineProperty`）。

**用持久化的 `#content` 元素**，才能把屏幕写进去的东西读回来做断言（见下一节）。

### 4. 每个屏幕真渲染一次

拿到注册表后，逐个设 `state.page` 并 `await render()`。
`fetch` 替身返回空集合形状（`{items: []}`），每个屏幕的空态都该能跑通。

### ⚠️ 假绿陷阱：断言「没抛错」是无效断言

这是本类任务**最容易骗过自己**的地方，必须记牢：

```js
try { await render(); } catch (e) { errors.push(e.message); }   // ❌ 无效
```

因为 shell 通常自己 `try/catch` 住屏幕异常，**渲染成"出错了"面板并正常返回**。
于是往屏幕体里注入一个未定义的标识符，这个断言**依然全绿**。

正确写法 —— 断言**真正写进 DOM 的内容**：

```js
contentEl.innerHTML = "";
await render();
if (contentEl.innerHTML.includes("Something went wrong")) errors.push(`${page}: 渲染了错误面板`);
if (!contentEl.innerHTML) errors.push(`${page}: 什么都没渲染`);
```

**通用教训：「没有异常」是个恒定不变的值。** 断言必须盯住
「注入缺陷后**必然**会变的那个值」。（同源的假绿在别处也出现过：断言"XML 格式正确"
而不是断言"默认站的文章没有混进这个站的 sitemap"。）

### 5. 加一条棘轮，防止屏幕长回入口

```js
check("入口只做装配（< 120 行）", entryLines < 120, ...);
check("入口不定义任何屏幕", screenDefsInEntry.length === 0, ...);
```

阈值给宽一点：它抓的是「有人把整个屏幕粘回入口」，不是正常的接线改动。

## 反向验证：6 项注入，每一项都必须让它变红

**测不出失败的检查等于没有检查。** 逐条注入、确认 FAIL、再撤回：

| 注入 | 期望的失败 |
| --- | --- |
| 从 `WINDOW_HANDLERS` 删掉一个名字 | 「no longer published」+「not a function on window」 |
| 给 shell 加一条 `import … screens/x.js` | 报出完整环路径 |
| 标记里加一个未注册的内联 `onclick` | 「markup calls these but nothing publishes them」 |
| 新增一个没人 import 的模块 | 「orphans (written but never imported)」 |
| 屏幕体内引用未导入的标识符 | 「rendered the error panel」 |
| 让某个屏幕什么都不写 | 「rendered nothing」 |

**第 5 项是第一版漏掉的** —— 它正好暴露了上面那个假绿。做反向验证的价值就在这：
它会替你发现"我以为在守的东西其实没守"。

注入用 shell 脚本 + `cp` 备份 / 还原最省事，跑完务必 `grep` 确认文件已还原。

## 真实浏览器冒烟（拆分后必做，成本很低）

结构测试证明不了「新的子目录被托管了」和「真实事件委托能用」。这两件事只有浏览器能答。

**不需要装 `agent-browser`（要下 ~500MB）。** managed workspace 里通常已有
`playwright-core`，浏览器也已在缓存里：

```js
// 临时 .cjs 脚本，绝对路径 require
const PW = "C:/Users/TF/.workbuddy-ai/binaries/node/workspace/node_modules/playwright-core";
const { chromium } = require(PW);   // 浏览器默认在 %LOCALAPPDATA%\ms-playwright
```

配合后台跑一个 `wrangler dev --port 8787 --ip 127.0.0.1`，然后：

1. **先 curl 探测新子目录的每个文件**（`/admin/js/**`），确认 200 且
   `content_type` 是 `text/javascript` —— **MIME 不对，ESM 会被浏览器直接拒绝**，
   而这是个纯配置问题、单元测试永远发现不了。
2. 登录 → **真实点击**侧栏项（走 document 级委托，别用 `page.evaluate` 绕过）
3. 下拉菜单、侧栏折叠、登出（走 `data-action` 委托）
4. **N 个页面 × 明暗两套**，每格断言 h1 非空 / 正文长度 / 壳层存在 / 无错误面板
5. 收集 `console`(error) / `pageerror` / `requestfailed` / `status >= 500`

**登录前的 `/api/v1/auth/me` 401 是设计内的**，标注为 expected 而不是去"修"。

脚本用完即删（放 OS 临时目录），别留在仓库里 —— 它依赖本机路径和运行中的 dev server。

## 验收清单

| 项 | 怎么验 |
| --- | --- |
| 外部契约没少 | 第 0 步数出来的 N 个名字全部仍被注册（写死成常量） |
| 模块图健康 | 无环 + 无孤儿 + 全部可解析 |
| 每个屏幕能渲染 | 逐页真渲染，断言 DOM 内容（不是"没抛错"） |
| 反向验证 | 6 项注入全部如期变红 |
| 浏览器冒烟 | 静态资源 MIME 正确 + 交互走真实点击 + N 页 × 明暗 + 零错误 |
| 没混入别的改动 | 目录位置、样式、功能都不动；要动的登记进技术债 |
| 文档同步 | 把实测数字（如 17 而不是 18）写回文档；新增的结构规则写进 `AGENTS.md` |
