---
name: port-design-system-to-spa
description: 当要把一个无构建步骤的 SPA / 后台界面「改成某个参考设计系统的样子」并保留全部既有功能时使用（如「照 shadcn-admin 重做我们的后台」「换成这套 UI 的样式」）。覆盖：照搬 oklch 设计令牌、无构建的 ESM 分层（tokens→icons→ui kit→app）、内联 onclick 与模块作用域的冲突、绘制前主题脚本防闪烁、以及用 Playwright 跑「N 页面 × 明暗两套主题 + 交互」的渲染验收。触发词：改造后台、换皮、照这个 UI 库做、设计系统、shadcn、明暗主题、闪白、截图验证。
agent_created: true
---

# 把设计系统移植到无构建 SPA

## 第 0 步：先核实「同一份样式」的说法

如果需求是「把 X 也改成这个样子」而项目里有多个界面/主题，**先 diff，别假设**。
实测踩过：某 CMS 声称有 3 个主题，其中一个的首页与详情页模板**逐字相同**，
都是 6 行骨架。所谓「多个主题」根本不存在 ——
那种情况下正确的动作是**从零设计一个**，而不是在副本上做增量修改。

增量修改会浪费大量精力把一个空壳打磨得「稍微好看一点」，
而用户真正要的是**质变**。先花两分钟 diff，能省掉一整轮返工。

## 什么时候用

用户给一个参考界面（如 `https://shadcn-admin.netlify.app/`）说「把我们的后台
界面和功能都用他的样式」，而**现有前端是零构建的 ESM + 纯 CSS**。

目标不是「随手调个色」，而是**逐字照搬令牌 + 结构性对齐布局**，
同时**一个功能都不能丢、一个页面都不能少**。所以「改完」不等于「改对」——
必须有一轮渲染验收（见下文）。按这个顺序做：

1. 先扒参考站的设计令牌（下面的取法）
2. 再搭无构建的分层
3. 逐页重写，页面清单先列出来当验收表
4. 用渲染harness 跑全量验收
5. 修掉截图里发现的问题（**这步几乎总有东西**）

## 第一步：扒令牌，不要自己调色

打开参考站，从 computed style 里取**原始值**。shadcn 系用 `oklch()`：

```js
// 在参考站控制台里跑，把 :root / .dark 两套变量一次取全
const keys = ["background","foreground","card","popover","primary","secondary",
  "muted","accent","destructive","success","border","input","ring",
  "chart-1","chart-2","chart-3","chart-4","chart-5",
  "sidebar","sidebar-foreground","sidebar-primary","sidebar-accent","sidebar-border"];
const cs = getComputedStyle(document.documentElement);
console.log(JSON.stringify(Object.fromEntries(keys.map(k => [k, cs.getPropertyValue("--" + k).trim()]))));
```

**逐字复制，一个数都别改。** 自己四舍五入或「凭感觉接近」的颜色，
放一起看立刻能看出脏。同样取 `--radius`（shadcn 是 `0.625rem`）并派生：

```css
:root { --radius: 0.625rem;
  --radius-sm: calc(var(--radius) - 4px); --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius); --radius-xl: calc(var(--radius) + 4px); }
```

`.dark` 是**另一套完整值**（不是反色），照搬即可。字体也照搬
（shadcn-admin 是 Inter 正文 + Manrope 标题）。

## 第二步：无构建的分层

保持零构建（不改 `package.json` 加打包器），用原生 ESM 分层。这个顺序有依赖关系，
别打乱：

```
admin.css          令牌 → reset → shell → 侧栏 → 头部 → 下拉 → 卡片 →
                   按钮 → 表单 → 表格 → 徽章 → 页头/面包屑 → 对话框 →
                   toast → 编辑器 → 登录 → 响应式
icons.js           内联 lucide SVG path（避免网络依赖 + 避免图标字体）
ui.js              主题 / toast / 对话框 / 下拉 / 格式化助函数
admin.js           数据 + 路由 + 各页面渲染，import 上面两个
index.html         字体 + favicon + 绘制前主题脚本
```

**图标内联而不是引 CDN**：`f(lucide)` 之类的图标库走网络会引入加载竞态
（图标后到 → 布局跳动），而且离线/内网环境直接挂。把用到的 path 抄进一个
`PATHS` 对象即可，几十行。

```js
export function icon(name, attrs = "") {
  const d = PATHS[name] || PATHS.circle;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${attrs}>${d}</svg>`;
}
```

## ⚠️ 坑 1：内联 `onclick=` 解析在 `window` 上，不是模块作用域

渲染出来的标记里写 `onclick="toggleMenu('x')"` 时，浏览器在**全局作用域**里找
`toggleMenu`。但它是 ESM 的模块内导入，**不在 `window` 上** → 运行时报
`toggleMenu is not defined`，界面「点了没反应」。

两种修法，选一个并**全项目统一**：

```js
// A. 显式挂到 window（改动最小，适合已有一堆内联 onclick）
window.toggleMenu = toggleMenu;
window.closeMenus = closeMenus;
```

```js
// B. 全改 data-* + 事件委托（更干净，推荐新代码）
// 标记：<button data-action="toggle-menu" data-menu="theme-menu">
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (el) HANDLERS[el.dataset.action]?.(el.dataset, el);
});
```

**注意委托的副作用**：document 级 click 处理器会在你点击触发器之后立刻
把菜单关掉（"点开就关"）。验证脚本里要**点真实的触发器元素**，或者
用 `e.stopPropagation()`，别用「先 programmatic 打开再断言」。

> 如果这个 SPA 之后要**拆成多模块**，这条契约会变成静默失效的：
> 拆完后少挂一个 `window.xxx` 不编译、不报 console、不发失败请求，
> 按钮就是点了没反应。拆分的完整流程与配套契约测试见
> skill `split-monolith-spa-into-modules`。

## ⚠️ 坑 2：首屏主题闪白

主题偏好存在 localStorage，但脚本在 body 之后才跑 → 暗色用户会看到
**一帧白屏**。必须在 `<head>` 里、**任何样式应用之前**同步判断：

```html
<script>
  (function () {
    try {
      var pref = localStorage.getItem("cfpress.admin.theme") || "system";
      var dark = pref === "dark" ||
        (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
      if (dark) document.documentElement.classList.add("dark");
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
    } catch (e) {}
  })();
</script>
```

`colorScheme` 那行也要写：它让**原生控件**（滚动条、日期选择器、表单）
跟着变暗，否则暗色页面里嵌一个亮色滚动条。

## 第三步：写渲染验收 harness

这是「改完」和「改对」的分界线。用 `playwright-core` + **系统已装的 Chrome**
（`executablePath`），不下载浏览器。

```js
import { chromium } from "playwright-core";
const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  args: ["--no-sandbox"],
});
```

> 先检查 managed workspace 里是不是**已经有** `playwright-core` 和已下载的浏览器，
> 有的话连 `executablePath` 都不用给（默认走 `%LOCALAPPDATA%\ms-playwright`）：
> ```js
> const PW = "C:/Users/TF/.workbuddy-ai/binaries/node/workspace/node_modules/playwright-core";
> const { chromium } = require(PW);   // .cjs 脚本里用绝对路径 require
> ```
> 别急着 `npm install -g agent-browser`（那要下 ~500MB）。

**矩阵要跑「N 个页面 × 明暗两套」**，每格断言四件事：

```js
for (const theme of ["light", "dark"]) {
  for (const [key, path] of pages) {
    await page.evaluate((t) => window.setThemeForTest(t), theme);
    await page.evaluate((p) => window.go(p), path);
    await page.waitForTimeout(400);
    const probe = await page.evaluate(() => ({
      h1: document.querySelector(".page h1")?.textContent?.trim(),
      nav: document.querySelectorAll(".sidebar .nav-item").length,
      text: document.querySelector(".page")?.textContent?.trim().length,
      shell: !!document.querySelector(".layout aside.sidebar"),
    }));
    // 断言：h1 对得上 / 导航项数 > 0 / 正文非空 / 壳层存在
  }
}
```

同时收集 `console` 的 `error`、`pageerror`、以及响应 `status >= 500`。
**「零错误」比「看着对」值钱得多** —— 一次未捕获异常会让下半页静默不渲染。

为了让 harness 能驱动主题，在 app 里留一个测试钩子：

```js
window.setThemeForTest = (pref) => setTheme(pref);
```

## ⚠️ 坑 3：截图截到动画的 t≈0 帧

`waitForSelector('.dialog')` 在**元素插入时**就返回，但面板还有
`animation: dialog-in 160ms`。此刻截图 → 拿到近乎透明的空图，
看着像「对话框没渲染」，实际是**测试时序问题**。

**等元素存在 ≠ 等它可见。** 加动画时长以上的等待：

```js
await page.waitForSelector(".dialog", { timeout: 5000 });
await page.waitForTimeout(350);   // 等 dialog-in 动画走完
await page.screenshot({ path: `${OUT}/dialog-site.png` });
```

同类陷阱：下拉、toast、折叠动画都有。**凡是带 `animation` 的元素，
截图前都要额外等。** 别急着改 UI —— 先用「元素在不在 DOM 里 / 有没有尺寸」
区分「没渲染」和「没截到」。

## ⚠️ 坑 4：导航重复项（主题声明的菜单 vs CPT）

如果后台支持「主题声明内容类型 + 主题声明管理菜单」，很容易同一个东西
在侧栏出现两次。本例：`storefront` 主题同时声明了 CPT `product`（→ "Products"）
和菜单 `{ screen: "content-list", args: { type: "product" } }`，两者指向
**同一个列表屏**。

修法是**在构建导航时去重**，而不是让主题别声明：

```js
function isRedundantThemeMenu(menu, postTypes) {
  if (menu.screen !== "content-list") return false;
  const type = menu.args?.type;
  if (!type) return false;
  if (type === "posts" || type === "pages") return true;   // core 屏
  return postTypes.some((pt) => pt.name === type);
}
```

判据是「**是否指向同一个屏幕**」，不是「名字是否相同」——
名字可以本地化不一致，`screen + args` 才是身份。

## ⚠️ 坑 5：组件样式写进了单个页面，别的页面就漏了

没有资源管线（主题/组件被内联进响应）时，**每个模板自己的 `<style>` 只作用于该页**。
共用的组件规则（卡片、栅格、按钮、小图标）必须提进**共享片段**。

实测踩过的一次：文章页的「相关文章」卡片复用了首页的 `.card` / `.post-card-foot`
标记，但 `.arrow` 的尺寸规则**只写在 `index.html`** 里。结果首页正常，
文章页的同一个箭头 SVG **撑满了整个屏幕**（`<svg>` 默认 `width:100%`）。

两条推论：
- **`<svg>` 永远显式给宽高**，否则它会撑满容器。
- 写完一个页面后，**grep 一下它引用的组件类是否在共享片段里有定义**：

```bash
# 列出一个页面用了哪些 class，看有没有只在别处定义的
grep -o 'class="[^"]*"' themes/x/templates/single.html | tr ' ' '\n' | sort -u
grep -c '\.post-card-foot' themes/x/templates/parts/tokens.html   # 0 就是漏了
```

## 验收清单

改完必须给出这些数，缺一条就不算完成：

| 项 | 怎么验 |
| --- | --- |
| 页面清单没少 | 重写前先把页面 key 列表出来，harness 里逐个跑，比对条数 |
| 明暗两套都能渲染 | 矩阵跑两遍，两遍都零错误 |
| 零 JS 错误 | `console` error + `pageerror` 都为空 |
| 零 5xx | 响应状态收集 |
| 交互仍可用 | 对话框开合 / 必填校验拦截 / 下拉 / 侧栏折叠 / 主题持久化 / 编辑器 |
| 类型没崩 | `tsc --noEmit`，**只 grep `src/` 和 `public/`**（`node_modules` 里 的 `lib.dom.d.ts` 会刷屏，是环境噪音不是你的错） |
| 单测没退 | `npm test` 全绿 |

**登录前的 401 是正常现象**，不是缺陷 —— SPA 启动时会探测
`/api/v1/auth/me`，未登录必然 401，然后回落到登录表单。
在 harness 里标注 `[expected-pre-login]` 而不是去「修」它。

## 收尾

一次性 harness 和截图**用完就删**（`.verify-admin.mjs`、`.verify/`）。
它依赖本机 Chrome 路径和运行中的 dev server，留在仓库里只会是个坏掉的测试。
要长期化就改造成不依赖外部状态的正式测试再纳入 `npm test`。
