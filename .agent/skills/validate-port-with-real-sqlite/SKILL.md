---
name: validate-port-with-real-sqlite
description: 当把一个 ORM/Web 框架项目（Sequelize、TypeORM、ActiveRecord、Django ORM、Prisma 等）移植到另一种运行时（Cloudflare Workers/D1、SQLite、边缘函数）时使用。用真实 SQLite（better-sqlite3 内存库）跑「真 schema + 真 ORM 层 + 真入口 fetch()」的集成测试，把 mock 测不出来的移植 bug 一次抓出来。触发词：移植 ORM、Sequelize 迁移、D1 移植、Workers 重写、SQL 列名对不上、跨租户泄漏、site_id 隔离、不支持的操作符。
agent_created: true
---

# 用真实 SQLite 验证 ORM/框架移植

## 核心判断

**只断言「生成的 SQL 字符串长什么样」的测试，测不出移植 bug。**
必须让真实 SQLite 执行真实 schema，才能抓住列名错、绑定顺序错、方言差异、
约束触发、租户隔离失效。

## 为什么必须有这一层

mock/字符串断言漏掉的，恰恰是最容易炸的：

| 漏掉的问题 | 真实症状 |
|---|---|
| 列名与 schema 对不上 | `no such column: xxx` |
| 绑定参数顺序错 | 查询结果静默错误 |
| 方言差异 | CHECK/UNIQUE 约束行为不同 |
| 租户/站点隔离字段漏过滤 | **跨租户数据泄漏**（最危险，且不报错）|
| 调用形态不兼容 | `不支持的操作符: <字段名>` |

## 搭 shim 的关键点（Cloudflare D1 为例）

D1 就是 SQLite，所以 **better-sqlite3 内存库能高度还原线上行为**。

```js
// ⚠️ 最大的坑：NODE_PATH 只对 CommonJS require 生效，ESM import 完全忽略它
// 若依赖装在隔离工作区，必须用 createRequire 显式解析
import { createRequire } from 'node:module';
const req = createRequire(path.join(WORKSPACE_NODE_MODULES, 'noop.js'));
const Database = req('better-sqlite3');
```

必须实现的 D1 API 子集：

- `db.prepare(sql).bind(...args).first() / .all() / .run()`
- `db.batch([stmts])` —— **用 `better-sqlite3` 的 `transaction()` 包一层**，
  才能还原 D1 batch 的原子性（源项目初始化依赖这个）
- `db.exec(sqlScript)` —— 跑真实 schema 文件
- `run()` 必须返回 `meta.last_row_id`（Repository 靠它拿自增 id）
- `bind()` 必须**返回新语句**而不是就地修改（D1 语义）
- `undefined` 参数要转成 `null`（better-sqlite3 不接受 undefined）

用 `PRAGMA foreign_keys = ON` 对齐 D1。

## 五类必测断言

### 1. Schema 真的建起来了

```js
const names = db._rawAll("SELECT name FROM sqlite_master WHERE type='table'").map(r=>r.name);
// 逐表断言关键列存在（PRAGMA table_info(posts)）
```

### 2. ORM 层全方法闭环

`create` 后要断言 **自增 id 回填**；`update`/`destroy` 后要**读回验证**，
不能只看影响行数。

### 3. 【最关键】租户隔离 fail-closed

```js
// 建两个 tenant，各插数据，互相查不到
// 并断言：无租户上下文时**抛错**而不是返回全量
let threw = false;
try { await Repo.findAll(); } catch { threw = true; }
assert(threw, '无租户上下文必须 fail-closed');
```

**再加一条防回归**：遍历 schema 找所有带租户列（如 `site_id`）的表，
凡未标 `scoped` 且不在显式白名单里的就 fail。白名单每项必须写理由。
这一条能挡住「新加表忘了标隔离」导致的静默泄漏。

### 4. 调用形态兼容（移植可行性前提）

源项目写 `findAll({ where, order, limit })`（options 包一层），
新 ORM 层写 `findAll(where, options, ctx)` —— **两种都必须支持**。
否则从源项目抄来的每个调用点都会挂。典型症状：顶层键 `where` 被当成
操作符解析 → `不支持的操作符: <某字段名>`。

修在新层（加 `normalizeArgs`），不要在几十个调用点各改一次 ——
否则以后每次从源项目抄代码都会再犯。

### 5. 入口端到端

真的 `new Request()` 喂给 `worker.fetch(request, env, ctx)`，
断言每个路由 `status < 500`。**用 `< 500` 而不是 `=== 200`**，
这样 404/302 等正常分支不会误报，而崩溃一定被抓到。

## 值转换陷阱

SQLite 只接受 `number / string / bigint / Buffer / null`：

- **布尔必须转 0/1**，否则 `SQLite3 can only bind numbers, strings, ...`
  在 INSERT/UPDATE/WHERE **三处**都要转 —— 只在写路径转是最常见的疏漏。
- Date → 毫秒整数（与 `INTEGER` 时间戳列对齐）
- `undefined` → `null`
- 普通对象 → `JSON.stringify`

## 环境准备

```bash
# 依赖装进隔离工作区，不污染用户环境
cd <WORKSPACE_NODE_MODULES>/..
npm install better-sqlite3
# 运行时用 NODE_PATH 或 createRequire 指定
```

不需要网络、不需要 wrangler，就能把业务逻辑测到位。

## 无 wrangler 时的打包前置校验

wrangler 是几十 MB 的依赖。在没装的环境里，用纯 Node 做等价的**静态体检**
能挡住绝大多数问题：

1. **模块图完整性** —— 所有相对 import 都能解析（含 `.js` 补全、`index.js`）
2. **禁用 API** —— `require()` / `fs` / `path` / `child_process` / `process.env` /
   `__dirname` / `Buffer` / `eval` / `new Function`
3. **变量路径动态 import** —— 打包器无法处理
4. **入口契约** —— 真的 `import` 一次，断言 `fetch` 存在
5. **生成产物存在且非空**

⚠️ 写扫描器时**必须先剥注释**（`/* */` 与 `//`）。否则文档里写的
「源项目用 `require(x)`，我们改成……」会被当成真实代码误报。
剥行注释的正则要小心别误伤 `http://` 这类字符串：
`line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')`

## 落地顺序建议

先搭 shim → 加「schema 建起来了」一条断言 → 立刻跑。
**第一条断言就会炸**，那个错误就是真 bug。逐个修完，隔离/端到端断言
自然会带出更多。

## 常见坑速查

- `NODE_PATH` 对 ESM 无效 → 用 `createRequire`
- 外键约束会挡住 seed（`author_id: 1` 但没建作者）→ 先 seed 依赖行。
  这是**好事**，证明外键真的生效
- 测试断言用错章节顺序 → 在 A 节断言 B 节才 seed 的数据
- `_mergeSiteWhere` 判定顺序：**先尊重显式 `where.tenant_id`，再查 ctx**。
  顺序反了会把「已带隔离条件的合法调用」误拒
- 断言写错时先怀疑是测试错而不是代码错，用最小复现脚本独立验证
