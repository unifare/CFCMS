/**
 * Screen registry — the page-name → screen table the shell dispatches through.
 *
 * This is the only module that imports every screen, and nothing imports it
 * except the entry point. Two names are special and handled by the shell
 * itself: `cpt:<type>` and `menu:<id>`.
 */
import dashboard from "./dashboard.js";
import { contentList } from "./content-list.js";
import media from "./media.js";
import resources from "./resources.js";
import urls from "./urls.js";
import settings from "./settings.js";
import seo from "./seo.js";
import sites from "./sites.js";
import users from "./users.js";
import search from "./search.js";
import menus from "./menus.js";
import widgets from "./widgets.js";
import themes from "./themes.js";
import plugins from "./plugins.js";
import languages from "./languages.js";
import themeMenuScreen from "./theme-menu.js";

export const SCREENS = {
  dashboard,
  search,
  activity: (c) => resources(c, "activity", "Activity"),
  posts: (c) => contentList(c, "posts"),
  pages: (c) => contentList(c, "pages"),
  media,
  appearance: themes,
  menus,
  widgets,
  plugins,
  languages,
  sites,
  users,
  seo,
  urls,
  settings,

  // Targets of the dynamic `cpt:` / `menu:` prefixes, resolved by the shell.
  "content-list": contentList,
  "theme-menu": themeMenuScreen,
};
