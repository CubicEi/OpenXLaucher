import type { Translation } from "@/components/i18n/use-i18n";

/** 游戏设置子功能入口（顶部导航与核心页词条列表共用） */
export const GAME_SETTINGS_FEATURE_NAV = [
  { href: "/game-settings/mods", label: "panel.mods" as Translation },
  {
    href: "/game-settings/resources",
    label: "home.cardGrid.resourcePacks" as Translation,
  },
  { href: "/game-settings/worlds", label: "gameSettings.worlds" as Translation },
  {
    href: "/game-settings/shaders",
    label: "home.cardGrid.shaders" as Translation,
  },
  {
    href: "/game-settings/datapacks",
    label: "gameSettings.datapacks" as Translation,
  },
  {
    href: "/game-settings/schematics",
    label: "home.cardGrid.schematics" as Translation,
  },
  {
    href: "/game-settings/screenshots",
    label: "home.cardGrid.screenshots" as Translation,
  },
] as const;

export const GAME_SETTINGS_CORE_HREF = "/game-settings";
