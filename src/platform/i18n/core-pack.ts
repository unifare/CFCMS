/**
 * Layer ① of the UI dictionary: the strings the platform itself ships.
 *
 * Why this is TypeScript rather than `langs/{locale}.json` like a theme's pack:
 * a core pack must be present in *every* deployment, including one where R2 is
 * empty (a fresh `wrangler dev`). Loading it from storage would make the admin
 * fall back to raw keys exactly when the system is least understood. Bundled as
 * code it is always there, and the compiler checks its shape.
 *
 * Theme and plugin packs are *not* here — they live next to their extension and
 * are layered on top by `packs.ts`.
 *
 * Keys are namespaced `core.*` (§10 rule 7). A key without a prefix would be
 * indistinguishable from a theme's key once the dictionaries are merged.
 */
export type Pack = Record<string, string>;

const EN: Pack = {
  // -- navigation ---------------------------------------------------------
  "core.nav.dashboard": "Dashboard",
  "core.nav.content": "Content",
  "core.nav.media": "Media",
  "core.nav.appearance": "Appearance",
  "core.nav.plugins": "Plugins",
  "core.nav.languages": "Languages",
  "core.nav.sites": "Sites",
  "core.nav.users": "Users",
  "core.nav.settings": "Settings",
  "core.nav.seo": "SEO",
  "core.nav.tools": "Tools",
  "core.nav.general": "General",
  "core.nav.system": "System",
  "core.nav.search": "Search",
  "core.nav.activity": "Activity",
  "core.nav.posts": "Posts",
  "core.nav.pages": "Pages",
  "core.nav.themes": "Themes",
  "core.nav.menus": "Menus",
  "core.nav.widgets": "Widgets",
  "core.nav.urls": "URL Manager",
  "core.nav.fromTheme": "From theme",
  "core.nav.extensions": "Extensions",

  // -- actions ------------------------------------------------------------
  "core.action.save": "Save",
  "core.action.cancel": "Cancel",
  "core.action.delete": "Delete",
  "core.action.edit": "Edit",
  "core.action.create": "Create",
  "core.action.upload": "Upload",
  "core.action.activate": "Activate",
  "core.action.deactivate": "Deactivate",
  "core.action.logout": "Log out",
  "core.action.login": "Sign in",
  "core.action.search": "Search",
  "core.action.refresh": "Refresh",
  "core.action.addLanguage": "Add language",
  "core.action.switchSite": "Switch site",
  "core.action.manageSites": "Manage sites",
  "core.action.manageUsers": "Manage users",
  "core.action.siteSettings": "Site settings",
  "core.action.accountSettings": "Account settings",
  "core.action.configureMenu": "Configure menu",
  "core.action.theme": "Theme",

  // -- theme picker -------------------------------------------------------
  "core.theme.light": "Light",
  "core.theme.dark": "Dark",
  "core.theme.system": "System",

  // -- sign-in ------------------------------------------------------------
  "core.auth.title": "Sign in to CFPress",
  "core.auth.subtitle": "Manage content, themes and sites.",
  "core.auth.username": "Username",
  "core.auth.password": "Password",
  "core.auth.defaultHint": "First login default: admin / change-me-now. Change it before production use.",
  "core.auth.failed": "Sign-in failed",

  // -- account (self-service credentials) ---------------------------------
  "core.account.title": "Account",
  "core.account.sub": "Change your own login credentials. They apply to every site on this install.",
  "core.account.changePassword": "Change password",
  "core.account.currentPassword": "Current password",
  "core.account.newPassword": "New password",
  "core.account.confirmPassword": "Confirm new password",
  "core.account.changeUsername": "Change username",
  "core.account.username": "Username",
  "core.account.usernameHint": "3–32 characters: letters, digits, dot, dash, underscore.",

  // -- menu configuration -------------------------------------------------
  "core.menuConfig.title": "Menu",
  "core.menuConfig.group": "Group",
  "core.menuConfig.siteHidden": "Hidden for everyone",
  "core.menuConfig.siteVisible": "Shown to everyone",
  "core.menuConfig.resetItem": "Reset",
  "core.menuConfig.resetAll": "Reset to defaults",
  "core.menuConfig.resetConfirm": "Clear all custom names, ordering and hiding?",
  "core.menuConfig.readonlyHint": "Read-only — editing the site menu needs the settings.manage permission.",

  // -- editor block palette (one list, rendering/blocks.ts CORE_BLOCKS) ----
  "core.block.paragraph": "Paragraph",
  "core.block.heading": "Heading",
  "core.block.list": "List",
  "core.block.quote": "Quote",
  "core.block.code": "Code",
  "core.block.image": "Image",
  "core.block.gallery": "Gallery",
  "core.block.button": "Button",
  "core.block.separator": "Separator",
  "core.block.html": "HTML",
  "core.block.group": "Group",
  "core.block.columns": "Columns",
  // Block *attribute* labels. One per attribute rather than one per type: the
  // same `text` type is "Heading text" on a heading and "Alt text" on an image.
  // Declared in `rendering/blocks.ts` (`labelKey`), resolved server-side by
  // `GET /api/v1/blocks`, so the editor ships no English of its own.
  "core.block.field.text": "Text",
  "core.block.field.heading": "Heading text",
  "core.block.field.list": "One item per line",
  "core.block.field.quote": "Quote",
  "core.block.field.code": "Code",
  "core.block.field.imageUrl": "Image",
  "core.block.field.imageAlt": "Alt text",
  "core.block.field.gallery": "Images",
  "core.block.field.buttonLabel": "Label",
  "core.block.field.buttonUrl": "Link",
  "core.block.field.html": "HTML",
  // -- media picker (the one control for choosing a file) ------------------
  "core.media.choose": "Choose from library",
  "core.media.pickHint": "Pick a file already in this site's library, or upload a new one.",
  "core.media.use": "Use selected",
  "core.media.uploading": "Uploading…",
  "core.media.files": "files",
  "core.media.empty": "No media uploaded yet.",
  "core.media.addRow": "Add row",
  "core.media.multiHint": "One URL per line",
  // -- content ------------------------------------------------------------
  "core.dashboard.posts": "Posts",
  "core.dashboard.pages": "Pages",
  "core.dashboard.media": "Media",
  "core.dashboard.drafts": "Drafts",
  "core.dashboard.published": "published",
  "core.dashboard.awaiting": "awaiting review",
  "core.content.title": "Title",
  "core.content.slug": "Slug",
  "core.content.status": "Status",
  "core.content.published": "Published",
  "core.content.draft": "Draft",
  "core.content.empty": "No content yet.",
  "core.content.new": "New content",
  "core.content.translations": "Language versions",
  "core.content.createTranslation": "Create translation",
  "core.content.switchOnly": "Switch only",

  // -- languages ----------------------------------------------------------
  "core.locale.default": "Default language",
  "core.locale.enabled": "Enabled",
  "core.locale.disabled": "Disabled",
  "core.locale.code": "Code",
  "core.locale.nativeName": "Name",
  "core.locale.direction": "Direction",
  "core.locale.multilingual": "This site serves more than one language.",
  "core.locale.monolingual": "This site serves a single language.",

  // -- messages -----------------------------------------------------------
  "core.msg.saved": "Saved.",
  "core.msg.deleted": "Deleted.",
  "core.msg.loading": "Loading…",
  "core.msg.notFound": "Not found.",
  "core.msg.forbidden": "You do not have permission to do that.",
  "core.msg.searchPlaceholder": "Search…",
  "core.msg.notifications": "Notifications",
  "core.msg.notifHint": "Autosave is on for drafts you open in the editor. Revisions are kept per locale.",
  "core.msg.switchedTo": "Switched to {name}",
  "core.msg.wentWrong": "Something went wrong",
  "core.msg.notAScreen": "is not a screen.",
  "core.msg.passwordChanged": "Password changed.",
  "core.msg.usernameChanged": "Username changed.",
  "core.msg.passwordMismatch": "The new passwords do not match.",
  "core.err.wrongCurrent": "The current password is not correct.",
  "core.err.passwordShort": "The new password must be at least 8 characters.",
  "core.err.usernameTaken": "That username is already in use.",
  "core.err.usernameInvalid": "That username is not allowed.",
};

const ZH_CN: Pack = {
  "core.nav.dashboard": "仪表盘",
  "core.nav.content": "内容",
  "core.nav.media": "媒体",
  "core.nav.appearance": "外观",
  "core.nav.plugins": "插件",
  "core.nav.languages": "语言",
  "core.nav.sites": "站点",
  "core.nav.users": "用户",
  "core.nav.settings": "设置",
  "core.nav.seo": "SEO",
  "core.nav.tools": "工具",
  "core.nav.general": "常规",
  "core.nav.system": "系统",
  "core.nav.search": "搜索",
  "core.nav.activity": "活动",
  "core.nav.posts": "文章",
  "core.nav.pages": "页面",
  "core.nav.themes": "主题",
  "core.nav.menus": "菜单",
  "core.nav.widgets": "小工具",
  "core.nav.urls": "URL 管理",
  "core.nav.fromTheme": "来自主题",
  "core.nav.extensions": "扩展",

  "core.action.save": "保存",
  "core.action.cancel": "取消",
  "core.action.delete": "删除",
  "core.action.edit": "编辑",
  "core.action.create": "新建",
  "core.action.upload": "上传",
  "core.action.activate": "启用",
  "core.action.deactivate": "停用",
  "core.action.logout": "退出登录",
  "core.action.login": "登录",
  "core.action.search": "搜索",
  "core.action.refresh": "刷新",
  "core.action.addLanguage": "添加语言",
  "core.action.switchSite": "切换站点",
  "core.action.manageSites": "管理站点",
  "core.action.manageUsers": "管理用户",
  "core.action.siteSettings": "站点设置",
  "core.action.accountSettings": "账户设置",
  "core.action.configureMenu": "菜单配置",
  "core.action.theme": "主题",

  "core.theme.light": "浅色",
  "core.theme.dark": "深色",
  "core.theme.system": "跟随系统",

  "core.auth.title": "登录 CFPress",
  "core.auth.subtitle": "管理内容、主题与站点。",
  "core.auth.username": "用户名",
  "core.auth.password": "密码",
  "core.auth.defaultHint": "首次登录默认账户：admin / change-me-now。正式使用前请修改。",
  "core.auth.failed": "登录失败",

  "core.account.title": "账户",
  "core.account.sub": "修改你自己的登录凭据。对本安装的所有站点生效。",
  "core.account.changePassword": "修改密码",
  "core.account.currentPassword": "当前密码",
  "core.account.newPassword": "新密码",
  "core.account.confirmPassword": "确认新密码",
  "core.account.changeUsername": "修改用户名",
  "core.account.username": "用户名",
  "core.account.usernameHint": "3–32 个字符：字母、数字、点、横线、下划线。",

  "core.menuConfig.title": "菜单",
  "core.menuConfig.group": "分组",
  "core.menuConfig.siteHidden": "已对所有人隐藏",
  "core.menuConfig.siteVisible": "对所有人显示",
  "core.menuConfig.resetItem": "恢复默认",
  "core.menuConfig.resetAll": "全部恢复默认",
  "core.menuConfig.resetConfirm": "清除所有自定义名称、排序与隐藏？",
  "core.menuConfig.readonlyHint": "只读：编辑站点菜单需要 settings.manage 权限。",

  "core.block.paragraph": "段落",
  "core.block.heading": "标题",
  "core.block.list": "列表",
  "core.block.quote": "引用",
  "core.block.code": "代码",
  "core.block.image": "图片",
  "core.block.gallery": "图库",
  "core.block.button": "按钮",
  "core.block.separator": "分隔线",
  "core.block.html": "HTML",
  "core.block.group": "组",
  "core.block.columns": "分栏",
  "core.block.field.text": "正文",
  "core.block.field.heading": "标题文字",
  "core.block.field.list": "每行一项",
  "core.block.field.quote": "引用文字",
  "core.block.field.code": "代码",
  "core.block.field.imageUrl": "图片",
  "core.block.field.imageAlt": "替代文字（alt）",
  "core.block.field.gallery": "图片（可多张）",
  "core.block.field.buttonLabel": "按钮文字",
  "core.block.field.buttonUrl": "链接地址",
  "core.block.field.html": "HTML",
  "core.media.choose": "从媒体库选择",
  "core.media.pickHint": "从本站媒体库中选一个文件，或上传新文件。",
  "core.media.use": "使用所选",
  "core.media.uploading": "上传中…",
  "core.media.files": "个文件",
  "core.media.empty": "还没有上传任何媒体。",
  "core.media.addRow": "加一行",
  "core.media.multiHint": "每行一个 URL",
  "core.dashboard.posts": "文章",
  "core.dashboard.pages": "页面",
  "core.dashboard.media": "媒体",
  "core.dashboard.drafts": "草稿",
  "core.dashboard.published": "已发布",
  "core.dashboard.awaiting": "待审核",
  "core.content.title": "标题",
  "core.content.slug": "别名",
  "core.content.status": "状态",
  "core.content.published": "已发布",
  "core.content.draft": "草稿",
  "core.content.empty": "还没有内容。",
  "core.content.new": "新建内容",
  "core.content.translations": "语言版本",
  "core.content.createTranslation": "创建翻译",
  "core.content.switchOnly": "仅切换",

  "core.locale.default": "默认语言",
  "core.locale.enabled": "已启用",
  "core.locale.disabled": "已停用",
  "core.locale.code": "代码",
  "core.locale.nativeName": "名称",
  "core.locale.direction": "书写方向",
  "core.locale.multilingual": "本站点提供多种语言。",
  "core.locale.monolingual": "本站点只提供一种语言。",

  "core.msg.saved": "已保存。",
  "core.msg.deleted": "已删除。",
  "core.msg.loading": "加载中…",
  "core.msg.notFound": "未找到。",
  "core.msg.forbidden": "你没有执行该操作的权限。",
  "core.msg.searchPlaceholder": "搜索…",
  "core.msg.notifications": "通知",
  "core.msg.notifHint": "编辑器中的草稿会自动保存。修订版本按语言分别保留。",
  "core.msg.switchedTo": "已切换到 {name}",
  "core.msg.wentWrong": "出了点问题",
  "core.msg.notAScreen": "不是一个有效的屏幕。",
  "core.msg.passwordChanged": "密码已修改。",
  "core.msg.usernameChanged": "用户名已修改。",
  "core.msg.passwordMismatch": "两次输入的新密码不一致。",
  "core.err.wrongCurrent": "当前密码不正确。",
  "core.err.passwordShort": "新密码至少需要 8 个字符。",
  "core.err.usernameTaken": "该用户名已被占用。",
  "core.err.usernameInvalid": "该用户名不符合要求。",
};

/** Bundled packs, keyed by the exact locale code they translate. */
export const CORE_PACKS: Record<string, Pack> = {
  en: EN,
  "zh-CN": ZH_CN,
};

/**
 * Native display names for the bundled core packs — a switcher shows a
 * language's own name, not its code. Bundled packs are the *complete*
 * baseline of the UI language list; languages added through the Languages
 * screen join the same list as data (see `availableUiLocaleEntries` in
 * packs.ts) without any code change, degrading to English per key until
 * their overrides are filled in.
 */
export const CORE_PACK_NAMES: Record<string, string> = {
  en: "English",
  "zh-CN": "简体中文",
};

/** The locales a platform pack ships for. Used by the admin language picker. */
export function corePackLocales(): string[] {
  return Object.keys(CORE_PACKS);
}
