---
name: diagnose-silent-style-loss
description: 当页面渲染「正常」（HTTP 200、无 JS 异常）但样式完全不生效，或控制台出现「Tags with side effect (<script> and <style>) are ignored in client component templates」/「Failed to resolve component: router-view」这类前端框架警告时使用。诊断「自包含完整 HTML 文档被套进 layout 模板」导致内联 <style>/<script> 落进 Vue/React 挂载容器而被静默丢弃的问题。含一条命令定位法、结构性修法与可落测的回归断言。触发词：样式没生效、CSS 不管用、样式全丢、样式都没起作用、Vue warn、tags with side effect、layout 套错、两个 DOCTYPE、router-view 未解析、白板页面。
agent_created: true
---

# 页面 200 但样式全丢：自包含文档被套进了 layout

## 症状三件套（认准这个组合）

1. **页面能打开、内容也在，但完全没有样式**（裸 HTML）；
2. 控制台有前端框架警告：

   ```text
   [Vue warn]: Template compilation error: Tags with side effect
   (<script> and <style>) are ignored in client component templates.
     at <App>
   ```

   或 React 侧的等价提示 / `Failed to resolve component: router-view`；
3. **报错行号远大于该模板自身的行数**（例如 `login:1816`，而 `login.ejs` 只有 512 行）。

第 3 条是关键旁证：它说明**页面 HTML 是「两份文档叠在一起」**。

## 一条命令定位

```bash
curl -s http://127.0.0.1:PORT/<page> -o page.html
echo "DOCTYPE: $(grep -c '<!DOCTYPE' page.html)   layout容器: $(grep -c 'content-area' page.html)   #app: $(grep -c 'id=\"app\"' page.html)"
grep -n '<style\|</head>\|<body>\|id="app"' page.html   # 看 <style> 在 #app 之前还是之后
```

判读：

| 观测 | 含义 |
|---|---|
| `DOCTYPE` ≥ 2 | **确诊**：layout 和页面各带了一份完整文档 |
| 出现 layout 独有的容器 class（如 `content-area`） | 页面被套进了 layout |
| `<style>` 的行号 **大于** `id="app"` 的行号 | `<style>` 落在挂载容器内 → 被框架丢弃 |
| `id="app"` ≥ 2 | 挂载点嵌套（layout 一个 + 页面一个） |

## 根因

模板层把「片段」和「完整文档」一视同仁地套了 layout：

```text
renderAdmin(view)  →  ctx.render(view, data, { layout: 'views/admin/layout.ejs' })
```

而 layout 的结构是：

```html
<main class="content-area" id="app">
  <%- body %>          <!-- ← 页面内容插在 Vue 挂载点**内部** -->
</main>
```

一旦 `view` 本身是**自包含完整文档**（自带 `<!DOCTYPE>/<html>/<head>/<style>/<script>`），
它的 `<style>` 和 `<script>` 就全都落进了 `#app` 里。前端框架用 `#app` 的
`innerHTML` 当模板编译时，**会直接忽略 `<style>`/`<script>`** —— 于是样式消失，
但请求仍是 200、也没有 JS 抛错。

> 源项目的正确语义通常是**显式**关掉 layout：
> `res.render('admin/login', { layout: false })`。
> 移植时若把「套 layout」封装成一个不接收开关的 helper，这个语义就被抹掉了。

## 修法：按**结构事实**判定，而不是靠调用方记得传参

```js
function renderAdmin(ctx, viewPath, data, opts = {}) {
  // 自包含完整文档不能套 layout
  const fullDocument = opts.layout === false || isFullDocumentTemplate(viewPath);
  return ctx.render(viewPath, data, {
    ...opts,
    layout: fullDocument ? null : 'views/admin/layout.ejs',
  });
}

/** 模板源码是否为自包含完整 HTML 文档 */
function isFullDocumentTemplate(viewPath) {
  if (!hasSource(viewPath)) return false;
  const src = getSource(viewPath);
  return typeof src === 'string' && /^\s*<!DOCTYPE/i.test(src);
}
```

为什么用自动判定而不是逐个调用点补 `layout: false`：

- 错误页（`error.ejs`）、安装向导、打印页等**往往也是自包含文档**，
  逐个补漏一定会漏；
- `<!DOCTYPE` 是客观结构事实，判定不会误伤片段模板（片段首行是 `<div>` 之类）。

先摸清全集，再决定：

```bash
# 哪些视图是完整文档（需要 layout:false）？
grep -l "<!DOCTYPE" views/**/*.ejs
# 源项目里哪些渲染点显式关掉了 layout？
grep -rn "layout: false" routes/
```

两边应当对得上。

## 预防：把它写成结构断言，而不是 `status < 500`

`status < 500` 会放过 302/404，也会放过「200 但结构错乱」。写精确断言：

```js
const res = await call('/admin/login');
const body = await res.text();
assert(res.status === 200);
assert((body.match(/<!DOCTYPE/gi) || []).length === 1, '出现两个 DOCTYPE → 被套了 layout');
assert(!body.includes('content-area'), '出现了 layout 的容器 → 被套了 layout');
assert(body.search(/<style/i) < body.search(/id="app"/), '<style> 落在 #app 内 → 会被 Vue 丢弃');
assert((body.match(/id="app"/g) || []).length === 1, '挂载点嵌套');
```

## 泛化（不止 Vue / 不止 EJS）

同样的机制会出现在：

- React / Svelte / Angular 用挂载容器 `innerHTML` 作模板时；
- 任何「layout/母版页 + 内容槽」的模板系统（EJS layout、Blade `@yield`、Jinja `{% block %}`）；
- 静态站点生成器把「完整文档」当 partial 嵌入时。

判据始终一样：**挂载容器内部不应出现 `<style>`/`<script>`/第二份 `<!DOCTYPE>`**。

## 相邻陷阱（排查时顺手查一下）

同一类「静默降级」往往还伴随别的单位/语义错误。本次就顺带查出：

- **Cookie 生命周期对不上 JWT**：`res.cookie` 的 `maxAge` 是**毫秒**，
  而 Web `Max-Age` 是**秒**；桥接层做 `/1000` 换算时，调用点若按「秒」传值
  （如 `60*60*24*7`）→ 实际只有 604 秒（约 10 分钟）。
  验证：`curl -D - -o /dev/null -X POST .../login | grep -i set-cookie`，看 `Max-Age` 是否为预期值。
