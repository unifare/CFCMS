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
  "core.action.login": "Log in",
  "core.action.search": "Search",
  "core.action.refresh": "Refresh",
  "core.action.addLanguage": "Add language",

  // -- content ------------------------------------------------------------
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
};

/** Bundled packs, keyed by the exact locale code they translate. */
export const CORE_PACKS: Record<string, Pack> = {
  en: EN,
  "zh-CN": ZH_CN,
};

/** The locales a platform pack ships for. Used by the admin language picker. */
export function corePackLocales(): string[] {
  return Object.keys(CORE_PACKS);
}
