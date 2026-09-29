# 插件开发指南

面向要写一个 CFPress 插件的人。先读 [`ARCHITECTURE.md`](ARCHITECTURE.md) §4（扩展模型）、
§5.3（清单校验）、§7.3（分层红线）。

> **最重要的一条，先说**：
> **插件不携带可执行代码。** 它**声明**它想要哪些 hook、哪些能力、
> 哪些后台菜单；**实现由宿主提供**。
>
> 这不是限制，是**根约束**推出来的必然结果（见下）。

---

## 1. 为什么插件不能带代码

Cloudflare Workers 的隔离环境**禁止 `eval` / `new Function` / 动态 `import()` 用户代码**。
一个"上传 JS 然后执行"的插件系统在这里**根本跑不起来**。

所以 CFPress 的插件模型是：

```
插件声明： "我要 beforeRender 和 html 这两个 hook，我要 settings.read 这个能力"
宿主实现： beforeRender → 页面渲染前触发；html → 改写最终文档；…
```

于是插件的能力边界 = **宿主实现了哪些 hook**，这是一份**封闭的、可枚举的**清单。

**好处不只是"能跑"**：

- 插件**不可能**读到它没声明的东西（没有代码去读）
- 插件**不可能**把站点搞 500（每个调用点都 try/catch，失败=静默降级）
- 升级平台不会让插件链式崩掉（没有代码依赖内部 API）

⚠️ **声明一个宿主不实现的 hook，安装会失败。**
以前它会**安装成功、启用成功、报告 active，然后什么也不做**——
拼错 `beforRender` 是排查起来最痛苦的一类 bug。现在名单在 `contract/hooks.ts`，
校验器与运行时读**同一份**。

---

## 2. 一个插件长什么样

```
plugins/my-plugin/
├── plugin.json       清单（唯一必需的文件）
└── README.md
```

```bash
npm run make:plugin -- my-plugin
```

### `plugin.json`

```jsonc
{
  "name": "my-plugin",            // 必须与目录名一致
  "title": "My Plugin",
  "version": "1.0.0",
  "description": "…",

  "permissions": ["content.read", "settings.read", "settings.write"],

  // 声明的 hook 必须在 DECLARABLE_HOOKS 里，否则安装失败
  "hooks": ["beforeRender", "html"],

  // 后台菜单：零后台代码
  "adminMenus": [
    { "id": "my-plugin-settings", "label": "My Plugin", "icon": "chart",
      "screen": "plugin-settings", "capability": "settings.read" }
  ],

  // 内联语言包（插件没有目录可读，见 §6）
  "langs": {
    "en":  { "plugin.my-plugin.title": "My Plugin" },
    "zh-CN": { "plugin.my-plugin.title": "我的插件" }
  },

  "settings": [
    { "key": "greeting", "label": "Greeting", "type": "text", "default": "Hello" }
  ]
}
```

---

## 3. 可声明的 hook（全部 7 个）

`DECLARABLE_HOOKS` 是**封闭清单**。`tests/architecture.test.mjs` 把它与
`HOOK_IMPLS` 钉在一起，所以**它们不可能漂移**。

| hook | 类型 | 时机 | 用途 |
|---|---|---|---|
| `beforeRender` | action | 主题页渲染**前** | 副作用：缓存预热、计数。**每个前台请求都会跑，保持轻** |
| `html` | filter | 渲染后、发送前 | **最后**改写整个文档。SEO 注入 `<head>` 走这里 |
| `head` | filter | 收集 `<head>` 追加内容 | 贡献原始 `<head>` 标记 |
| `beforeSavePost` | filter | 内容写入前 | 拿到 payload，可规范化字段。返回非对象=不改 |
| `afterSavePost` | action | 内容写入后 | 副作用：索引。拿到 post id + site |
| `beforeDeletePost` | action | 内容删除前 | 清理派生数据 |
| `shortcode` | filter | 展开 `[shortcode]` 时 | 拿到 `{name, attrs, body}`，返回标记 |

**action vs filter**：action 是**副作用**（返回值被忽略）；filter 是**变换**（返回值就是结果）。
搞混的后果是"篹写了但没生效"，而**没有任何报错**。

### `html` 是最常用的一个

```jsonc
{ "hooks": ["html"], "settings": [{ "key": "title_template", "type": "text", "default": "%title% | %site%" }] }
```

宿主实现会读出插件设置、拼出 `<head>` 片段、插进 `</head>` 之前。
内置的 `plugins/seo/` 就是这么一个插件——**它的全部实现就是一份 `plugin.json`**。
去读它，比读文档快。

---

## 4. 权限（capabilities）

插件声明的 `permissions` 决定它能请求哪些宿主能力。**过度申请会在安装时被拒**。
原则：**只申请你真正用到的**。

| 权限 | 含义 |
|---|---|
| `content.read` | 读内容 |
| `settings.read` / `settings.write` | 读写设置 |
| `site.read` | 读站点信息 |
| `menu.read` | 读菜单 |

**权限清单与 `CAPABILITIES` 常量同源**（`contract/capabilities.ts`）。
加一个能力要同时改常量、校验器、和真的实现——**没有实现的能力就是个谎**。

---

## 5. 后台菜单：零后台代码

```jsonc
{ "id": "my-plugin-settings", "label": "My Plugin", "icon": "chart",
  "screen": "plugin-settings", "capability": "settings.read" }
```

| 屏幕 | 用途 |
|---|---|
| `plugin-settings` | 打开**插件自己**声明的设置（`settings[]`） |
| `table-list` / `table-edit` | 打开一张**扩展自有表**（见 §7） |
| `custom` | 打开自定义视图（`args.view`） |

**可用的屏幕名是封闭清单** `ALLOWED_ADMIN_SCREENS`（10 个）。
写个不存在的屏幕名 → 安装失败。**能生成的屏幕就别自己写**——
`plugin-settings` 会按 `settings[]` 的 `type` 自动渲染表单控件。

⚠️ **`table-list` / `table-edit` 需要 `args.table` 指向一张已声明的表**，
否则安装被拒（"引用了未声明的表"）。

### 能力门控

`capability` 字段让"不可用的菜单"根本不可能出现：没有该能力的用户**看不到**这个菜单项，
而不是看到了、点进去、得到一个 403。

---

## 6. 语言包：必须内联

`uploadExtension` 把**主题**的文件解包进 R2，但**插件包按 zip 原样存、从不解包**。
所以插件**没有 `langs/` 目录可读**，只能把语言包内联在 `plugin.json` 的 `langs{}` 里。

key **必须**带 `plugin.my-plugin.` 前缀。两个插件定义同名 key 时，
谁生效取决于加载顺序，而且**没有正确的修复位置**。

---

## 7. 插件自有表（⚠️ 当前会被拒绝）

**决策已定**（§9 决策 3：与主题同机制，表名 `plugin_{slug}_{table}`），
但**落地未完成**：`theme_table_defs` 目前只有 `theme_name` 一列，
支持插件必须把它泛化成 owner 概念——那是**表重建**（SQLite 不能 `ALTER` 主键/UNIQUE）。

**在此之前，插件声明 `tables[]` 会被校验器明确拒绝**（不是静默忽略——
静默忽略比拒绝更危险，作者会以为表建好了）。

需要带数据的插件，现在的替代方案：

1. 用 `settings` 存配置（**推荐**）
2. 让主题声明那张表（主题本来就能声明）
3. 用 `custom` 屏幕 + 自己的 Worker（外部数据）

---

## 8. 生命周期与调试

```bash
curl -X POST "$BASE/api/v1/extensions/bootstrap" -b cookies.txt      # 播种内置插件
curl "$BASE/api/v1/extensions/plugins" -b cookies.txt                # 列表
curl -X POST "$BASE/api/v1/extensions/plugins/seo/enable"  -b cookies.txt
curl -X POST "$BASE/api/v1/extensions/plugins/seo/disable" -b cookies.txt
```

### 两条必须知道的行为

1. **插件是「安装级」的，不是「按站点」的**。
   主题按站点激活 → 主题菜单按站点；插件只有一个 `enabled` 标志 → 菜单写一次
   `site_id='*'`，读时 `site_id=? OR site_id='*'`。**新站点上插件菜单无需额外步骤即可见。**

2. **插件失败绝不 500**。每个调用点都 try/catch，失败=静默降级，
   文档回退到上一阶段产出的 HTML。**站点活着比插件正确重要。**

### 排查清单

| 症状 | 查这里 |
|---|---|
| 插件"启用了"但没效果 | 声明的 hook 名对不对（拼错现在安装就失败）；action/filter 有没有搞反 |
| 菜单不出现 | `capability` 是不是当前用户没有的能力 |
| 设置页是空的 | `settings[]` 声明了吗；`screen` 是不是 `plugin-settings` |
| 装不上 | 校验器抛的错；权限是否过度申请 |
| 改了没反应 | `loadEnabledPlugins` 有 5 秒缓存；重启 `wrangler dev` |

---

## 9. 写代码时的分层规则

插件侧代码在 `src/extensions/plugin/`：`runtime.ts`（hook 实现）、`packs.ts`、`menus.ts`。

| 规则 | 说明 |
|---|---|
| `plugin/` **不得 import** `theme/` | 两者互相独立可安装 |
| 需要主题的信息 → 走 `contract/hooks.ts` | 依赖倒置，见该文件的注释 |
| **不得直接写 SQL** | 用宿主 facade |
| 表名由平台生成 | **不得硬编码** |

`resetPluginRuntime()` 必须换**新的 `WeakMap`**（`WeakMap` 没有 `clear()`），
否则上一个用例的注册会泄漏到下一个。

---

## 10. 参考实现

| 插件 | 看什么 |
|---|---|
| `plugins/seo/` | 最小可用插件：一个 `html` hook + 两个设置 + 一个设置屏 |
| `plugins/shortcodes/` | `shortcode` hook |
| `plugins/example/` | 最简清单骨架 |

```bash
node tests/plugin-hooks.test.mjs     # hook 生命周期
node tests/manifest-validation.test.mjs  # 清单校验（含"拼错 hook 必须失败"）
```
