import {
  isWithinSameLayoutSection,
  normalizeAppPathname,
} from "@/lib/main-navigation-transition";

/** 与 `app/game-settings/feature-nav` 中 `GAME_SETTINGS_CORE_HREF` 保持一致 */
export const GAME_SETTINGS_CORE_PATH = "/game-settings";

/** 从游戏设置其它子页切到「核心设置」：硬刷新且跳过顶栏入场动画 */
export function isNavigatingToGameSettingsCore(
  current: string,
  target: string,
): boolean {
  const from = normalizeAppPathname(current);
  const to = normalizeAppPathname(target);
  if (to !== GAME_SETTINGS_CORE_PATH) return false;
  if (from === to) return false;
  return (
    isWithinSameLayoutSection(from, to) &&
    from.startsWith(`${GAME_SETTINGS_CORE_PATH}/`)
  );
}
