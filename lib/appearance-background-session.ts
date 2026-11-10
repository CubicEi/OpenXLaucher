/** 页面背景：与会话绑定，仅在启动时绘制；修改需重启（与主题色一致）。 */

import type { BackgroundConfig } from "@/components/settings/settings-provider";

export type SessionBackground = {
  imageObjectUrl?: string;
  opacity: number;
  blur: number;
};

const DEFAULT_SESSION: SessionBackground = {
  opacity: 0.55,
  blur: 6,
};

let sessionBackground: SessionBackground = { ...DEFAULT_SESSION };
let sessionBackgroundLocked = false;

/** 从 `url("...")` / `url('...')` 解析出 URL 字符串 */
export function parseAppBgCssUrl(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "none") return undefined;
  const match = /^url\((.*)\)$/.exec(trimmed);
  if (!match) return undefined;
  let inner = match[1].trim();
  if (
    (inner.startsWith('"') && inner.endsWith('"')) ||
    (inner.startsWith("'") && inner.endsWith("'"))
  ) {
    inner = inner.slice(1, -1);
  }
  return inner.length > 0 ? inner : undefined;
}

export function getSessionBackground(): Readonly<SessionBackground> {
  return sessionBackground;
}

export function lockSessionBackground(config: SessionBackground): void {
  if (sessionBackgroundLocked) return;
  sessionBackground = {
    opacity: config.opacity,
    blur: config.blur,
    imageObjectUrl: config.imageObjectUrl,
  };
  sessionBackgroundLocked = true;
  markSessionBackgroundLocked();
}

export function applySessionBackgroundToDom(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const body = document.body;
  const bg = sessionBackground;
  const hasImage = !!bg.imageObjectUrl && bg.imageObjectUrl.length > 0;

  if (hasImage) {
    root.style.setProperty("--app-bg", `url(${JSON.stringify(bg.imageObjectUrl)})`);
    root.style.setProperty("--app-bg-opacity", bg.opacity.toFixed(2));
    root.style.setProperty("--app-bg-blur", `${Math.round(bg.blur)}px`);
    body.setAttribute("data-app-bg", "active");
  } else {
    root.style.setProperty("--app-bg", "none");
    body.removeAttribute("data-app-bg");
  }
  root.setAttribute("data-session-background", hasImage ? "active" : "none");
}

export function markSessionBackgroundLocked(): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-session-background-locked", "");
}

export function reapplySessionBackgroundToDom(): void {
  applySessionBackgroundToDom();
}

/** 启动时优先采用 bootstrap 已绘制的 URL，避免重复 createObjectURL */
export function captureSessionBackgroundFromDom(
  fallback: BackgroundConfig,
): SessionBackground {
  const root = document.documentElement;
  const fromCss = parseAppBgCssUrl(getComputedStyle(root).getPropertyValue("--app-bg"));
  const opacityRaw = root.style.getPropertyValue("--app-bg-opacity");
  const blurRaw = root.style.getPropertyValue("--app-bg-blur");
  const opacity = opacityRaw ? parseFloat(opacityRaw) : fallback.opacity;
  const blurMatch = blurRaw.match(/([\d.]+)/);
  const blur = blurMatch ? parseInt(blurMatch[1], 10) : fallback.blur;

  return {
    imageObjectUrl: fromCss ?? fallback.imageObjectUrl,
    opacity: Number.isFinite(opacity) ? opacity : fallback.opacity,
    blur: Number.isFinite(blur) ? blur : fallback.blur,
  };
}

export function backgroundHasImageFlag(bg: {
  hasStoredImage?: boolean;
  imageObjectUrl?: string;
}): boolean {
  return !!bg.hasStoredImage || (!!bg.imageObjectUrl && bg.imageObjectUrl.length > 0);
}

export function savedBackgroundNeedsRestart(saved: BackgroundConfig): boolean {
  const sess = sessionBackground;
  const savedHas = backgroundHasImageFlag(saved);
  const sessHas = !!sess.imageObjectUrl;
  if (savedHas !== sessHas) return true;
  if (Math.abs(saved.opacity - sess.opacity) > 0.005) return true;
  if (Math.round(saved.blur) !== Math.round(sess.blur)) return true;
  return false;
}

export function draftBackgroundDiffersFromSaved(
  draft: BackgroundConfig,
  saved: BackgroundConfig,
): boolean {
  const draftHas = backgroundHasImageFlag(draft);
  const savedHas = backgroundHasImageFlag(saved);
  if (draftHas !== savedHas) return true;
  if (Math.abs(draft.opacity - saved.opacity) > 0.005) return true;
  if (Math.round(draft.blur) !== Math.round(saved.blur)) return true;
  return false;
}
