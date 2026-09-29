---
name: cdp-probe-real-layout
description: 当布局/尺寸问题在 jsdom 单测里复现不出来、或需要验证真实部署上的交互流程（重连、后台恢复、会话保活、弹窗状态流转）时使用。用 Chrome headless + CDP，把后端 API、WebSocket、visualViewport 换成假的，让需要登录/连服务器的界面真的渲染出来，然后量几何或读请求日志。触发词：手机上看不对、键盘挡住、真实布局、jsdom 测不出来、量一下位置、线上验证、CDP 探针、重连验证、后台恢复、探针、文字太长撑开界面、换行、被裁掉、overflow、假绿断言。
agent_created: true
---

# 用 CDP 探针量真实布局

## 什么时候用

单测全绿但**真实布局里位置不对** —— jsdom 的 `getBoundingClientRect()` 全返回 0，
`offsetParent`、flex 分配、padding 折叠一律测不出来。
典型症状：某个元素在真机上偏了十几像素，单测却「通过」。

**能上 CDP 量就别只用 jsdom 下结论。** 单元测试和真实浏览器各有一半。

同一套手法也能验**交互流程**（断线重连、后台恢复、会话复用）—— 那时不看几何，
看**请求日志和 WebSocket 地址**，见下面「验重连/恢复流程」。

## 核心手法：把后端换成假的

要验的界面往往需要登录 / 连服务器才渲染（比如终端面板、按键栏）。
探针连不上，所以用 `Page.addScriptToEvaluateOnNewDocument` 注入脚本，
在应用代码运行**之前**替换三样东西：

1. **`window.fetch`** —— 拦 `/api/v1/*` 返回假 JSON（用户、dashboard、服务器树、
   会话创建等）。应用启动需要哪个接口就补哪个。
2. **`WebSocket`** —— 换成永远 `readyState = 1` 的假实现，异步补一次 `onopen`。
   不换的话会话会被判为断开而从状态里消失，界面就没了。
   注意应用用的是 `ws.onopen = ...` 属性赋值，不是 `addEventListener`。
3. **`visualViewport`** —— 见下，用来模拟软键盘。

```js
// 注入脚本里不要用反引号和 ${}，因为它本身是外层模板字符串
Object.defineProperty(window, "visualViewport", {
  configurable: true,
  get: function () { return vv; }
});
```

## 模拟软键盘

iOS 上键盘是浮层，`visualViewport.height` 变小但布局视口不变。所以要一个
**可编程改高度并派发 resize** 的假对象：

```js
var listeners = {};
var override = null;
var vv = {
  // 必须用 getter 惰性读 —— 文档起始时 window.innerHeight 还不是最终值
  // （CDP 的设备指标覆盖尚未生效），那一刻固定下来会得到 2121 这种鬼值。
  get height() { return override === null ? window.innerHeight : override; },
  get width() { return window.innerWidth; },
  offsetTop: 0, scale: 1,
  addEventListener: function (t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
  removeEventListener: function (t, fn) {
    var a = listeners[t] || []; var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
  },
  __setHeight: function (h) {
    override = h;
    (listeners.resize || []).slice().forEach(function (fn) { fn({ type: "resize" }); });
  }
};
```

模拟「键盘高 300」= `__setHeight(window.innerHeight - 300)`。
键盘上沿在布局坐标里就是 `innerHeight - 300`。

## 触发交互的几个坑

- **别用 `el.click()` 代替真实交互**。先看组件源码确认处理器挂在哪：
  很多行是 `onClick` 只做「选中」、`onDoubleClick` 才「连接」。
  该双击就 `dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`。
- **按文本找目标要挑最内层**：遍历所有元素，只选「没有任何子元素的文本也匹配」的那个，
  否则会点到 `.widget-body` 这类大容器，点了等于没点。
  再往上找最近的可点祖先（`BUTTON` / `[role=button]`）会更稳。
- **响应式布局可能一次只挂载一个区块**：连上之后还要点对应的 tab，
  目标组件才会 mount，否则量不到东西。
- **用 CDP 事件诊断「点了没反应」**：开 `Network.enable`，监听
  `Network.requestWillBeSent` / `responseReceived`，看预期的那条请求到底发出去没有。
  这比猜快得多。
- **别用固定 `sleep` 等首屏。** 冷 profile 第一次导航要下载全部 JS/CSS，
  固定等 2 秒往往量到**还没渲染的空页面**，于是报出 `no-item:连接|选择|编辑`
  这种看起来像产品 bug 的假失败（`bodyText` 里会出现 `Unexpected token '<'`，
  说明 SPA 根本没起来）。改成**轮询目标选择器出现**再动手：

  ```js
  async function waitUntil(fn, timeoutMs) {
    const t0 = Date.now();
    for (;;) {
      if (await fn()) return true;
      if (Date.now() - t0 > timeoutMs) return false;
      await sleep(150);
    }
  }
  await waitUntil(() => evaluate(
    "!!document.querySelector('.server-list-widget') && " +
    "document.body.innerText.includes('目标服务器')"), 15000);
  ```

  带缓存的 profile 单跑一遍就过、全量一起跑就挂 —— 十有八九是等首屏等短了，
  先怀疑探针，别先怀疑产品。

## 验重连 / 后台恢复流程

这时假 WebSocket 必须是**协议感知**的：收到什么消息就回什么，而不是只补一次
`onopen`。终端回 `{type:"status", message:"Shell 已就绪"}`，SFTP 回
`sftp_socket_ready` / `sftp_ready` / `sftp_list_result` / `pong`。
只补 `onopen` 的话握手永远完不成，界面停在「正在连接」，会被误判成产品坏了。

要断言的也不是界面文字，而是**日志**：

- 给假 `fetch` 加一层记录（`method + path`），存 `sessionStorage` 以便**跨重载累积**。
  于是「全程只新建过一次会话」「重挂前做过存在性校验」这类断言才成立。
- 记录每次 `new WebSocket(url)`，断言重连后的地址仍指向**同一个 sessionId**。
- 模拟断线就是调假 socket 的 `close()`（会触发 `onclose`，走真实重连逻辑），
  再 `Page.navigate` 重载，看它能不能从 localStorage 找回会话。

### 三个会让探针说谎的坑

1. **选择器撞上隐藏元素。** 用 `.widget-body input` 取「路径输入框」，会先命中
   文件管理最前面那两个隐藏的 `<input type="file">`（上传文件/文件夹），
   读出来永远是 `""` —— 看起来像产品没恢复，其实是探针读错了。
   按目标自己的特征类取（`.widget-body form input.font-mono`）。
   **读不到值先怀疑选择器，别急着怀疑产品。**
2. **模拟「僵尸连接」别用全局布尔量。** 用 `window.__sftpZombie = true` 让所有
   SFTP 连接都不应答，重连后**新建**的连接也会被一起静音，握手永远完不成，
   于是「重连失败」被误报。正确做法是按 socket 序号记 cutoff，
   只静音 zombify 之前就存在的那几条 —— 等价于「网络恢复了」。
3. **`textContent` 读不到表单控件的值。** 想验「输入框默认填了什么」，
   `el.textContent` 永远是 `""`（值在 `value` 属性/属性值里，不在文本节点里），
   于是「默认值没填上」被误报。要读 `el.value`；`<select>` 同理读 `.value`。

## ⚠️ 断言「没超出容器」多半是假绿 —— 要量「有没有被裁掉」

**这是最容易写出假绿的一类断言。** 症状：用户说「文字太长把界面撑开了」，
你写一条 `card.right <= viewport.width`，它**恒真** —— 因为卡片外层通常有
`min-width: 0; flex: 1`（防溢出的标准写法），宽度早就被钉死了，
内容再长也撑不开它。

于是探针全绿，你报告「已修复」，用户看到的还是坏的。

**真正发生的事是「静默裁掉」**：`white-space: nowrap` + `overflow: hidden`
把**自然宽度 3021px** 的文本塞进 **278px** 的盒子 ⇒ 约九成内容读不到，
连省略号都没有。实测：

```
旧实现： scrollWidth/clientWidth = 10.87   white-space: nowrap
修复后： scrollWidth/clientWidth = 1.0     white-space: pre-wrap
```

**判据要写成「内容宽度 ≈ 可见宽度」（即真的换行了）**，不是「没超出父容器」：

```js
horizRatio: +(pre.scrollWidth / Math.max(pre.clientWidth, 1)).toFixed(2)
// 断言 horizRatio <= 1.1；>1.1 说明还有横向裁切
```

要覆盖的两种极端：**超长单行**（3000px 不换行）、
**单个超长无空格 token**（600 个 A，测 `overflow-wrap: anywhere` 有没有生效）。
只测前者会漏掉「有空格才换行、长 token 照样溢出」的情况。

> 通用规律：**凡是断言「没有发生 X」的探针，都要先问「X 在这里可能发生吗」**。
> 父级有防溢出约束时，「溢出」在物理上就不可能，那条断言就是装饰品。
> 反向验证（见下）能当场把它抓出来 —— 这也是为什么反证不是可选项。

### 反向验证：换回旧实现，看探针会不会红

改完先别急着报成功，**把改动回退，重跑一遍探针**。
如果回退后仍然全绿，说明你的断言根本没测到那个行为。

这次的做法：`cp` 备份 → 把 CSS 改回旧值 → 重新 `vite build` → 跑探针
→ 确认**恰好**那几条变红 → 再 `cp` 回来重新构建。

实测回退后：

```
[FAIL] 命令在卡片内换行（内容宽度没有远超可见宽度）  scrollW/clientW = 10.87
[FAIL] 命令块确实是 pre-wrap 换行  nowrap
22/24 通过
```

**变红的条数和理由都对得上，这条断言才算有效。**

## ⚠️ 探针自己的三个坑（都会伪装成产品 bug）

1. **点错元素 = 静默无反应。** 会话行可点的是行内
   `.ai-agent-session-open`（`<button>`），**不是**外层 `.ai-agent-session-row`
   那个 `<div>`（它没有点击处理器）。点了 div 什么都不发生，表现为
   「消息区一直是空态」，看着像产品坏了。
   **先读组件源码确认处理器挂在哪个元素上**，再写选择器。
2. **mock 的字段名/结构必须和真实接口逐字一致。** 消息要
   camelCase（`toolCalls` / `toolCallId` / `serverId`），且 `toolCallId` 在
   **顶层**、不在 `meta` 里。写成 snake_case 或塞错层级，工具卡片**根本不渲染**
   （静默退化成普通文本），又是一次「像产品 bug 的探针 bug」。
   最省事的对齐办法：去 `web/src/lib/*-types.ts` 抄 interface。
3. **响应式布局会藏元素。** 移动视口下侧栏**默认收起**，
   `.ai-agent-session-row` 压根不在 DOM 里 —— 要先点 `#ai-agent-sidebar-toggle`。
   报「找不到元素」之前先确认它在这个视口下该不该存在。

**排错顺序：先用 `__FETCH_LOG` 看请求发没发出去**，别猜。
这次就是靠它一眼看出 `GET /api/v1/ai/threads/t1` 从未发出 ——
于是立刻定位到「点了没反应」，而不是去查渲染。

```js
// 给假 fetch 加一行记录，成本极低，回报极高
window.__FETCH_LOG.push(method + " " + pathOnly);
```

## ⚠️ 按键要用 CDP 真按键，合成事件到不了内层元素

`new KeyboardEvent("keydown", ...)` 派发到 `window` **只能触发挂在 window 上的
监听器**。React 组件挂在内层元素上的 `onKeyDown` 收不到 ——
于是你会得到「按 Esc 没反应」的**假失败**（实测：灯箱的 Esc 就是这么挂的，
合成事件完全没反应，换成真按键立刻正常）。

```js
// 真按键：走正常的焦点/事件路径，等价于用户真的按了
async function pressEscape(send) {
  const base = { key: "Escape", code: "Escape",
    windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}
```

判据：**只要被测组件可能把监听器挂在内层元素上，就必须用真按键。**
同理，点击优先用 `Input.dispatchMouseEvent` 而不是 `el.click()`。

## ⚠️ 注释里的因果断言也要验证

写代码时顺手写下的「因为 A 所以 B」，**可能只是猜测**。这次我注释里写
「Blob 的 MIME 给错，`<img>` 可能拒绝渲染」，反向验证一跑：
故意改成 `application/octet-stream`，图片**照样解码**（浏览器嗅探内容，
不信 Blob 的 type）。注释当场变成假话。

**反向验证不只是验代码，也是验你的解释。** 把猜测当成结论写进注释，
下一个人会照着它做错误决策。

## 探针要先让界面「活到能测的状态」

复杂界面往往有一长串前置条件，缺一个就停在某个中间态，而**报错信息看起来
很像产品 bug**。这次要测文件管理里的图片预览，链路是：

```
server_list widget（双击服务器）
  → 弹 tmux 选择框（再点「打开」）
  → terminal widget（**它**才打开会话的 WebSocket）
  → 会话 status 变 open
  → file_manager widget 才去挂 SFTP
```

只挂 `file_manager` 会卡在「正在连接 SFTP...」——因为**打开 WebSocket 的是终端
组件**，没有它会话永远停在 `connecting`。
⇒ **先搞清楚目标界面依赖哪些兄弟组件**，把它们一起挂上，别只挂目标那个。

顺带：不 mock `/api/v1/sessions/:id/tmux` 会掉进 SPA 兜底返回 `index.html`，
前端解析时报 `Unexpected token '<'` —— **看到这个报错就说明有个接口没 mock**，
不是 JSON 坏了。

## 环境：别把备份放 `/tmp`

本机（Windows + Git Bash）的 `/tmp` 上 `cp` 备份**不可靠** ——
实测两次「备份 → 改坏 → `cp` 还原」都没生效，白改一轮。
改动前要留退路，备份放**项目目录内**（或直接靠 git）。

## 验「固定尺寸」类改动：一定要做反证

改「弹窗/面板高度固定」「别跳来跳去」这类需求，光断言「现在高度一致」是不够的 ——
**你没证明探针本来能抓到不一致**。很可能它测的 tab 恰好一样高，白跑一趟。

所以补一个**反证脚本**：用 `Page.addScriptToEvaluateOnNewDocument` 之外的方式
（页面加载后 `document.head.appendChild(style)`）把**旧样式**用 `!important` 注回去，
复现改之前的状态，看探针能不能报出问题。

实测效果（设置弹窗固定高度那次）：

```
注入旧样式后：高=919 / 513 / 948 / 1156（4 种），遮罩可滚=true
改完之后：    高=704（恒定），遮罩可滚=false
```

能报出 4 种高度 + 遮罩被滚动，才说明「全部 tab 高度一致」这条断言有意义。

量的时候把这几样都带上，缺一样就可能漏掉真问题：

| 量什么 | 为什么 |
| --- | --- |
| 容器 `width` + `height` | 只量高度会漏掉「顺手把 `max-width` 也改崩了」 |
| 标题栏 `top` | 高度一致但整体被滚走了也是坏的 |
| 内层滚动区 `scrollHeight` vs `clientHeight` | 证明滚动确实发生在内层，不是被裁掉了 |
| 遮罩层 `scrollTop` / 是否可滚 | 旧实现的典型症状就是遮罩层在滚 |
| 视口内是否装得下（`top + height <= innerHeight`） | 超出去就会被遮罩层滚走 |

**至少跑三个尺寸**：正常桌面、手机竖屏、**矮窗口**（比如 1280x620）。
矮窗口专治「只在内容比视口高时才暴露」的问题。

### 还要证明「内容真的变了」，否则是空测

「各状态高度一致」这条断言有个致命漏洞：**可能这几个状态本来就一样高**，
那测了等于没测。所以同一批样本里必须再断言一次**内容确实变了**：

```js
// 切到私钥后控件换了一整块，测试连接的结果块也出现了 —— 内容确实变长
check(live[1].bodyScroll > live[0].bodyScroll, "切到私钥后内容确实变长（不是空测）",
      `${live[0].bodyScroll} -> ${live[1].bodyScroll}`);
```

实测：`620 -> 903`（切私钥）、`620 -> 700`（测试结果块），而弹窗高度始终 704。
**内容变了、高度没变**，这才叫结论。

但**别拿 `scrollHeight` 当「内容变长」的唯一证据**：内容没超出容器时
`scrollHeight === clientHeight`，两者恒等，切换状态前后读出来都是同一个数
（实测 `584 -> 584`），于是「内容确实变了」这条断言恒假 —— 又是一次假失败。
更稳的写法是量**首尾子元素的跨度**（内容没超出容器也会变）：

```js
// contentSpan = 最后一个子级 bottom - 第一个子级 top
check(after.span > before.span, "提交后内容确实变长（不是空测）",
      `${before.span} -> ${after.span}`);   // 实测 269 -> 510
```

两个都量最好：`scrollHeight` 证明「能滚了」，`contentSpan` 证明「内容真的多了」。

同理，量「子级有没有被 flex 规则误伤」要量 `getComputedStyle(el).flexGrow`，
不是看它有没有高度 —— 空元素的 height 恒为 0，两种情况的读数一样。

### 改「所有 X 统一行为」之前，先确认 X 是不是同一类

需求常写成「所有弹窗都一样」。但弹窗其实分两类，**统一规则硬套会砸掉另一类**：

- 内容会在打开期间变化的（切 tab、切认证方式、异步结果块）→ 需要固定高度。
- 内容从头到尾不变的短弹窗 → 本来就不会跳，硬撑到同一个高度只会变难看。

给通用组件（`Modal`）加规则时，**用 `:has()` 把规则限定在真正需要它的实例上**：

```css
/* 只有声明了滚动区的弹窗才钉住其余子级 */
.modal-dialog:has(> .modal-dialog-body) > * { flex: 0 0 auto; }
```

写成全局的 `.modal-dialog > * { flex: 0 0 auto }` 会把「子级要 `flex-1` 撑满」
的文件编辑器压塌 —— 而且 tsc、单测全绿，只有真实浏览器量得出来。
探针里合成节点直接量 `flexGrow`（期望 1 / 0 / 1）比截图快得多。

顺带：这条规则和 Tailwind v4 的分层优先级会打架（见下），
**凡是弹窗自己带的 `max-h-*` / `flex-*` 工具类，都可能被不写 `@layer` 的组件 CSS 压掉**。
改动前先 grep 一遍所有弹窗有没有这类工具类。

### Tailwind v4：把规则从媒体查询提到基类会静默压掉工具类

Tailwind v4 里 `@import "tailwindcss"` 建了 `theme/base/components/utilities` 四层。
**不写 `@layer` 的普通 CSS 优先级高于任何分层 CSS**，跟源码顺序无关。

后果：手机媒体查询里的 `.settings-dialog { max-width: none }` 本来只压手机端的
`max-w-md`，一旦提到基类，桌面端的 `max-w-2xl` 也一起被压掉 —— 弹窗静默变成满宽，
tsc / 单测全绿，只有截图能看出来。

所以**把一条规则从媒体查询提到基类时，先确认它原本在压哪个工具类**。
这类回归写进探针的宽度断言里（`期望 672px` / 手机 `358px`），别再靠肉眼。

## 判定要写成可读的结论

不要只 dump 一堆数字，把「期望值 vs 实际值 vs 偏差」算出来并给出 ✅/❌：

```js
const expectedBottom = keyboardTop - CLEARANCE;
const delta = actual.bottom - expectedBottom;
console.log(delta === 0 ? "✅ 位置正确" : `❌ 偏差 ${delta}px`);
```

顺手存一张截图，人眼也能复核。

## 环境注意

- `Page.captureScreenshot` 的 `clip` 必须是**像素**坐标，且 `scale` 越大越清晰。
- Chrome 用 `--headless=new --disable-gpu --no-sandbox`，
  固定 `--remote-debugging-port` 和独立的 `--user-data-dir`（避免脏 localStorage）。
- **Node 里传路径要给 Windows 形式**（`C:/Users/...`）。
  传 MSYS 的 `/c/Users/...` 会被当成相对路径解析成 `D:\c\Users\...`。
- `--window-size` 最小会被夹到 ~526px，所以要用 CDP 的
  `Emulation.setDeviceMetricsOverride` 才能拿到 390 这种窄宽度。
- 多尺寸一起跑（`360x640` / `390x844` / `430x932`）比只跑一个更能暴露
  依赖固定像素的假设。

## 本项目现成的脚本

`.workbuddy-ai/tools/mobile-render/`：
- `probe-keybar.js` —— 验按键栏键盘避让（假 API + WebSocket + visualViewport），
  自动判定间隙并截图。
- `probe-btn.js` —— 量标题栏/全屏按钮的几何与对比度，`fs` 参数可进全屏探测。
- `probe-sftp-resume.js` —— 验「切后台回来 SFTP 能否重挂」：协议感知假 WebSocket，
  制造僵尸通道，断言探活 → 重连 → 重新列目录，且目录停在原路径。
- `probe-session-retention.js` —— 验「断线重连 / 页面重载是否复用同一 sessionId」：
  请求日志跨重载累积，断言 `POST /api/v1/sessions` 全程只有 1 次。
- `probe-color-scheme-and-import.js` —— 验「界面配色自定义 + 服务器配置导入导出」
  （取色是否真落到内联 CSS 变量、切主题会不会串用另一套覆盖、导入是否先预演再 apply）。
- `probe-settings-dialog-height.js` —— 验设置弹窗固定高度：逐个 tab 量几何，
  断言高度/宽度/top 恒定、遮罩层不滚、内层内容区能滚。桌面 + 手机 + 矮窗口各一遍。
- `probe-settings-dialog-height-before.js` —— 上面那个的**反证**：注回旧样式，
  证明探针真能抓到「高度跳变」。
- `probe-modal-heights.js` —— 验「所有弹窗高度固定」：逐个弹窗打开、切状态量几何。
  断言各状态高度/顶部一致、完整落在视口内、遮罩层不被滚动、底部操作行始终可见，
  外加**非空测证明**（内容确实变长）和 `:has()` 作用域 / `maxHeight` 链路检查。
  `SHOT=1` 时顺手存图。
- `probe-ssh-key-dialog.js` —— 验「一键生成 SSH 密钥并部署」弹窗：拦 `/ssh-key`
  按 `window.__SSHKEY_MODE`（`ok` / `fail` / `verifyFail`）返回三种结果，
  断言四步状态、公钥/私钥可见、算法可选、默认备注、弹窗高度不变。
  `SHOT=1` 存图；`PROBE_VP=desktop|mobile` 单跑一个视口。
- `probe-command-overflow.js` —— 验「长命令不撑破界面、要换行、可弹窗查看全部」：
  390px 移动视口，喂一条 492 字符、含超长无空格 token 的命令，量
  `scrollWidth/clientWidth`（换行是否真生效）、默认折叠、`查看全部` 弹窗高度
  被夹住且正文内部滚动、内容完整可读。**已做反向验证**（换回旧 CSS 即变红）。
- `probe-ai-assistant-issues.js` —— 验 AI 助理「步数用尽提示条」与「完全授权往返」。
- `probe-image-preview.js` —— 验「文件管理里图片可预览」：假 SFTP（协议感知）+
  **canvas 现画一张真 PNG** 走二进制分片发回去，断言 `<img>` 真的解码成功
  （`naturalWidth > 0`，不是「弹窗打开了」）、`blob:` URL、灯箱出现、
  Esc 分层关闭（只关灯箱不关弹窗）、非图片仍走文本编辑器。
  已做反向验证（打破 `isImageFile` 即大面积变红）。
  同时演示了「必须先挂 server_list + terminal + file_manager 三个 widget」这条前置链。
- `render-real.js` / `shot.js` / `shot-color-and-import.js` —— 截图辅助。

**触发弹窗的菜单别猜**：右键菜单往往分「空白区」和「条目上」两套，项也不一样。
本项目的服务器列表：`.server-list-widget` 上右键 → 添加服务器 / 新建分组；
服务器行上右键 → 连接 / 选择 / 编辑 / 复制 / 删除。
点错地方会拿到 `no-item:连接|选择|编辑|...` 这种提示 —— 看提示就知道菜单拿对了没。

用法：
```bash
BASE_URL=https://<域名>/ node .workbuddy-ai/tools/mobile-render/probe-keybar.js 390 844 300
BASE_URL=https://<域名>/ node .workbuddy-ai/tools/mobile-render/probe-sftp-resume.js 390 844
BASE_URL=https://<域名>/ node .workbuddy-ai/tools/mobile-render/probe-session-retention.js
PROBE_BASE=https://<域名> node .workbuddy-ai/tools/mobile-render/probe-settings-dialog-height.js
PROBE_BASE=https://<域名> SHOT=1 node .workbuddy-ai/tools/mobile-render/probe-ssh-key-dialog.js
```
不带 `BASE_URL` / `PROBE_BASE` 时对着本地 `server/public` 起静态服务。
**先构建再跑本地**（`npm run build`），否则量的是旧产物。

### 截图脚本的两个坑

1. **别靠滚容器拍全，要调视口高度。** 高度由内容撑开的弹窗，
   `.xxx-content` 的 `scrollHeight === clientHeight`，`scrollTop` 永远是 0，
   滚动脚本看着「成功」其实什么都没滚，截图底部被切。
   把 `--window-size` 调高（实际生效高度会被屏幕夹住，1254x1594 是常见的上限）。
   改成固定高度之后反而好办：正常 `1280x900` 就够，且内层滚动真的能用了。
2. **假后端的数据必须和 fixture 自洽。** `PLAN.summary` 之类硬编码的返回值，
   要和上传文件的 fixture 对齐，否则截图里会同时出现「文件包含 0 个代理」
   和「代理 新建 2」—— 自己打自己脸，用户一眼就看出来。
