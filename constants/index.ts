import {
  Camera,
  Database,
  Globe,
  Image as ImageIcon,
  Map,
  Package,
  Puzzle,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

import type { HomeQuickAction } from "@/types";
import type { TranslationKey } from "@/components/i18n/use-i18n";
import { GAME_SETTINGS_FEATURE_NAV } from "@/app/game-settings/feature-nav";

/**
 * 动画过渡时长常量 (ms)
 */
export const TRANSITION_DURATION = {
  /** 页面切换过渡时长 */
  PAGE_TRANSITION: 700,
  /** 主题切换动画时长 */
  THEME_TOGGLE: 300,
  /** 通用组件过渡时长 */
  DEFAULT: 200,
} as const;

/**
 * 布局尺寸常量
 */
export const LAYOUT = {
  /** 侧边栏宽度 (px) */
  SIDEBAR_WIDTH: 56,
  /** 主页面左右卡片宽度比例 */
  CARD_WIDTH_RATIO: "1/4",
  /** 最小触摸区域尺寸 (px) */
  MIN_TOUCH_TARGET: 44,
} as const;

/**
 * 路由配置
 */
export const ROUTES = {
  HOME: "/",
  LAUNCH: "/launch",
  DOWNLOAD: "/download",
  TOOLS: "/tools",
  SETTINGS: "/settings",
  INSTANCE_SETTINGS: {
    ROOT: "/instance-settings",
    MODS: "/instance-settings/mods",
    WORLDS: "/instance-settings/worlds",
    RESOURCES: "/instance-settings/resources",
    SHADERS: "/instance-settings/shaders",
    SCREENSHOTS: "/instance-settings/screenshots",
    SCHEMATICS: "/instance-settings/schematics",
  },
} as const;

/**
 * 本地存储键名
 */
export const STORAGE_KEYS = {
  /** 当前视图状态 */
  CURRENT_VIEW: "openx-currentView",
  /** 主题设置 */
  THEME: "theme",
} as const;

/** Legacy localStorage keys kept for one-time migration reads. */
export const LEGACY_STORAGE_KEYS = {
  CURRENT_VIEW: "rtl-currentView",
} as const;

/**
 * Z-index 层级
 */
export const Z_INDEX = {
  SIDEBAR: 10,
  HEADER: 10,
  DIALOG: 50,
  TOAST: 100,
} as const;

/**
 * 首页快捷入口配置（数据驱动，新增入口只需在此追加）
 */
const homeQuickAction = (
  href: string,
  titleKey: TranslationKey,
  descriptionKey: TranslationKey,
  icon: LucideIcon,
  iconClassName: string,
): HomeQuickAction => ({ href, titleKey, descriptionKey, icon, iconClassName });

/** 存档管理 accent（游戏设置 · 存档 + 主页快速入口） */
export const GAME_SETTINGS_WORLDS_ICON_BG = "bg-[#33f1ff]/10";
export const GAME_SETTINGS_WORLDS_ICON_TEXT = "text-[#33f1ff]";
export const GAME_SETTINGS_WORLDS_ICON_CLASS = `${GAME_SETTINGS_WORLDS_ICON_BG} ${GAME_SETTINGS_WORLDS_ICON_TEXT}`;

export const GAME_SETTINGS_RESOURCES_ICON_BG = "bg-sky-500/10";
export const GAME_SETTINGS_RESOURCES_ICON_TEXT = "text-sky-500";

export const GAME_SETTINGS_SCHEMATICS_ICON_BG = "bg-[#db0000]/10";
export const GAME_SETTINGS_SCHEMATICS_ICON_TEXT = "text-[#db0000]";

/** 游戏设置各子页 ResourcePanel / 页头图标背景（与各 game-settings 子页 page.tsx 一致） */
export const GAME_SETTINGS_SECTION_ICON_CLASS = {
  mods: "bg-emerald-500/10 text-emerald-500",
  resources: `${GAME_SETTINGS_RESOURCES_ICON_BG} ${GAME_SETTINGS_RESOURCES_ICON_TEXT}`,
  shaders: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  worlds: GAME_SETTINGS_WORLDS_ICON_CLASS,
  datapacks: "bg-amber-500/10 text-amber-500",
  schematics: `${GAME_SETTINGS_SCHEMATICS_ICON_BG} ${GAME_SETTINGS_SCHEMATICS_ICON_TEXT}`,
  screenshots: "bg-pink-500/10 text-pink-500",
} as const;

export const GAME_SETTINGS_EXPORT_ICON_BG = "bg-[#dbdb00]/10";
export const GAME_SETTINGS_EXPORT_ICON_TEXT = "text-[#dbdb00]";
export const GAME_SETTINGS_EXPORT_ICON_CLASS = `${GAME_SETTINGS_EXPORT_ICON_BG} ${GAME_SETTINGS_EXPORT_ICON_TEXT}`;

/** 首页 Mod 快捷入口（与游戏设置 · 模组页一致，单独保留 emerald 语义） */
export const HOME_MOD_QUICK_ICON_CLASS =
  "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";

export const HOME_EXPORT_QUICK_ICON_CLASS = GAME_SETTINGS_EXPORT_ICON_CLASS;

const HOME_QUICK_ACTION_BY_HREF: Record<string, HomeQuickAction> = {
  "/game-settings/export": homeQuickAction(
    "/game-settings/export",
    "gameSettings.exportInstance",
    "gameSettings.exportInstanceHint",
    Package,
    HOME_EXPORT_QUICK_ICON_CLASS,
  ),
  "/game-settings/mods": homeQuickAction(
    "/game-settings/mods",
    "home.cardGrid.mods",
    "home.cardGrid.manageYourMods",
    Puzzle,
    HOME_MOD_QUICK_ICON_CLASS,
  ),
  "/game-settings/resources": homeQuickAction(
    "/game-settings/resources",
    "home.cardGrid.resourcePacks",
    "home.cardGrid.manageGameTextures",
    ImageIcon,
    GAME_SETTINGS_SECTION_ICON_CLASS.resources,
  ),
  "/game-settings/worlds": homeQuickAction(
    "/game-settings/worlds",
    "home.cardGrid.worlds",
    "home.cardGrid.manageWorldSaves",
    Globe,
    GAME_SETTINGS_SECTION_ICON_CLASS.worlds,
  ),
  "/game-settings/shaders": homeQuickAction(
    "/game-settings/shaders",
    "home.cardGrid.shaders",
    "home.cardGrid.enhancedVisualEffects",
    Sparkles,
    GAME_SETTINGS_SECTION_ICON_CLASS.shaders,
  ),
  "/game-settings/datapacks": homeQuickAction(
    "/game-settings/datapacks",
    "gameSettings.datapacks",
    "gameSettings.manageMinecraftDatapacks",
    Database,
    GAME_SETTINGS_SECTION_ICON_CLASS.datapacks,
  ),
  "/game-settings/schematics": homeQuickAction(
    "/game-settings/schematics",
    "home.cardGrid.schematics",
    "home.cardGrid.manageBuildingDesigns",
    Map,
    GAME_SETTINGS_SECTION_ICON_CLASS.schematics,
  ),
  "/game-settings/screenshots": homeQuickAction(
    "/game-settings/screenshots",
    "home.cardGrid.screenshots",
    "home.cardGrid.manageGameScreenshots",
    Camera,
    GAME_SETTINGS_SECTION_ICON_CLASS.screenshots,
  ),
};

/** 与游戏设置顶栏子功能顺序一致（不含下载、游戏管理） */
const HOME_QUICK_ACCESS_HREFS = [
  ...GAME_SETTINGS_FEATURE_NAV.map((item) => item.href),
] as const;

export const HOME_QUICK_ACCESS_ACTIONS: HomeQuickAction[] =
  HOME_QUICK_ACCESS_HREFS.map((href) => {
    const action = HOME_QUICK_ACTION_BY_HREF[href];
    if (!action) {
      throw new Error(`Missing home quick action for ${href}`);
    }
    return action;
  });
