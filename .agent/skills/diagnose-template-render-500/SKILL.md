---
name: diagnose-template-render-500
description: 当把 EJS/模板渲染的项目从 ORM（Sequelize/TypeORM 等）移植到无 ORM 运行时（Cloudflare Workers/D1、边缘函数、纯 SQLite）后，后台页面开始整页 500、报「调用 的目标不是函数: undefined」或「模板里显示 undefined」时使用。给出「模板反向依赖扫描 → 区分服务端标签与客户端表达式 → 数据形态断言」三步定位法，并覆盖 hydrated 对象 camelCase 别名丢失、解释器三元急切求值两个高频陷阱。触发词：模板渲染 500、TemplateSyntaxError、调用 的目标不是函数、EJS 移植、模板上下文缺失、langName is not defined、JSON.stringify 丢字段。
agent_created: true
---

# 定位模板渲染 500：是「上下文缺失」还是「引擎语义缺陷」

## 先做一件事：别信报错信息指向的位置

这类故障的报错几乎总是同一个形态：

```text
TemplateSyntaxError: 调用 的目标不是函数: undefined 【表达式】xxx.map(...)
```

但报错指向的**表达式往往是受害者，不是元凶**。真正的根因通常在两个互不相干的地方：

| 根因 | 本质 | 修法 |
|---|---|---|
| **A 路由上下文缺失** | 模板需要某变量/helper，handler 没传 | 补 handler 的 render data，或集中注入 |
| **B 引擎语义缺陷** | 解释器行为与 JS 不一致（典型：三元非惰性） | 改解释器 + 补回归 |

A 和 B 会**叠加**：B 把 A 从「显示 undefined」放大成「整页 500」，
并且掩盖 A。先修 A 能让页面恢复，修 B 才能防止同类问题再炸整页。

## 第一步：模板反向依赖扫描（找出「模板要什么」）

不要靠读模板人肉找。写脚本扫全量模板，列出每个模板引用的**顶层标识符**，
再和 handler 实际传的 render data 做差集。

关键：**只看服务端标签**。`<% %>`、`<%= %>`、`<%- %>` 内的标识符才是模板作用域；
`{{ }}`、`:attr="..."`、`v-if` 是**客户端**模板（Vue/Alpine），同名函数多半是组件方法。

```js
const tagRe = /<%([=_#-]?)([\s\S]*?)%>/g;   // 捕获组 1 = '=' / '-' / '#' / 空
// 只处理 mode 为 '' 的普通 code 标签与 '=' / '-' 输出标签，跳过 '#'
```

⚠️ **最容易踩的坑**：同名函数同时出现在两处时，全文 `grep langName(` 会给出假阳性。
真实案例：`posts.ejs` 的 `langName(` 全在 Vue 表达式里（对应组件内定义的方法），
所以该页面**一直能渲染**；而 `pages.ejs` 用的是 `<%= langName(...) %>`，直接 500。
**不能因为某个页面能渲染，就推断这组 helper 不需要注入。**

## 第二步：用「不启动服务」的探针复现

直接调模板 store 渲染目标模板，手工注入候选上下文，二分找出缺哪个变量：

```js
import { registerSources, renderView } from '../src/core/template/store.js';
import { manifest } from '../src/core/template/manifest.generated.js';
registerSources(manifest);
try {
  const html = renderView('views/admin/pages.ejs', { ...base, ...data }, { layout: '...' });
  console.log('✅', html.length);
} catch (e) { console.log('❌', e.message); }
```

探针能过、真实路由 500 ⇒ **确定是上下文缺失（根因 A）**，不是引擎问题。
这一步能把「引擎 bug」和「路由 bug」彻底分开，省掉大量瞎猜。

## 第三步：检查数据形态，而不只是「字段有没有」

字段传了也可能读不到，有两个隐蔽陷阱：

### 陷阱 1：hydrated 行的 camelCase 别名是 non-enumerable

如果兼容层用 `Object.defineProperty(row, camel, { enumerable: false })` 补别名，
那么**模板内属性访问正常**（`post.langCode` ✅），但：

```js
{ ...post }              // ❌ 展开丢失所有 camelCase 别名
JSON.stringify(post)     // ❌ 只序列化 enumerable，别名全丢
```

而源项目用 ORM 时序列化出来就是 camelCase，前端模板读的正是 `group.main.langCode`。

**修法**：提供 `toClientDto(value)` —— 深拷贝纯对象并补上**可枚举**的 camelCase 键
（只增不删，幂等、向后兼容），凡是「DB 行 → JSON 注入前端模板」的地方都过一遍。

**反例禁令**：装配关联字段时**必须原地赋值**，不能展开：

```js
post.Categories = cats;                  // ✅ 别名仍在
const p = { ...post, Categories: cats }; // ❌ langCode/featuredImage 全丢
```

### 陷阱 2：解释器三元表达式急切求值

树遍历式解释器常见实现：

```js
const consequent = this.parseTernary();   // 已经求值了！
const alternate  = this.parseTernary();   // 也求值了！
return test ? consequent : alternate;     // 丢弃一个
```

于是 `post && post.Categories ? post.Categories.map(...) : []` 在条件为假时
仍然执行 `undefined.map(...)` → 抛错 → 整页 500。

**修法**：先扫出两个分支的 token 区间，只对选中的分支建子解析器求值。
扫描器只需做括号深度 + 嵌套三元深度计数，深度 0 处遇 `,` `;` `)` `]` `}` 或本层 `:` 收尾：

```js
scanExpressionEnd(start) {
  let depth = 0, ternary = 0, i = start;
  for (; i < this.tokens.length; i++) {
    const t = this.tokens[i];
    if (t.type !== 'punct') continue;
    const v = t.value;
    if (v === '(' || v === '[' || v === '{') { depth++; continue; }
    if (v === ')' || v === ']' || v === '}') { if (depth === 0) break; depth--; continue; }
    if (depth > 0) continue;                    // 括号内（含对象字面量的 : ）都算本分支
    if (v === '?') { ternary++; continue; }
    if (v === ':') { if (ternary === 0) break; ternary--; continue; }
    if (v === ',' || v === ';') break;
  }
  return i;
}
```

⚠️ 注意 `?.` 与 `??` 必须已在词法层拆成独立 token，否则会把它们误判成三元的 `?`。

顺带检查：数组/对象字面量的元素是不是也用了「不含三元」的解析函数
（如 `parseNullish()`）—— 那样 `[a ? 1 : 2]` 会解析失败。

## 第四步：断言必须覆盖「新建路径」和「JSON 键形态」

事故能藏住，几乎都是因为**测试只覆盖了有数据的编辑路径**：

- 只测 `/edit/:id`，不测 `/new` → `null` 上下文的分支永不执行
- 只断言 `res.status === 200`，不断言数据形态

有效的断言写法：

```js
// 1) 新建路径（null 上下文）
assert((await callAuth('/admin/posts/new')).status === 200);

// 2) 断言带引号的 JSON 键，防止 toClientDto 被回退
assert(/"langCode"\s*:/.test(body));   // ✅ 精确
assert(/langCode/.test(body));         // ❌ 会被代码里的 v.langCode 命中

// 3) 断言 helper 的真实产物，而不是它的名字
assert(body.includes('简体中文'));      // langName 解析结果
assert(/badge bg-success/.test(body)); // getStatusBadgeClass 产物
assert(!/langName\(/.test(body));      // ❌ 错：模板里的客户端函数定义会命中
```

## 顺带会暴露的引擎缺口：内联块语句

修完上面之后，日志里可能出现：

```text
[template] 语句执行失败: try { ... } catch(e) { ... } → 表达式尾部有未消费内容: "{"
```

含义：**单行 `<% %>` 里花括号自闭合的块语句（`if`/`for`/`try`/`function`）没被执行**。
引擎通常只把「块头以 `{` 结尾、跨模板块」的形态当块处理，自包含块会落到
「当普通表达式求值」的兜底分支，失败后被 catch 掉只记 warn ——
**渲染不报错，但那段逻辑完全没生效**（静默降级，最危险的一类 bug）。

量化影响面时注意：数花括号**必须跳过字符串字面量**，
否则 `startsWith('{')` 里的 `'{'` 会让括号计数失衡，把真实命中的模板漏掉。

### 修法（已实测）

在 `execSimpleStatement()` 的**兜底 catch 之前**接管（原先只 warn 的路径，
只可能改善、无行为回退）：识别不以 `{` 结尾、括号平衡的自包含块语句，
用「扫到深度 0 的分号 / 配对花括号」切出块体，逐条递归执行。

四个真正难的点（都踩过）：

1. **`return` 信号必须显式对象逐层传，且回调体是函数边界。**
   `if (x.status === 'disabled') return;` 要能让当前迭代提前结束。
   做法：`runTokens(tokens, scope, ctx, out, signal)` 带 `signal`；
   回调 `invoke` **每次迭代新建** `{returned, value}` —— 否则体内 `return`
   会外泄成「整页停止渲染」。**不要**用 `ctx` 上的全局标志（嵌套块会串味）。

2. **try 体内异常要上抛给 catch，判定必须看「调用时刻」。**
   函数体是「声明时捕获闭包、调用时才执行」，静态的 `inTry` 标记拿不到调用点。
   做法：`ctx.__inlineTryDepth` 深度计数，在兜底 catch 处
   `if (inTry || (ctx.__inlineTryDepth || 0) > 0) throw e;`。
   `finally` 里**任何路径**都要回退计数，否则后续语句被误判为「在 try 内」而炸页。

3. **catch 体不建子作用域。** JS 语义是 `catch (e) { m = 1 }` 改的是**外层** `m`。
   做法：临时把形参绑到原 scope、执行完还原（先 `hasOwnProperty` 记是否已存在）。

4. **块语句结束不一定有分号，主循环会把「块语句 + 后续语句」粘成一条。**
   `function f(){...} try { f() } catch(e){...}` 会被当成一条 →
   只执行第一条、**后半段静默丢弃**。做法：在 `splitStatements()` 加**后处理环**，
   对以块关键字开头的段落用「扫描单条语句结束位置」的函数重扫切开。

### 切分辅助必须避开的两个坑

- 扫描 `try {` / `if (` 时**必须先跳过关键字后的空白再找 `(`**，
  否则会把 `try` 本身当成整条语句、后面整块被丢弃。
- `if (x) r='y'; else r='n'` 里的**分号不能挡住 `else` 识别** ——
  扫描 else 前要跳过前导空白与分号。

### 断言（至少这几条）

- `if` 单语句体 + `else`（真 / 假各一条）
- `for` / `while` 内联块体
- `function name(){}` 声明并调用
- `return` 跳过本次迭代（跨模板块 `forEach` 内嵌内联 `if...return;`）
- `try` 正常路径 / `catch` 命中 / 嵌套 `try` / **try 后深度计数回退**
  （末尾故意放一条会失败的语句，断言被吞掉而不是炸页）
- 函数体在 try 内**调用**时异常可捕获
- 块语句之后的语句不丢失

## 交付前必跑的回归

```bash
node <模板引擎测试>          # 解析器用例全过
node <模板反向扫描脚本>       # 全量模板语法层失败为 0
node <集成测试>              # 端到端断言
```

引擎是最敏感组件：任何解析器改动都必须同时跑「语法层扫描」与「端到端」两层，
只跑单元用例不足以发现模板层面的回归。
