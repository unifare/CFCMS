# CFCMS 底层架构规划

> 状态：**设计定稿，已开始实施**（批次 1 部分完成，见 §8）
> 参照实现：`D:\1Dev\nodecms\nodecms`（Node + Express + Sequelize 版，已跑通多主题/多语言/插件/主题自有表）
> 本文回答四个问题：**多语言怎么做、主题如何变成业务包、插件边界在哪、怎么防止"功能实现了但是垃圾代码"**。
>
> 配套文件：[`AGENTS.md`](../AGENTS.md)（压缩成硬规则，供 AI 直接遵守）、
> [`tests/architecture.test.mjs`](../tests/architecture.test.mjs)（规则的机器执行）。

---

## 0. 先说结论：三条设计主线

在看具体方案之前，先明确这份规划的三个不可动摇的立场。后面每一节都是它们的展开。

**主线一：分层，且层与层之间只通过声明通信。**

一个功能属于哪一层，看它的生命周期归谁管：

| 生命周期 | 归属 | 例子 |
|---|---|---|
| 随平台发布/升级 | **平台核心** | 文章、页面、用户、权限、多语言开关 |
| 随主题启用/停用 | **主题** | 产品、订单、房产、宠物档案 |
| 随插件启用/停用 | **插件** | SEO、短代码、支付网关 |

主题和插件**永远不直接读写对方的表**，也不直接调用对方的函数。它们各自向平台**声明**自己要什么，平台负责兑现。这条守住了，主题和插件才能各自独立安装、卸载、升级而不互相炸掉。

**主线二：能力靠"声明 + 平台兑现"，不靠"主题自己写 SQL"。**

这是 Cloudflare Workers 平台的硬约束逼出来的，但恰好也是更好的设计。Workers 禁止 `eval` / `new Function` / 动态 `import()` 用户代码（V8 isolate 限制，不是本项目偷懒）。所以主题**不能**携带可执行 JS 在主 Worker 里跑。

于是主题描述"我要一张产品表，字段是这些"，平台建表、建 API、建后台界面。主题负责的只是**长什么样**（模板）和**什么时候用什么数据**（路由 + 查询声明）。

**主线三：所有"约定"都必须有机器强制，不能只写在文档里。**

这是用户最关心的一点——"一个很蠢的 AI 加个功能，功能实现了，但是是垃圾代码"。文档管不住 AI，**测试和类型才能**。所以本规划里每一个"应该"，都要落到下面四种机制之一：

1. **类型约束**——写错编译不过（`tsc --noEmit`）
2. **清单校验**——声明不合法就装不上（`validateManifest`）
3. **契约测试**——行为不对测试就红（`npm test`）
4. **架构测试**——越界就失败（分层依赖方向检查）

没有落到这四种里的"规范"，一律视为**没有规范**。

---

## 1. 现状诊断

### 1.1 CFCMS 已有什么

代码量约 4340 行 TypeScript，已经具备相当完整的地基：

| 已具备 | 文件 | 评价 |
|---|---|---|
| 模板引擎（无算术、10 个 helper、`@section` 插槽） | `src/rendering/template-engine.ts` (839 行) | 够用，约束明确 |
| 主题清单 + 能力落实 | `src/extensions/theme/runtime-declarative.ts` + `capabilities.ts` | **设计正确**，是本次规划的起点 |
| L3 主题 Worker 沙箱 | `src/extensions/theme/runtime-worker.ts` (429 行) | 难得，能力受控的回调 API |
| 插件 hook 运行时 | `src/extensions/plugin/runtime.ts` | 注册表 + 受控 facade，方向对 |
| 多站点（host / path_prefix） | `src/platform/sites.ts` | 已贯穿 `site_id` |
| 多语言**骨架** | `migrations/0001` 的 `locales` / `post_translations` | 有表，但缺"开关"层 |
| 清单校验 | `src/extensions/security.ts` | 已逐字段校验主题清单 |

**最重要的一点**：CFCMS 的主题声明模型（`postTypes` / `taxonomies` / `fields` / `routes` / `adminMenus` / `blocks` / `settings`）与 nodecms 的 `theme.json` + `models.js` 是**同一个思路**，只是 CFCMS 更早把它做进了 Worker 平台约束里。所以这次不是推倒重来，是**把已有骨架补全成完整体系**。

### 1.2 缺什么（本次要补的）

| 缺口 | 现状 | 后果 |
|---|---|---|
| **多语言没有"平台开关"** | `locales` 表存在，但没有任何"某主题的多语言是否启用"的概念 | 用户明确要求的核心机制缺失 |
| **主题自有表无处声明** | 主题只能声明 CPT（复用 `posts` 表），不能声明真正独立的表 | 商城主题的产品只能塞进 `posts`，字段一多就崩 |
| **主题菜单只是"链接"** | `theme_admin_menus.screen` 只允许 7 个固定值，主题不能注册真实后台页面 | 主题的后台管理界面无法存在 |
| **插件不能注册后台菜单** | `adminMenus` 只在主题清单里被读取 | 插件想做后台页面没门 |
| **内容多语言是半成品** | `post_translations` 有表，但没有"翻译组"概念、没有后台联动 | 无法管理"这篇文章的英文版" |
| **没有防烂代码机制** | 只有 `tsc` 和功能测试 | 用户最担心的问题无人守 |
| **目录结构混乱** | 见 §7 | 认知负担高，AI 容易放错位置 |

### 1.3 从 nodecms 学到的、要修正的东西

参照实现在这些地方踩了坑，规划里必须绕开：

| nodecms 的问题 | 证据 | CFCMS 的修正 |
|---|---|---|
| **`beforeFind` 全局 hook 注入语言过滤** | `models/index.js:200-217` | **不用**。魔法式全局注入让"为什么查不到数据"变得无法调试。改为**显式传 locale**（CFCMS 现状已是对的） |
| **主题模型直接挂主 sequelize** | `themes/eShop/models.js` 用 `eshop_` 前缀 | 前缀是**约定**不是**强制**，AI 很容易忘。改为**由平台按主题名强制生成表名** |
| **主题自带 `admin-routes.js` 自行鉴权** | `themes/eShop/admin-routes.js:16-30` 自己 `jwt.verify` | 每个主题重写鉴权 = 必然有主题写错。改为**平台统一鉴权，主题只声明权限点** |
| **`theme-manager` 四种取主题路径层层兜底** | `core/theme-manager.js:33-79` | 过度兜底掩盖了 `theme.active` 缺失的真 bug（CFCMS 上一轮刚修过同类问题）。**单一真相，取不到就报错** |
| **主题能抄插件、插件能抄主题** | 无边界检查 | 加**架构测试**禁止 |

---

## 2. 多语言架构（核心章节）

这是最复杂的一块，也是用户明确点名的重点。**关键洞察：多语言不是一层的概念，是四层。**

先看分层，再逐层展开。

### 2.1 四层模型

```
┌─────────────────────────────────────────────────────────────┐
│ L0  平台开关层    locales / site_locales                     │
│     决定这个站点"支持哪些语言"，是后面三层的前提             │
├─────────────────────────────────────────────────────────────┤
│ L1  内容语言层    post_translations / content_groups        │
│     平台拥有的内容（文章、页面）的多语言版本                 │
├─────────────────────────────────────────────────────────────┤
│ L2  界面语言层    i18n packs（核心 / 插件 / 主题 / DB 覆盖） │
│     菜单、按钮、提示文案的翻译                               │
├─────────────────────────────────────────────────────────────┤
│ L3  主题业务语言层  主题自有表的翻译（产品、房产…）          │
│     只有该主题的多语言被启用时才存在                         │
└─────────────────────────────────────────────────────────────┘
```

**用户说的"某个主题的多语言要在平台的多语言里开启了才能起作用"，指的就是 L0 → L3 的联动。** 下面逐层说清。

### 2.2 L0：平台开关层

两张表，职责分明：

```sql
-- 平台级：这个部署认识哪些语言（语言字典，不是开关）
-- 已有，扩两列
CREATE TABLE locales (
  code       TEXT PRIMARY KEY,        -- 'zh-CN' / 'en' / 'ja'
  name       TEXT NOT NULL,           -- '简体中文' / 'English' / '日本語'
  native_name TEXT,                   -- '简体中文'（语言切换器用它，不用 name）
  direction  TEXT NOT NULL DEFAULT 'ltr',  -- 'ltr' / 'rtl'
  is_default INTEGER NOT NULL DEFAULT 0,
  enabled    INTEGER NOT NULL DEFAULT 1,   -- 新增：平台是否启用（全局）
  sort_order INTEGER NOT NULL DEFAULT 0    -- 新增：切换器排序
);

-- 站点级：这个站点启用哪些语言 + 默认是哪个
CREATE TABLE site_locales (
  site_id   TEXT NOT NULL,
  code      TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,   -- 每个站点各自一个默认语言
  enabled   INTEGER NOT NULL DEFAULT 1,    -- 站点级开关
  PRIMARY KEY (site_id, code)
);
```

**为什么必须分两层**：多站点部署下，`locales` 是"这台机器装了哪些语言包"，`site_locales` 是"这个站点对外露哪几个"。一个部署里，中文站和英文站可以各露各的。CFCMS 已有 `sites` 表，这一步是自然延伸。

**`native_name` 为什么单独一列**：语言切换器上要写"简体中文"而不是"Simplified Chinese"——后者对中文用户毫无意义。这个是通用 i18n 实践，不是过度设计。

**每个站点一个默认语言**（不是全局一个）：这是 nodecms 的 `settings.siteLanguage` 做对了的地方，保留。

### 2.3 L1：内容语言层（平台内容）

**范围**：文章（`post`）、页面（`page`）——即用户说的"目前平台就只有文章，页面有多语言吧"。

现状是 `posts` + `post_translations` 已经分离了。这个结构**是对的**，只需要补一个"翻译组"概念：

```sql
-- posts 表：加两列
ALTER TABLE posts ADD COLUMN lang_group TEXT;   -- 同一内容的各语言版本共享
-- 已有 slug / type / status / site_id，slug 不再全局唯一

-- 唯一约束改为：同一站点 + 同一类型 + 同一 slug，全局唯一（跨语言也唯一）
-- 理由见下方"设计决策"
CREATE UNIQUE INDEX idx_posts_site_type_slug ON posts(site_id, type, slug);

-- post_translations：已有，保持
--   (post_id, locale) UNIQUE，存 title/excerpt/content
```

> ⚠️ **现状核对（2026-09-28 实测真实本地 D1）**：`posts` 表当前**没有任何 slug 唯一约束**，
> 只有 `idx_posts_slug`（普通索引）。应用层 `savePost` 也不做冲突检查，
> `findContent` 用 `LIMIT 1` 静默取第一条。
> 也就是说 —— **今天两个内容可以占同一个 slug，前台会静默只显示其中一个**。
> 所以这里不是"收紧一个已有约束"，而是**第一次真正加上约束**；
> 加之前要先写数据清理（找出并合并重复 slug），否则迁移会因唯一索引创建失败而中止。
> 这个检查也提醒：**`docs/` 里关于 schema 的断言必须对着真实库验一遍再写**，
> 不能照抄设计意图——本段的唯一索引就属于"计划中、尚未存在"。

**设计决策：为什么每个语言版本是独立的 `posts` 行，而不是一行多列**

| 方案 | 优点 | 缺点 | 采用 |
|---|---|---|---|
| A. 每个语言一行 + `lang_group` 关联 | slug/status/published_at 天然按语言独立；URL 天然独立；翻译可独立发布（英文版先上、中文版还没写完） | 需要在应用层维护组 | ✅ **采用** |
| B. 一行多列（`title_en`, `title_zh`） | 查询简单 | 加语言要改表结构；无法独立发布；语言数一多列爆炸 | ❌ |

关键理由是**独立发布**。多语言站点最常见的需求是"英文版已经上线，日文版还在翻译"。方案 B 做不到。额外好处：独立 slug 让 `/en/about-us` 和 `/zh/关于我们` 都自然成立。

**`slug` 唯一性为什么收紧到跨语言唯一**：nodecms 的做法是 `(slug, lang_code)` 唯一，允许 `/en/about` 和 `/zh/about` 共用 `about`。看起来方便，但会导致**同一站点下两个语言版本抢同一个无前缀 URL**——而 CFCMS 支持无前缀访问（`/about` 走默认语言）。这必然产生歧义。收紧后，谁先占 `about` 谁得，另一个必须换 slug，语义清晰。这是一个**有意偏离参照实现**的决定。

**翻译组管理（后台交互）**：

后台编辑页需要一个"语言版本条"：

```
[ 简体中文 ● ] [ English ○ ] [ 日本語 ＋ ]
     当前         已存在      未创建
```

- 点已存在的语言 → 切到该版本编辑
- 点 `＋` → 弹窗：**创建翻译**（复制当前版本作为初稿）/ **仅切换**（跳到空白的该语言） / 取消
- 保存时若当前语言版本不存在，**自动创建**（不覆盖原文）

这套交互 nodecms 已经验证过（`docs/i18n/02-content-i18n.md`），直接照搬思路，但**实现上不依赖 ORM hook**。

**查询层：显式传 locale，不用全局 hook**

这是对 nodecms 的**明确修正**：

```ts
// ✅ CFCMS 做法：每个数据访问函数显式收 locale
export async function findContent(env, type, slug, locale, siteId) { ... }

// ❌ nodecms 做法：beforeFind 全局注入
// models.Post.beforeFind(o => { o.where = {...o.where, langCode: getCurrentLang()} })
```

理由：全局 hook 看起来"零调用点改动"很优雅，但它让**调试变成噩梦**。当后台列表页查不到数据时，你必须先想起存在全局 hook，再想起当前语言上下文是什么，才能开始排查。显式参数虽然啰嗦，但**读代码就能知道会发生什么**。上一轮修的 `activeTheme` 隐式兜底 bug 就是同一个教训。

### 2.4 L2：界面语言层

这一层 nodecms 做得相当完整，**四层翻译字典叠加**的设计直接采纳：

```
① 核心语言包     langs/{lang}.json              平台自带文案
② 插件语言包     plugins/{name}/langs/{lang}.json  插件启用时注册
③ 主题语言包     themes/{name}/langs/{lang}.json   主题启用时注册
④ 数据库覆盖     settings 表 i18n.overrides        后台可改，优先级最高
```

后层覆盖前层。查找不到时**回退 key 本身**——永不空白，这个兜底是对的（它兜的是"文案没翻译"，不是"系统状态未知"，性质完全不同）。

**关键点：界面语言 ≠ 内容语言。** 这两者必须彻底分开：

| | 内容语言 (contentLang) | 界面语言 (uiLang) |
|---|---|---|
| 管什么 | 前台文章/页面显示哪个语言版本 | 后台菜单、按钮、提示文案 |
| 谁决定 | 访问者（URL 前缀 / cookie） | 管理员个人偏好 |
| 典型场景 | 英文用户看 `/en/post` | 中文站长管理英文站 |

一个中文站长管理一个纯英文站点，是**完全正常**的配置。如果合成一个语言，这个场景就崩了。CFCMS 目前没有界面语言概念，要新增：`users.ui_lang` 列 + cookie 回退 + 站点默认。

**翻译函数签名**（模板与 JS 侧统一）：

```ts
__('theme.aurora.nav.home')                    // → "首页"
__('admin.posts.count', { n: 42 })             // → "42 篇文章"
```

**key 命名规范**（强制，由架构测试检查）：

```
core.*            平台界面文案          core.admin.save
theme.{slug}.*    主题文案              theme.aurora.nav.home
plugin.{slug}.*   插件文案              plugin.seo.meta.title
```

**为什么前缀必须强制**：两个主题各自有一个叫 `nav.home` 的 key，同站切换时会互相覆盖。前缀把命名空间隔离了。这个是**必须机器检查**的（扫描所有 `langs/*.json` 的 key 前缀是否符合所属目录），写进文档没用。

### 2.5 L3：主题业务语言层（本规划的重点）

现在是回答用户问题的核心：**主题自己的数据怎么多语言，且为什么必须平台开关。**

#### 2.5.1 问题陈述

一个商城主题有 `product` 表，标题"iPhone 15"要翻译成"iPhone 15"（英文）和"アイフォン15"（日文）。这个多语言：

- **不属于平台**——平台不认识"产品"这个概念（用户原话："产品默认不属于平台系统的"）
- **属于主题**——只有商城主题在用时才存在
- **但必须受平台控制**——用户原话："某个主题的多语言要在平台的多语言里开启了才能起作用"

#### 2.5.2 设计：`theme_locale_tables` 声明 + 平台生成翻译表

主题在清单里声明哪些自有表需要多语言：

```json
{
  "name": "eshop",
  "title": "EShop",
  "version": "1.0.0",
  "tables": [
    {
      "name": "product",
      "label": "Product",
      "translatable": ["name", "description", "content"],
      "fields": [
        { "key": "price",  "type": "number", "label": "Price" },
        { "key": "stock",  "type": "integer", "label": "Stock" },
        { "key": "sku",    "type": "text",   "label": "SKU" }
      ]
    },
    {
      "name": "product_category",
      "label": "Product Category",
      "translatable": ["name", "description"],
      "fields": [
        { "key": "sort_order", "type": "integer", "label": "Order" }
      ]
    }
  ]
}
```

平台据此**按需生成**：

```sql
-- 主表：非语言相关的数据（价格、库存——不随语言变）
CREATE TABLE theme_eshop_product (
  id          TEXT PRIMARY KEY,
  site_id     TEXT NOT NULL,
  slug        TEXT NOT NULL,          -- 平台生成：本地化 URL 用
  lang_group  TEXT NOT NULL,          -- 平台生成：翻译组
  price       REAL,                   -- 声明式字段
  stock       INTEGER,
  sku         TEXT,
  status      TEXT NOT NULL DEFAULT 'draft',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE(site_id, slug)
);

-- 翻译表：只有主题声明为 translatable 的字段
CREATE TABLE theme_eshop_product_i18n (
  row_id     TEXT NOT NULL,
  locale     TEXT NOT NULL,
  name       TEXT,
  description TEXT,
  content    TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (row_id, locale)
);
```

**这个设计的三个要点：**

**要点一：表名由平台强制拼装，主题不能自由命名。**
格式固定为 `theme_{themeName}_{tableName}`。主题声明里 `name` 只能是小写标识符（复用 `validExtensionName`）。**AI 忘记加前缀这件事在物理上不可能发生**——它根本没机会写表名。

**要点二：`translatable` 决定哪些字段进翻译表。**
这是设计的精髓。`price` 不该多语言，"iPhone 15" 该。如果一股脑把所有字段都做多语言，价格会被翻译成不同值，产生"英文站打 8 折"这种灾难。**声明式地划清"语言相关"与"语言无关"，是这个模型最重要的价值。**

**要点三：翻译表在主表多语言未启用时不存在。**
这就是用户要的"平台开关"。流程：

```
管理员在平台「语言」页启用 en
        ↓
site_locales 插入 (default, 'en')
        ↓
平台扫描所有已激活主题的 tables[].translatable 声明
        ↓
对每个有 translatable 字段的表，若该站点已启用 ≥2 种语言 → 建 {table}_i18n 表
        ↓
主题的多语言「生效」
```

反过来，如果站点只有一种语言（`site_locales` 里 enabled 的只有一条），平台**不建** `_i18n` 表，主题的所有查询走单语言简化路径。这既是性能优化，也让"没开多语言时系统简单"成为可验证的事实。

#### 2.5.3 主题如何读写自己的表

主题**不写 SQL**。平台提供受能力约束的 facade：

```ts
// 主题 Worker 沙箱内可用的 API（经 env.HOST 回调）
const products = await host.table('product').list({ locale, limit: 20 });
const product  = await host.table('product').bySlug(slug, locale);
await host.table('product').save({ slug, price: 299, name, description }, locale);
```

平台侧实现要点：

- `host.table('product')` 里的 `'product'` 必须**在该主题清单里声明过**，否则直接抛错。这防止主题访问别的主题的表。
- 单语言模式下 `locale` 参数被忽略，直接读主表。
- 多语言模式下 `list({locale})` 做 `LEFT JOIN`，缺失翻译回退到默认语言（与 L1 的降级策略一致）。

**回退策略统一**：全系统所有多语言查询都遵循"**当前语言 → 站点默认语言 → 空**"，不抛错。理由：内容没翻译是常态，不是错误。抛错会让一个未翻译的产品导致整页 500。

### 2.6 多语言解析：URL 语义（统一规则）

这是最容易出错的地方，单独定死。CFCMS 现状（上一轮刚整改）已经是正确方向，这里正式化：

**URL 规则**

```
/{locale}/...     显式指定语言
/...              无前缀 → 站点默认语言，找不到再尝试其他语言
```

**解析优先级**（从高到低）：

1. URL 显式前缀（`/en/about`）—— 访问者明确表达了意图，**不再回退到别的语言**
2. `?lang=` 查询参数 —— 供无头 API 与预览使用
3. cookie —— 记住访问者上次选择
4. `site_locales.is_default` —— 站点默认

**关键细节：显式前缀 vs 无前缀，回退行为必须不同**

| 请求 | 找不到时 | 理由 |
|---|---|---|
| `/en/about` | **404** | 访问者说了要英文，给他中文是欺骗 |
| `/about` | 尝试其他语言 | 访问者没表达偏好，给什么都比空白好 |

这个区分在 CFCMS 现有实现（`src/index.ts:234-243`）里已经做对了，写进规范固化下来。

### 2.7 实施清单

| 步骤 | 内容 | 涉及文件 |
|---|---|---|
| M1 | `locales` 加 `native_name/direction/enabled/sort_order`；新建 `site_locales` | `migrations/0011_i18n.sql` |
| M2 | `posts` 加 `lang_group`；slug 唯一约束收紧 | 同上 |
| M3 | `users` 加 `ui_lang` | 同上 |
| M4 | 新建 `i18n_overrides` 存 DB 覆盖层（或复用 `settings`） | 同上 |
| M5 | 核心 i18n 模块：`pack` 注册表 + `__()` + 语言解析 | `src/core/i18n.ts` |
| M6 | 界面语言注入（后台 API + admin SPA） | `src/api.ts`, `public/admin/` |
| M7 | 内容翻译组 CRUD API + 后台语言版本条 | `src/api.ts`, admin |
| M8 | 主题 `tables[]` 声明解析 + 建表 | `theme-capabilities.ts` |
| M9 | 主题表 facade + 沙箱 API 端点 | `theme-worker-runtime.ts` |
| M10 | 语言包 key 前缀架构测试 | `tests/` |

---

## 3. 主题架构

### 3.1 主题的三层形态

CFCMS 已经明确支持两种运行时，规范里正式定名：

| 层 | 名称 | 形态 | 自由度 | 用在哪 |
|---|---|---|---|---|
| **L2** | 声明式主题 | `theme.json` + HTML 模板 | 模板语法内 | 内容站、博客、企业站 |
| **L3** | Worker 主题 | 额外带 `worker.js`，跑在沙箱 isolate | 任意 JS | 复杂交互、商城、需要自定义逻辑 |

**L2 是默认，L3 是逃生舱。** 大部分主题不需要 L3。这个分级的意义是：**能让 95% 的主题不碰代码**，同时给剩下 5% 留了门。

### 3.2 主题清单（theme.json）完整 schema

这是主题与平台的**唯一契约**。定稿如下：

```jsonc
{
  // ---- 身份 ----
  "name": "eshop",                    // 必需，[a-z0-9-_]{2,64}
  "title": "EShop 商城",              // 必需，显示名
  "version": "1.0.0",                 // 必需，semver
  "author": "...",
  "description": "...",
  "screenshot": "screenshot.png",
  "runtime": "declarative",           // "declarative" | "worker"

  // ---- 平台要求的语言开关（关键）----
  // 主题声明自己"支持"哪些语言。平台据此判断某语言下能否激活本主题。
  // 主题实际的界面文案在 langs/ 目录，这里只声明支持范围。
  "locales": ["zh-CN", "en", "ja"],

  // ---- 模板 ----
  "templates": ["index", "home", "single", "page", "archive", "404"],
  "parts": ["layout", "header", "footer"],

  // ---- 平台内容扩展（复用 posts 表）----
  "postTypes": [
    {
      "name": "news",
      "label": "News",
      "labels": { "singular": "News", "plural": "News" },
      "supports": ["title", "editor", "excerpt", "thumbnail"],
      "hasArchive": true,
      "rewrite": { "slug": "news" }
    }
  ],
  "taxonomies": [
    { "name": "topic", "label": "Topic", "postTypes": ["news"], "hierarchical": false }
  ],
  "fields": [
    { "key": "source_url", "label": "Source", "type": "url", "postTypes": ["news"] }
  ],

  // ---- 主题自有表（本规划新增，商城/房产/宠物等主题需要）----
  "tables": [
    {
      "name": "product",
      "label": "Product",
      "translatable": ["name", "description", "content"],
      "fields": [
        { "key": "price", "type": "number",  "label": "Price", "required": true },
        { "key": "stock", "type": "integer", "label": "Stock" },
        { "key": "sku",   "type": "text",    "label": "SKU" }
      ],
      "hasArchive": true,
      "rewrite": { "slug": "products" }
    }
  ],

  // ---- 前台路由 ----
  "routes": [
    { "path": "/products/:slug", "template": "product-detail",
      "resolve": { "table": "product", "by": "slug" } }
  ],

  // ---- 后台菜单（本规划扩展：支持自定义页面）----
  "adminMenus": [
    { "id": "products",      "label": "产品",   "icon": "box",
      "screen": "table-list", "args": { "table": "product" },
      "capability": "content.read" },
    { "id": "shop-settings", "label": "商城设置", "icon": "settings",
      "screen": "theme-settings" },
    { "id": "orders",        "label": "订单",   "icon": "receipt",
      "screen": "custom", "args": { "view": "admin/orders.html" },
      "capability": "content.read" }
  ],

  // ---- 后台设置项 ----
  "settings": [
    { "key": "currency", "label": "货币", "type": "select",
      "options": ["CNY", "USD"], "default": "CNY" }
  ],

  // ---- L3 权限（worker 主题才需要）----
  "capabilities": ["content.read", "site.read", "menu.read", "locales.read"],
  "supports": ["blocks", "menus"]
}
```

**与现状的差异**（新增字段）：`locales`、`tables`、`adminMenus[].capability`、`adminMenus[].args.view`、`tables[].translatable`、`settings[].options`。

#### 3.2.1 `blocks[].name` 没有命名空间（重要，容易踩）

平台内置区块用 `core/` 前缀（`src/rendering/blocks.ts`：`core/paragraph`、`core/image` …），但**主题声明的区块名是纯标识符，不含斜杠**：

```jsonc
// ✅ 正确
"blocks": [{ "name": "property-card", "title": "Property Card", "template": "parts/card" }]
// ❌ 被拒：Invalid block name: theme/property-card
"blocks": [{ "name": "theme/property-card", ... }]
```

原因：`blocks[].name` 走的是 `IDENT_RE = /^[a-z][a-z0-9_-]{0,63}$/i`，与 `postTypes[].name` / `taxonomies[].name` / `fields[].key` 同一条规则。这个字段会落成 `theme_blocks` 表里的一行、并以 `UNIQUE(site_id, name)` 去重，斜杠既不合法也没必要 —— `core/` 前缀表达的是"谁内置的"，而主题区块的来源已经由 `declared_by_theme` 列记录。

**这条规则此前只存在于校验器里、没有写进文档**，是 2026-09 加校验时才被实测暴露出来的：仓库自带的集成测试当时用了 `theme/property-card`。修法是改测试（不是放宽校验），因为**拒绝是正确的**。

### 3.3 主题自有表：为什么用声明而不是让主题自己建表

用户提到参照实现的做法是主题带 `models.js`，自己 `sequelize.define('Product', ..., { tableName: 'eshop_products' })`。

**这个做法在 CFCMS 上不可行，且即使可行也不该用**：

| 维度 | nodecms：主题自己 define | CFCMS：声明式 |
|---|---|---|
| 平台约束 | 无 | Workers 禁止动态代码 → **物理上做不到** |
| 表名冲突 | 靠开发者记得加前缀 | 平台强制拼装 → **不可能冲突** |
| 建表时机 | 主题加载时 `sync({alter:false})` | 激活时一次性、可观测、可回滚 |
| 迁移 | 主题自己写 `runMigrations`（eShop 就有） | 平台按声明 diff，统一处理 |
| 卸载清理 | 主题可能忘 | 平台执行 `dropTables` |
| 审计 | 无 | 建表语句可导出、可审查 |

最后一条对"防错"尤其重要：**声明式让"AI 写的主题会建什么表"完全可预测**。它写的是一段 JSON，不是一段可能带 `DROP TABLE` 的代码。

### 3.4 主题切换时的数据策略

**核心原则：切换主题隐藏数据，绝不删除。**

理由：主题切换是**外观决策**，不是**数据决策**。用户换主题看看效果，不该丢掉商城的所有订单。这是 WordPress 的做法，也是正确的做法。

具体行为：

| 事件 | `posts`/`post_types`/`terms` 等声明表 | `theme_{n}_{table}` 业务表 |
|---|---|---|
| 主题 A 激活 | 写入 A 的声明，`affected_by_theme='A'` | 建表（若不存在） |
| 切到主题 B | A 的声明 `active=0`（**不删**） | B 的表建起来；A 的表**原样保留** |
| 再切回 A | A 的声明 `active=1`，数据完好 | A 的表还在，数据完好 |
| 卸载主题 A | 声明行删除；**数据行保留** | 默认**保留**；显式勾选"同时删除数据"才 drop |

「卸载时是否删数据」必须是**显式勾选 + 二次确认 + 显示将删除的行数**。默认不删。

### 3.5 主题后台菜单：从"链接"升级为"页面"

**现状问题**：`ALLOWED_ADMIN_SCREENS` 只有 7 个固定值（`dashboard`/`content-list`/`content-edit`/`settings`/`media`/`custom`/`theme-settings`），且 `screen` 只是告诉 SPA "打开哪个内置页面"。主题无法提供自己的后台界面。

**新设计**：`screen` 是**屏幕类型**，主题选类型并给参数，平台负责渲染。

| `screen` | 参数 | 渲染什么 | 用途 |
|---|---|---|---|
| `dashboard` | — | 仪表盘 | |
| `content-list` | `{ type }` | 平台内容的列表（含 CPT） | 新闻、产品（若走 `posts`） |
| `content-edit` | `{ type }` | 平台内容编辑器 | |
| `table-list` | `{ table }` | **主题自有表的列表**（新） | 商城产品、房产列表 |
| `table-edit` | `{ table }` | **主题自有表的编辑器**（新） | 由 `fields[]` 自动生成表单 |
| `theme-settings` | — | `settings[]` 声明的表单 | 商城设置 |
| `custom` | `{ view }` | 主题自带的 HTML 片段（沙箱渲染） | 订单看板等复杂界面 |
| `media` | — | 媒体库 | |

**`table-edit` 由 `fields[]` 自动生成表单**——这是关键。主题声明 `{ key: "price", type: "number", label: "Price" }`，平台就渲染出一个数字输入框。主题**不需要写 HTML 表单**，AI 也就**没机会写错表单**。

**权限统一由平台施加**：每个菜单项声明 `capability`（如 `content.read`）。菜单可见性、API 访问都由平台在这一处检查。**主题不写鉴权代码**——对照 nodecms 的 `themes/eShop/admin-routes.js` 自己 `jwt.verify` + 自己查 `user.role !== 'admin'`，那种写法必然有主题写漏。

---

## 4. 插件架构

### 4.1 插件 vs 主题：边界在哪

这是最容易混的一对概念，必须说死。

| 维度 | 主题 | 插件 |
|---|---|---|
| 回答的问题 | "网站**长什么样**，承载**什么业务**" | "给网站**加什么能力**" |
| 数量 | **每个站点同时只能有 1 个** | 可以有很多个 |
| 换掉它 | 网站外观和业务全变 | 网站照常，只是少了某项功能 |
| 典型例子 | 博客主题、商城主题 | SEO、短代码、支付网关、评论审核 |
| 能声明后台菜单 | ✅ | ✅ **（本规划新增）** |
| 能声明自有表 | ✅ | ✅ 应支持，机制同主题 |
| 能改前台模板 | ✅ 拥有模板 | ❌ 只能通过 hook 注入 |
| 能声明 CPT | ✅ | ⚠️ 允许但少见（如插件提供的"作品集"类型） |

**判据（给 AI 用的决策规则）**：

> 换掉这个东西之后，网站还能正常显示吗？
> - **不能** → 它是主题
> - **能，只是功能少了** → 它是插件

举例：SEO 插件卸掉，网站还在，只是少了 meta 标签 → 插件。商城主题卸掉换成博客主题，产品页全没了 → 主题。

### 4.2 插件的能力模型：声明式 + 宿主实现

CFCMS 现有设计（`src/extensions/plugin/runtime.ts`）已经确立了正确方向，规范固化：

**插件不携带可执行 JS。** 清单声明要挂哪些 hook，宿主提供每个 hook 的实现。

```jsonc
{
  "name": "seo",
  "title": "SEO Toolkit",
  "version": "1.0.0",
  "permissions": ["content.read", "settings.read", "settings.write"],
  "hooks": ["html", "beforeSavePost", "afterSavePost"],

  // 本规划新增：插件也能注册后台菜单
  "adminMenus": [
    { "id": "seo-general", "label": "SEO", "icon": "chart",
      "screen": "plugin-settings", "capability": "settings.read" }
  ],

  // 本规划新增：插件设置项声明
  "settings": [
    { "key": "title_template", "label": "标题模板", "type": "text",
      "default": "{title} | {site}" },
    { "key": "default_description", "label": "默认描述", "type": "textarea" }
  ],

  // 本规划新增：插件声明它关心哪些语言（用于语言包校验）
  "locales": ["zh-CN", "en"]
}
```

**`DECLARABLE_HOOKS` 是白名单**（现有 `extensions.ts:54-62`），未知 hook 名被静默忽略。这个行为**要改成报错**——静默忽略会让插件作者以为 hook 生效了。改为安装时校验、不认识的 hook 名直接拒绝安装。

### 4.3 能力（capability）清单

现有 `CAPABILITIES`（`extension-security.ts:1-5`）：

```
content.read, content.write, settings.read, settings.write,
media.read, media.write, routes.register, admin.register
```

需要补充（因为新增了主题自有表和插件菜单）：

```
table.read       读主题/插件自有表
table.write      写主题/插件自有表
i18n.read        读语言包与启用的语言
i18n.write       管理翻译
```

**能力检查必须在服务端**。`pluginApi` 的 facade（`extensions.ts:344-383`）已经做对了：每个方法先 `allow(cap)` 再执行，越权直接抛 `Capability denied`。这个模式要保持。

**为什么不靠 hook 名反推能力**：hook 名是"何时执行"，能力是"能碰什么"。两者正交。一个 `html` hook 只读设置时不需要写权限，读写权限该由 `permissions` 显式声明。

### 4.4 插件菜单的实现路径

现状：`adminMenus` 只在主题清单里被读（`theme-capabilities.ts` → `theme_admin_menus` 表）。

改造：

```sql
-- 统一菜单表：主题与插件的后台菜单汇到一处
CREATE TABLE admin_menu_registry (
  id             TEXT PRIMARY KEY,
  site_id        TEXT NOT NULL,
  owner_type     TEXT NOT NULL,      -- 'theme' | 'plugin' | 'core'
  owner_name     TEXT NOT NULL,      -- 'eshop' | 'seo'
  menu_id        TEXT NOT NULL,
  label          TEXT NOT NULL,
  icon           TEXT,
  screen         TEXT NOT NULL,
  args_json      TEXT NOT NULL DEFAULT '{}',
  capability     TEXT,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE(site_id, owner_type, owner_name, menu_id)
);
```

**关键：菜单有归属 (`owner_type`/`owner_name`)，所以某插件停用时，只清它的菜单，不碰别人的。**

后台 API 按 `capability` 过滤后返回给 SPA，SPA 只管渲染。**排序规则**：core 菜单按固定顺序，主题菜单紧跟内容组，插件菜单归入"扩展"组。

`theme_admin_menus` 旧表可以废弃（数据迁移到新表）或者保留为视图。倾向**迁移后废弃**——两张表存同一件事是 bug 温床。

---

## 5. 防错机制（防烂代码）

这是用户最强调的一点。前面所有设计都是为了"让正确的做法比错误的做法更容易"。这一节是把它制度化。

### 5.1 问题的本质

> "一个很蠢的 AI，我要它加个功能。它乱写，功能实现了，但是是垃圾代码。"

拆解这句话，坏代码有**四种**，防御手段各不相同：

| 坏代码类型 | 长什么样 | 为什么危险 |
|---|---|---|
| **A. 功能对但越界** | 主题直接读 `posts` 表、插件调主题的函数 | 今天能跑，明天另一个模块一改就炸 |
| **B. 功能对但重复** | 三个主题各写一份 `esc()`、各写一份鉴权 | 修 bug 要修 N 处，必然漏 |
| **C. 功能对但脆弱** | 假设 `site_id` 一定是 `'default'`、假设 locale 是 `en` | 多站点/多语言一开就崩 |
| **D. 功能对但不可维护** | 一个函数 800 行、命名 `doStuff2`、注释说"临时方案" | 无法阅读，无法安全修改 |

通用 AI 的问题在于它**只检查 A 里的"功能对不对"**，其余三类它看不见。所以必须用机器来挡。

### 5.2 防线一：类型约束（挡 C 类）

**现状**：`tsc --noEmit` 已经跑，0 错误。要把它变成**更硬的约束**。

具体做法：

```ts
// ❌ 坏：siteId 可选，容易忘，忘了就隐式落到 default
export async function findContent(env, type, slug, locale, siteId = "default") {}

// ✅ 好：siteId 与 locale 是必填的位置参数，忘记传就编译不过
export async function findContent(
  env: Env, type: string, slug: string,
  locale: string, siteId: string
): Promise<ContentRow | null> {}
```

**去掉所有 `siteId = "default"` 的默认值**。这是最有价值的一条类型约束——它把"忘记传站点"从运行时静默错误变成编译期错误。上一轮的 `activeTheme` bug 正是"隐式默认值掩盖了状态缺失"。

代价：调用点要全部改。值得。

### 5.3 防线二：清单校验（挡 A 类的前半）

**现状**：`extension-security.ts` 的 `validateManifest` 已经逐字段校验。要**加强并覆盖新字段**：

```ts
// 新增校验
- tables[].name        必须匹配 /^[a-z][a-z0-9_]{1,63}$/
- tables[].translatable 必须是 fields 里存在的 key（否则翻译一个不存在的字段）
- tables[].fields[].key 不得与平台保留字冲突（id/site_id/slug/lang_group/status/created_at/updated_at）
- adminMenus[].screen   必须在 ALLOWED_ADMIN_SCREENS 里
- adminMenus[].capability 必须在 CAPABILITIES 里
- adminMenus[].args      按 screen 类型做 schema 校验
                          (screen='table-list' → args.table 必填且必须已声明)
- routes[].resolve.table 必须已声明
- locales[]             必须是合法语言代码格式
- 所有 key 前缀           语言包文件里的 key 必须匹配 L2 命名规范（见 §5.5）
```

**校验失败必须让安装失败，不能警告后继续。** 一个装不上的主题胜过半个能跑的主题。

### 5.4 防线三：契约测试（挡 B/C 类）

**现状**：测试规模不小（47+46+63+32+25+28 = 241 条断言），且是**驱动真实 Worker 源码 + 真实本地 D1**，这个基础很好。

要补的测试类型：

**① 多语言契约测试**

```
- 未启用多语言时，主题自有表不建 _i18n 表
- 启用 en 后，_i18n 表出现
- 单语言模式下 table.list({locale:'en'}) 忽略 locale 参数
- 多语言模式下，缺翻译回退到默认语言（不是空、不报错）
- 显式前缀 /en/xxx 找不到 → 404（不回退）
- 无前缀 /xxx 找不到 → 尝试其他语言
- price 字段（非 translatable）在两种语言下值相同
- name 字段（translatable）在两种语言下值不同
```

最后两条尤其重要——它们**直接验证"translatable 划分是否正确工作"**。这是本设计最核心的语义。

**② 架构测试（新增，关键）**

这是挡 B 类"越界与重复"的机器。

```js
// tests/architecture.test.mjs

test('核心层不依赖主题层', () => {
  // src/core/*.ts 不得 import 任何 themes/ 目录下的东西
});

test('主题不得直接写 SQL', () => {
  // themes/**/* 不得出现 env.DB.prepare / SELECT / INSERT
  // 主题只能通过 host.table() facade
});

test('插件不得 import 主题', () => {
  // plugins/**/* 不得 import themes/**
});

test('无未声明的表名', () => {
  // 全仓搜索 /theme_[a-z]+_/ 字面量，必须都能对应到某个主题的声明
});

test('语言包 key 前缀正确', () => {
  // themes/aurora/langs/zh-CN.json 的 key 必须全部以 'theme.aurora.' 开头
  // plugins/seo/langs/en.json 的 key 必须全部以 'plugin.seo.' 开头
});

test('无硬编码 site_id', () => {
  // src/**/*.ts 不得出现 siteId = "default" 的默认参数
  // 出现即失败（防止有人把默认值加回来）
});

test('每个 cap 检查成对出现', () => {
  // 新增的 facade 方法必须同时有 allow() 与 deny 路径
});
```

**这些测试的价值在于它们是"无情的"**。AI 写新代码时，如果越界，测试立刻红。它不需要"理解架构"，只需要"运行测试"。

**③ 主题一致性测试**

```
- 主题声明的每个 template 都存在对应文件
- 主题声明的每个 adminMenu 的 screen/args 组合合法
- 主题声明 locales 后，langs/ 下有对应语言包文件
```

### 5.5 防线四：脚手架与模板（挡 D 类）

**这是最实用的一条，也是最容易被忽略的。**

AI 写代码烂，很大原因是**没有好的起点**。让它从空白文件开始写，它只能自由发挥。

做法：提供生成器。

```bash
npm run make:theme -- my-shop     # 生成主题骨架
npm run make:plugin -- my-seo     # 生成插件骨架
npm run make:table -- <theme> <table>  # 生成表声明片段
```

生成的骨架里：

- 目录结构已经对
- `theme.json` 已经填好必需字段和注释
- `langs/zh-CN.json` + `langs/en.json` 已就位（key 前缀已对）
- 模板里已经用了正确的 helper 写法（`{{len(posts)}}` 而不是 `{{posts.length}}`）
- 已经包含一个可跑通的最小示例

**原理**：让 AI 做"填空"而不是"创作"。填空出错的概率远低于创作。而且生成的骨架**天然通过架构测试**，AI 改动时越界会立刻被发现。

### 5.6 防线五：约定优于配置（减少 AI 的选择空间）

**每给 AI 一个"你可以自己决定"的机会，就多一个写烂的机会。**

所以：

| 事项 | 不让 AI 决定，而是 | 理由 |
|---|---|---|
| 表名 | 平台按 `theme_{name}_{table}` 拼 | 冲突不可能 |
| 语言包路径 | 固定 `langs/{code}.json` | 找不到是常见 bug |
| 后台表单 | 由 `fields[]` 自动生成 | 手写表单必然有漏 |
| 鉴权 | 平台统一施加 | 手写鉴权必然有漏 |
| 排序 | 声明 `sort_order` | 默认按名字，够用 |
| 错误处理 | facade 内部统一抛错 | 每处自己 try/catch 是灾难 |

**反过来说：把自由度集中在"真正需要创意的地方"——模板长什么样、业务逻辑是什么。** 其余全部收走。

### 5.7 防错机制的落地顺序

不是所有防线同等紧急。按性价比排序：

| 优先级 | 机制 | 工作量 | 收益 | 状态 |
|---|---|---|---|---|
| **P0** | 架构测试（§5.4②） | 小 | **最大**。写一次，永久生效，挡住所有越界 | ✅ **已完成** |
| **P0** | 清单校验加强（§5.3） | 小 | 大。主题装不上好过跑一半 | ✅ 已完成（测试侧）；`validateManifest` 加强待做 |
| **P1** | 去掉 `siteId` 默认值（§5.2） | 中 | 大。编译期挡 C 类 | ⏳ 棘轮守着，26 处待清理 |
| **P1** | 脚手架（§5.5） | 中 | 大。降低 AI 犯错概率 | ⏳ 待做 |
| **P2** | 多语言契约测试（§5.4①） | 中 | 中高 | ⏳ 批次 2 |
| **P2** | 主题一致性测试（§5.4③） | 小 | 中 | ✅ 已完成（并入架构测试） |

**P0 已落地**。架构测试 + 清单校验是一天之内能做完的事，而它们能挡住后面
80% 的架构腐化。已建内容与验证记录见 §8 批次 1 的进度表。

---

## 6. 数据库表总览

按归属分类，**这是"哪些表属于平台、哪些属于主题"的唯一权威清单**。

### 6.1 平台核心表

| 表 | 归属 | 说明 |
|---|---|---|
| `sites` | 平台 | 多站点注册表 |
| `settings` | 平台 | 键值配置（按 site_id） |
| `locales` | 平台 | 语言字典 |
| `site_locales` | 平台 | **新增**，站点启用哪些语言 |
| `posts` | 平台 | 文章/页面/CPT（共用，`type` 区分） |
| `post_translations` | 平台 | 内容翻译 |
| `post_meta` | 平台 | 自定义字段值 |
| `users` / `roles` / `permissions` / `sessions` | 平台 | 权限体系 |
| `media` | 平台 | 媒体库 |
| `menus` / `menu_items` | 平台 | 前台导航 |
| `admin_menu_registry` | 平台 | **新增**，后台菜单统一注册表 |
| `i18n_overrides` | 平台 | **新增**，界面翻译覆盖 |

### 6.2 主题声明表（平台代管，数据属主题）

| 表 | 说明 |
|---|---|
| `post_types` | 主题声明的 CPT（复用 `posts`） |
| `taxonomies` / `terms` / `term_relationships` | 分类法 |
| `field_defs` | 自定义字段定义 |
| `theme_routes` | 主题路由 |
| `theme_blocks` | 主题区块 |
| `theme_setting_defs` / `theme_settings` | 主题设置 |
| `theme_installs` | 主题安装记录（含 manifest） |

### 6.3 主题自有业务表（动态生成）

| 表模式 | 说明 |
|---|---|
| `theme_{theme}_{table}` | 主题声明的业务主表（如 `theme_eshop_product`） |
| `theme_{theme}_{table}_i18n` | 翻译表，**仅当站点启用 ≥2 语言时才建** |

### 6.4 插件表

| 表 | 说明 |
|---|---|
| `plugin_installs` | 插件安装记录 |
| `plugin_setting_defs` / `plugin_settings` | 插件设置 |
| `extension_capabilities` | 能力授权记录 |
| `theme_{plugin}_{table}` | 插件自有表（若支持，与主题同机制） |

**命名约定（强制）**：动态生成的表一律 `theme_` 前缀开头。这让"哪些表是扩展生成的"一眼可辨，也让架构测试有稳定的匹配模式。

---

## 7. 目录结构重整

现状的问题：**根目录散落着 `src/`、`themes/`、`plugins/`、`public/`、`migrations/`、`tests/`、`docs/`、`scripts/`，同时 `public/admin/` 里塞了 4 个 JS 文件（1883 行）却没有任何目录层次。** 更麻烦的是 `src/core/` 里 22 个文件平铺，看不出分层。

### 7.1 目标结构

```
cfpress/
├── src/                          # Worker 源码
│   ├── index.ts                  # 入口：只在路由分发
│   ├── api.ts                    # 管理 API
│   │
│   ├── platform/                 # ── 平台层（不认识主题/插件）──
│   │   ├── content/              # 文章、页面、翻译组
│   │   │   ├── repository.ts
│   │   │   └── translations.ts
│   │   ├── i18n/                 # 多语言四层
│   │   │   ├── locale-registry.ts    # L0
│   │   │   ├── packs.ts              # L2 分层字典
│   │   │   ├── resolve.ts            # URL/参数/cookie 解析
│   │   │   └── translate.ts          # __()
│   │   ├── auth/                 # 认证与权限
│   │   ├── sites/                # 多站点
│   │   ├── media/
│   │   ├── menus/                # 前台菜单 + 后台菜单注册表
│   │   └── settings/
│   │
│   ├── rendering/                # ── 渲染层 ──
│   │   ├── template-engine.ts
│   │   ├── resolver.ts           # WP 式模板层级
│   │   └── blocks.ts
│   │
│   ├── extensions/               # ── 扩展层（主题 + 插件）──
│   │   ├── contract/             # 两层共享的契约
│   │   │   ├── hooks.ts          # ✅ 已落地：HostHooks 接口 + NULL_HOOKS + 注入槽
│   │   │   ├── manifest.ts       # ⏳ 批次 3：声明模型
│   │   │   ├── validation.ts     # ⏳ 批次 3：清单校验（§5.3）
│   │   │   └── capabilities.ts   # ⏳ 批次 3：能力枚举
│   │   ├── security.ts           # ✅ 已落地：能力清单 + 清单字段校验
│   │   ├── theme/
│   │   │   ├── runtime-declarative.ts  # ✅ 声明式渲染
│   │   │   ├── runtime-worker.ts       # ✅ L3 沙箱
│   │   │   ├── capabilities.ts         # ✅ 声明落实（建表/建菜单）
│   │   │   ├── templates.ts            # ✅ 模板加载与缓存
│   │   │   ├── tables.ts               # ⏳ 批次 3：自有表 DDL 生成
│   │   │   └── admin-screens.ts        # ⏳ 批次 3
│   │   ├── plugin/
│   │   │   ├── runtime.ts        # ✅ 已落地：hook 注册表 + 运行时装配
│   │   │   ├── hooks.ts          # ⏳ 批次 4：hook 目录拆分
│   │   │   └── facade.ts         # ⏳ 批次 4：能力门面拆分
│   │
│   └── shared/                   # 纯工具，无业务依赖
│       ├── types.ts  crypto.ts  repo.ts  cache.ts  scheduler.ts
│
├── themes/                       # 主题（数据包，不是源码）
│   └── aurora/
│       ├── theme.json
│       ├── screenshot.png
│       ├── templates/
│       │   ├── layout.html      # 或 parts/layout.html
│       │   ├── index.html  home.html  single.html  page.html
│       │   ├── archive.html  404.html
│       │   └── parts/           # header/footer/tokens
│       ├── assets/              # css / js / images
│       └── langs/               # zh-CN.json / en.json
│
├── plugins/
│   └── seo/
│       ├── plugin.json
│       ├── views/               # 后台 HTML 片段（custom screen 用）
│       └── langs/
│
├── admin/                        # 后台 SPA（与平台源码分开）
│   ├── index.html
│   ├── css/  admin.css
│   └── js/
│       ├── app.js               # 引导
│       ├── state.js             # 状态
│       ├── nav.js               # 导航模型
│       ├── screens/             # 每个屏幕一个文件
│       │   ├── dashboard.js  content-list.js  content-edit.js
│       │   ├── media.js  themes.js  plugins.js
│       │   ├── table-list.js  table-edit.js     # 主题自有表
│       │   ├── languages.js  sites.js  users.js
│       │   └── custom.js
│       ├── ui.js                # 通用组件
│       ├── icons.js
│       └── i18n.js              # 后台界面语言
│
├── migrations/                   # D1 迁移，编号递增
├── tests/
│   ├── architecture.test.mjs     # ★ 分层与越界检查
│   ├── contract/                 # 契约测试
│   ├── integration/              # 集成测试
│   └── helpers/                  # 共享测试工具
├── scripts/
│   ├── make-theme.mjs            # ★ 脚手架
│   ├── make-plugin.mjs
│   ├── deploy-theme.mjs
│   └── seed-demo-content.mjs
├── docs/
│   ├── ARCHITECTURE.md           # 本文
│   ├── I18N.md                   # 多语言详解（从本文 §2 展开）
│   ├── THEME-DEV.md              # 主题开发指南
│   ├── PLUGIN-DEV.md             # 插件开发指南
│   └── THEME-ARCHITECTURE-PLAN.md  # 历史方案（保留）
├── public/                       # 纯静态资源（favicon 等）
└── wrangler.jsonc
```

### 7.2 重整要点

| 变化 | 现状 | 目标理由 | 状态 |
|---|---|---|---|
| `src/core/*` 平铺 19 文件 | 全部在 `src/core/` | 拆成 `platform/` `rendering/` `extensions/` `shared/` 四个**有依赖方向**的目录 | ✅ 已完成 |
| 主题与插件解耦 | `theme-runtime` 直接 import 插件运行时 | 新增 `extensions/contract/hooks.ts` 做依赖倒置，红线 4 才真正成立 | ✅ 已完成 |
| `public/admin/` → `admin/` | 4 个文件平铺 2838 行 | 与"静态资源"区分开；`js/` 下按屏幕拆文件 | ⏳ 待做 |
| 后台 JS 拆文件 | `admin.js` 1514 行单文件 | 每个屏幕一个文件，改一个屏幕不必读全部 | ⏳ 待做 |
| 主题加 `assets/` | CSS/JS 散在模板里 | 主题资源有归属 | ⏳ 待做（批次 2/4） |
| 主题加 `langs/` | 无 | 多语言必需 | ⏳ 待做（批次 2） |
| 测试分 `contract/` `integration/` | 全平铺 | 契约 vs 集成，失败时知道查哪 | ⏳ 待做 |
| 新增 `scripts/make-*.mjs` | 无 | 脚手架（§5.5） | ⏳ 待做（批次 4） |

### 7.3 依赖方向规则（架构测试的判据）

```
shared/  ←  任何层可用，但 shared 不依赖任何业务层
   ↑
platform/  ←  不认识 extensions/
   ↑
rendering/  ←  可用 platform，不认识 extensions/
   ↑
extensions/  ←  可用 platform 与 rendering，但**主题与插件之间互不可见**
   ↑
index.ts  ←  唯一知道所有层的地方
```

**四条红线**（全部已被 `tests/architecture.test.mjs` 机器强制）：

1. `shared/` 不 import 上层任何东西
2. `platform/` 不 import `extensions/`
3. `rendering/` 不 import `extensions/`
4. `extensions/theme/` 与 `extensions/plugin/` 互不 import

第 4 条尤其重要——**核心层给主题和插件提供的是同一套接口**，这样"插件也能注册菜单"就是免费的。

**⚠️ 第 4 条在落地时遇到并解决的第一个真问题**：

主题渲染需要给插件机会改输出（`beforeRender` action、`html` filter、短代码）。
最直觉的写法是让 `theme/` 直接 `import` `plugin/` 的 `applyFilters` —— 编译能过、功能也正常，
但**插件就此成为每个主题的硬依赖**，而这两个东西本应是独立安装的。

解决办法是**依赖倒置**，落在一个新文件 `src/extensions/contract/hooks.ts`：

```
   contract/hooks.ts        ←  只依赖 shared/types，声明 `HostHooks` 接口
        ↑                ↑
   theme/ 依赖它      plugin/ 实现它
        ↑                ↑
        └──── index.ts 把两边接起来 ────┘
```

- `theme/` 只认 `HostHooks` 接口，调用 `hooks.applyFilters(...)`，**永远看不到 plugin/**；
- 没有注入时使用 `NULL_HOOKS`（原样返回、空实现）——行为与"本站没装插件"完全一致，
  所以调用点**不需要 null 判断**，也不会两边分支；
- `index.ts` 是唯一同时 import 两层的模块，在 boot 时调一次 `setHostHooks(...)`。

> 顺带修掉了 `decorateOutput` 里的 `o.siteId ?? "default"` —— 它和参数默认值是同一类问题：
> 隐性兜底会让"传漏了"看起来像"正常工作"。

**这次也发现架构测试自己是假绿的**（见 §8 批次 1 的反向验证表）：
跨层检查原本用 `spec.includes("/extensions/plugin/")` 做文本匹配，
而真实写法是 `"../plugin/runtime"`，**根本不含 `/extensions/`**——检查从未生效过。
已改为**按文件所在目录解析路径再比较**，并补上 `shared/` 叶子层检查。

---

## 8. 实施路线图

分四个批次，每批次**可独立验证、可独立交付**。

### 批次 1：目录重整 + 架构测试（P0，约 1 天）

**做什么**
1. 按 §7.1 移动文件（纯移动，不改逻辑）
2. 写 `tests/architecture.test.mjs`（§5.4②的 7 条）
3. 加强 `validateManifest`（§5.3）
4. 去掉 `siteId` 默认值（§5.2）

**验收**
- `tsc --noEmit` 0 错误
- 现有 241 条测试全绿
- 架构测试全绿
- **故意在主题里写一句 `env.DB.prepare(...)`，架构测试必须失败**（验证测试真的有效）

> 第 4 条是**必须做**的验证——测试写了但不会失败，等于没写。

#### 进度（已落地的部分）

| 项 | 状态 | 证据 |
|---|---|---|
| 架构测试（11 组检查） | ✅ 已建 | `tests/architecture.test.mjs`，已接入 `npm test` 与 `run-all.mjs` |
| 反向验证（测试确实会失败） | ✅ 已验证 | 7 项注入测试均如期失败（见下） |
| 主题清单漂移修复 | ✅ 已修 | `themes/default`、`themes/magazine` 声明与实际文件对齐 |
| 硬规则文档 | ✅ 已建 | [`AGENTS.md`](../AGENTS.md) |
| `siteId` 默认值清理 | ✅ 已完成 | 26 处全部移除；棘轮常量已删除，规则改为零容忍 |
| 多站点 SEO 回归修复 | ✅ 已修 | `/sitemap.xml`、`/robots.txt` 移到站点解析之后 |
| **其余 6 处常量默认值** | ✅ 已修 | `siteId = DEFAULT_SITE_ID`，旧正则漏掉的那批 |
| **目录重整（src/）** | ✅ 已完成 | `src/core/*` → `shared/` `platform/` `rendering/` `extensions/`，见下表 |
| **依赖倒置（theme↔plugin）** | ✅ 已完成 | 新增 `extensions/contract/hooks.ts`，红线 4 从"纸面"变为"真实成立" |
| **运行时清单校验** | ✅ 已完成 | §5.3 全部规则实现进 `validateManifest`；`tests/manifest-validation.test.mjs` 33 条断言逐条证明"拒绝" |
| 后台 JS 拆分（`admin/js/screens/`） | ⏳ 待做 | 见 §7.2；纯前端重构，与分层解耦，可独立进行 |

**批次 1 验收状态（2026-09-28 实测）**

```
architecture        10 passed, 0 failed
manifest-validation 33 passed, 0 failed
template-engine     47 passed, 0 failed
theme-integration   46 passed, 0 failed
multisite           74 passed, 0 failed
admin-contract      32 passed, 0 failed
plugin-hooks        25 passed, 0 failed
theme-worker        28 passed, 0 failed
theme-aurora         0 failure(s)
npx tsc --noEmit    0 错误（仅 node_modules 内的既有 lib 冲突）
```

9 个套件已全部接入 `npm test` 与 `tests/run-all.mjs`（`manifest-validation` 排在 `architecture` 之后，
因为它同样不需要数据库，且守的是"用户上传的东西"）。

> **`run-all.mjs` 在本机沙箱里会整体报 SKIP（`EBUSY`）** —— 这是 Windows 沙箱锁 node 二元文件的已知现象，
> 不是测试失败。runner 刻意把"跑不起来"与"跑失败"分开报告（见 `run-all.mjs` 的注释）。
> 逐个直接执行 `node tests/<name>.test.mjs` 才是本机可靠的验证方式。

#### 目录重整的落点（已完成）

| 目标层 | 文件 | 说明 |
|---|---|---|
| `src/shared/` | `types` `crypto` `repo` `cache` `scheduler` | 叶子层，不依赖任何业务层 |
| `src/rendering/` | `template-engine` `template-resolver` `blocks` | 纯渲染，零业务依赖 |
| `src/platform/` | `auth` `permissions` `sites` `frontend` `seo` `revisions` | 不认识扩展 |
| `src/extensions/` | `contract/hooks` `security` | 共享契约与安全 |
| `src/extensions/theme/` | `runtime-declarative` `runtime-worker` `capabilities` `templates` | 主题侧 |
| `src/extensions/plugin/` | `runtime` | 插件侧 |
| `src/` 根 | `index.ts`（路由）`api.ts`（管理 API） | 唯一知道所有层的地方 |

原 `src/core/` 的 19 个平铺文件已全部归位，`src/core/` 目录已删除。
共 23 个 `.ts` 文件、4525 行；`tsc --noEmit` 0 错误；esbuild 打包通过。

**反向验证记录**（这是本批次最重要的产出——证明防线真的有效）：

| 注入的违规 | 架构测试的反应 |
|---|---|
| 主题里加 `env.DB.prepare("SELECT …")` | ✅ FAIL，并列出文件名 |
| 语言包写无前缀的 `"nav.home"` | ✅ FAIL，并指出缺少的前缀 |
| 清单声明一个不存在的模板 | ✅ FAIL，并给出缺失的文件名 |
| 新增 `siteId = "default"`（字符串形式） | ✅ FAIL，报出文件:行号 |
| 新增 `siteId = DEFAULT_SITE_ID`（常量形式） | ✅ FAIL —— **这曾是真实漏洞**，旧正则只匹配字符串字面量 |
| 主题里加 `import ... from "../plugin/runtime"` | ✅ FAIL —— **这也曾是真实漏洞**，旧检查文本匹配 `/extensions/plugin/`，而真实路径不含该串 |
| `shared/` 里加 `import ... from "../platform/..."` | ✅ FAIL，指出"reaches platform/" |
| 移除 sitemap 的站点过滤 | ✅ FAIL，两条断言分别指出"default 列表混入 shop 的文章" |
| 主题声明 `blocks[].name = "theme/property-card"` | ✅ REJECTED —— 加运行时校验后由 `validateManifest` 直接拦截安装 |

**这次清理中真实发现并修复的问题**（都是"文档/测试说已守住，实际没守住"）：

1. **`/sitemap.xml` 与 `/robots.txt` 完全不按站点工作。** 它们在 `src/index.ts` 里排在
   `resolveSite()` **之前**，并调用 `locales(env)` / `siteInfo(env)`（无 `siteId`）。
   后果：多站点部署下**每个域名都返回默认站的 sitemap**，而且是 200，没有任何报错。
2. **架构测试的正则漏掉常量形式默认值。** 旧正则只匹配字符串字面量，
   于是 `siteId = DEFAULT_SITE_ID` 六处全部"隐形"。规则看似被棘轮守住，实际没有。
3. **跨层检查从未生效。** 旧检查匹配 `/extensions/plugin/`，而真实写法是 `"../plugin/runtime"`。
   **这条最值得警惕**：一个守不住东西的守卫比没有守卫更糟，因为它是被信任的。
4. **主题与插件之间本该"互不可见"，实际做不到。** 主题渲染要调插件的 filter，
   于是就形成了 `theme/` → `plugin/` 的直接依赖。已用 `contract/hooks.ts` 做依赖倒置解决。
5. **两处类型错误在移除默认值后暴露**：`ThemeRenderOptions.siteId` 是可选字段，
   而渲染器实际必需。默认值一直在掩盖这个缺口。已改为必填。
6. **`theme-integration` 用了一个非法区块名。** 加运行时清单校验后立刻暴露：
   该测试 fixture 声明 `blocks[].name = "theme/property-card"`，而 `IDENT_RE` 不允许斜杠，
   于是**主题安装直接 400**（测试此前"通过"是因为当时根本没有安装期校验）。
   修的是测试（不是放宽规则）—— 详见 §3.2.1。**这是本批次"加校验"的直接收益：
   它把一个此前只在运行时静默变形的问题，提前到了安装边界上。**

**关于断言强度的教训**（值得记住）：
第 9b 段测试**第一版是假绿**——它断言"XML 格式正确"和"不含 `/products/widget`"，
而那个路径当时根本没有已发布内容，所以**注入 bug 后依然全绿**。
改成断言真实存在的两个 slug（`default-post` / `shop-post` 的互相排斥）后，
注入 bug 立刻产生两条 FAIL。
**教训：断言必须盯住"注入缺陷后必然会变的那一个值"，否则写出来的只是装饰。**

### 批次 2：多语言四层（P1，约 2-3 天）

**做什么**
1. 迁移 `0011_i18n.sql`（L0 两张表 + `posts.lang_group` + `users.ui_lang`）
2. `src/platform/i18n/` 四个模块
3. 界面语言注入（API + admin SPA）
4. 内容翻译组 CRUD + 后台语言版本条
5. 多语言契约测试（§5.4①）

**验收**
- 只启用 `zh-CN` 时，主题自有表**不建** `_i18n` 表
- 启用 `en` 后，`_i18n` 表出现
- 同一产品的中英文标题可分别编辑、分别访问
- `price` 在两种语言下值相同（验证 translatable 划分）
- 后台界面语言与内容语言独立可设

### 批次 3：主题自有表 + 后台菜单（P1，约 2-3 天）

**做什么**
1. `theme-capabilities.ts` 支持 `tables[]`
2. 表 DDL 生成器 + diff 迁移
3. `host.table()` facade + 沙箱 API 端点
4. `admin_menu_registry` 统一菜单表（主题 + 插件）
5. `table-list` / `table-edit` / `theme-settings` 屏幕
6. 插件菜单支持

**验收**
- 一个 `eshop` 示例主题能建出 `theme_eshop_product` 与 `_i18n`
- 后台自动出现"产品"菜单，列表和表单**由声明生成**（主题无表单代码）
- SEO 插件能注册自己的后台菜单
- 停用插件后，只有它的菜单消失
- 切主题后，旧主题的表在、菜单消失、切回来菜单恢复

### 批次 4：脚手架 + 文档（P2，约 1 天）

**做什么**
1. `scripts/make-theme.mjs` / `make-plugin.mjs`
2. `docs/I18N.md` / `THEME-DEV.md` / `PLUGIN-DEV.md`
3. 示例主题 `eshop`（作为声明能力的活文档）

**验收**
- `npm run make:theme -- demo` 生成的骨架：`tsc` 过、架构测试过、能激活、能渲染

---

## 9. 已确认的架构决策（原"待决策事项"）

> **状态：已全部确认（2026-09-28）。六项均采用选项 A。**
> 这些是**架构级决定**，实施中如要更改必须回到本文档改，不能在代码里悄悄偏离。

| # | 事项 | 决定 | 理由 | 落点 |
|---|---|---|---|---|
| 1 | **slug 唯一性** | **跨语言唯一**——`/en/about` 与 `/zh/about` 视为同一资源的不同语言版本，不允许两个独立内容共用 slug | CFCMS 支持**无前缀访问**（`/about` 要能落到某个语言），共用 slug 必然歧义；且翻译组（`lang_group`）本来就要求"同一内容的不同语言版本共用 slug" | §2.3 唯一索引 `UNIQUE(site_id, type, slug)`，**不含 locale** |
| 2 | **主题自有表的字段类型** | **先只支持基础类型**：`text` / `number` / `boolean` / `date`（+ 后续 `longtext`） | 关系（外键到平台 `posts`）看起来诱人，但会让主题表与平台表 schema 耦合——平台改字段就崩主题。等有真实需求再加，加时走**新版本 manifest** 而不是改语义 | §3.2 `tables[].fields[].type` 枚举；§2.5 `translatable` 只对有意义的类型生效 |
| 3 | **插件是否也能声明自有表** | **支持，与主题同机制** | 机制已经统一（同一份 DDL 生成器、同一套 `host.table()` facade）。不支持反而要维护两套路径，且现实中"插件带表"是常见需求（如表单插件） | §6.4 插件表命名 `plugin_{slug}_{table}`（与主题 `theme_{owner}_{table}` 对称） |
| 4 | **`theme_admin_menus` 旧表** | **迁移后删除**（批次 3 的迁移里 drop） | 与 `admin_menu_registry` 存同一件事，两张表 = bug 温床（一定会有代码读错那张、有代码只写一张） | §6.2 改为 `admin_menu_registry`；旧表在批次 3 drop |
| 5 | **目录重整的时机** | **批次 1 就做（先重整）** | 先重整，后面所有新代码自然落在对的位置；若最后做，则批次 2–4 写的每一行代码都要再动一次 | §7.1；本批次执行中 |
| 6 | **界面语言（L2）是否本期做** | **做** | "中文站长管英文站"是内容站常态，缺了后台就没法用 | §2.4；批次 2 交付 |

### 9.1 这些决定对既有设计的连带影响

写代码前请确认自己没和这几条冲突：

- **决定 1** 让"翻译"和"独立内容"成为两个不同概念：
  - 同一 slug + 不同 locale = 翻译（一个 `lang_group`）
  - 不同 slug + 不同 locale = 两条独立内容
  → 因此**新建内容时不能只校验 slug 是否被占，而要判断"对方是不是另一个语言的同一内容"**（若对方已属某个 `lang_group`，应提示"转为翻译"而非直接报冲突）。
- **决定 2** 意味着主题**不能**在 `fields[]` 里写 `type: "reference"`。需要关联到文章时，
  用 `type: "number"` 存 post id，**关系语义由主题自己的代码解释**——平台不认。
- **决定 3** 意味着 §6 的表命名规则要**成对**实现，别只写主题那半边。
- **决定 4** 一旦 drop，任何还引用 `theme_admin_menus` 的代码都会立刻报错。
  **drop 的同一个迁移里必须先完成数据搬运**，不要分两个版本。
- **决定 5** 已在进行中，见 §8 批次 1 进度表。

---

## 10. 附：给 AI 的硬规则清单

把本文的结论压缩成一份**可直接放进 `AGENTS.md` 的清单**，让 AI 每次改代码都被约束：

```
【分层】
1. 平台的表在 platform/，主题的表在 extensions/theme/，不得互访
2. 主题与插件互不可见，只能通过平台提供的接口交互
3. shared/ 里的代码不得 import 任何业务层

【多语言】
4. 任何数据访问函数必须显式接收 locale 与 siteId，不得有默认值
5. 语言查询的回退顺序：当前语言 → 站点默认 → 空。不抛错
6. 显式语言的 URL（/en/x）找不到时返回 404，不回退
7. 语言包 key 必须带前缀：core. / theme.{slug}. / plugin.{slug}.
8. 界面语言与内容语言是两件事，不得混用

【主题/插件】
9. 主题不得直接写 SQL，只能用 host.table() facade
10. 表名由平台生成（theme_{owner}_{table}），不得硬编码
11. 后台表单由声明生成，不得手写
12. 鉴权由平台施加，不得在主题/插件里自己验证
13. 只读所属主题/插件声明过的表，访问其他表必须失败

【改代码前】
14. 先跑 npm test，确认基线是绿的
15. 改完再跑 npm test 与 npx tsc --noEmit，两个都必须绿
16. 如果改了扩展的声明能力，同步更新 tests/architecture.test.mjs
```
