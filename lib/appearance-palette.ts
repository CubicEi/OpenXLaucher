/** Shared appearance palette — used by SettingsProvider and the pre-paint bootstrap script. */

export type ThemeColor = "default" | string;
export type ThemeMode = "light" | "dark" | "system";

export const APPEARANCE_SETTINGS_STORAGE_KEY = "openxlauncher:settings:v4";
export const APPEARANCE_LEGACY_STORAGE_KEYS = [
  "openxlauncher:settings:v3",
  "rtlauncher:settings:v4",
  "rtlauncher:settings:v3",
] as const;

export type AppearancePalette = {
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  border: string;
  input: string;
  ring: string;
};

export const DEFAULT_LIGHT: AppearancePalette = {
  background: "oklch(1 0 0)",
  foreground: "oklch(0.147 0.004 49.25)",
  card: "oklch(1 0 0)",
  cardForeground: "oklch(0.147 0.004 49.25)",
  popover: "oklch(1 0 0)",
  popoverForeground: "oklch(0.147 0.004 49.25)",
  primary: "oklch(0.216 0.006 56.043)",
  primaryForeground: "oklch(0.985 0.001 106.423)",
  secondary: "oklch(0.97 0.001 106.424)",
  secondaryForeground: "oklch(0.216 0.006 56.043)",
  muted: "oklch(0.97 0.001 106.424)",
  mutedForeground: "oklch(0.553 0.013 58.071)",
  accent: "oklch(0.97 0.001 106.424)",
  accentForeground: "oklch(0.216 0.006 56.043)",
  border: "oklch(0.923 0.003 48.717)",
  input: "oklch(0.923 0.003 48.717)",
  ring: "oklch(0.709 0.01 56.259)",
};

export const DEFAULT_DARK: AppearancePalette = {
  background: "oklch(0.147 0.004 49.25)",
  foreground: "oklch(0.985 0.001 106.423)",
  card: "oklch(0.216 0.006 56.043)",
  cardForeground: "oklch(0.985 0.001 106.423)",
  popover: "oklch(0.216 0.006 56.043)",
  popoverForeground: "oklch(0.985 0.001 106.423)",
  primary: "oklch(0.923 0.003 48.717)",
  primaryForeground: "oklch(0.216 0.006 56.043)",
  secondary: "oklch(0.268 0.007 34.298)",
  secondaryForeground: "oklch(0.985 0.001 106.423)",
  muted: "oklch(0.268 0.007 34.298)",
  mutedForeground: "oklch(0.709 0.01 56.259)",
  accent: "oklch(0.268 0.007 34.298)",
  accentForeground: "oklch(0.985 0.001 106.423)",
  border: "oklch(0.294 0.005 56.043)",
  input: "oklch(0.334 0.005 56.043)",
  ring: "oklch(0.553 0.013 58.071)",
};

export function parseOklch(value: string): { l: number; c: number; h: number } | null {
  const m = value.match(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  if (!m) return null;
  return { l: parseFloat(m[1]), c: parseFloat(m[2]), h: parseFloat(m[3]) };
}

export function makeOklch(l: number, c: number, h: number, alpha?: number): string {
  if (alpha !== undefined && alpha < 1) {
    return `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(3)} / ${alpha.toFixed(2)})`;
  }
  return `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(3)})`;
}

export function derivePalette(primaryOklch: string, isDark: boolean): AppearancePalette {
  const primary = parseOklch(primaryOklch);
  if (!primary) {
    return isDark ? DEFAULT_DARK : DEFAULT_LIGHT;
  }

  const { l, c, h } = primary;

  if (!isDark) {
    const backgroundC = Math.min(0.008, c * 0.04);
    const cardC = Math.min(0.005, c * 0.025);
    const surfaceC = Math.min(0.012, c * 0.06);
    const borderC = Math.min(0.02, c * 0.1);
    const foregroundC = Math.min(0.01, c * 0.05);
    const mutedC = Math.min(0.018, c * 0.09);
    const accentC = Math.min(0.05, c * 0.22);

    return {
      background: makeOklch(0.995, backgroundC, h),
      foreground: makeOklch(0.15, foregroundC, h),
      card: makeOklch(0.995, cardC, h),
      cardForeground: makeOklch(0.15, foregroundC, h),
      popover: makeOklch(0.995, cardC, h),
      popoverForeground: makeOklch(0.15, foregroundC, h),
      primary: primaryOklch,
      primaryForeground: l < 0.55 ? makeOklch(0.99, 0.005, h) : makeOklch(0.15, foregroundC, h),
      secondary: makeOklch(0.96, surfaceC, h),
      secondaryForeground: makeOklch(0.25, Math.min(0.1, c * 0.45), h),
      muted: makeOklch(0.955, surfaceC, h),
      mutedForeground: makeOklch(0.5, mutedC, h),
      accent: makeOklch(0.95, accentC, h),
      accentForeground: makeOklch(0.25, Math.min(0.12, c * 0.5), h),
      border: makeOklch(0.91, borderC, h),
      input: makeOklch(0.91, borderC, h),
      ring: makeOklch(l + 0.1, c, h),
    };
  }

  const cardC = Math.min(0.04, c * 0.2);
  return {
    background: makeOklch(0.15, Math.min(0.03, c * 0.15), h),
    foreground: makeOklch(0.98, 0.005, h),
    card: makeOklch(0.22, cardC, h),
    cardForeground: makeOklch(0.98, 0.005, h),
    popover: makeOklch(0.22, cardC, h),
    popoverForeground: makeOklch(0.98, 0.005, h),
    primary: makeOklch(Math.min(0.92, l + 0.2), c, h),
    primaryForeground: makeOklch(0.22, cardC, h),
    secondary: makeOklch(0.28, Math.min(0.05, c * 0.25), h),
    secondaryForeground: makeOklch(0.92, c * 0.2, h),
    muted: makeOklch(0.3, Math.min(0.04, c * 0.2), h),
    mutedForeground: makeOklch(0.75, Math.min(0.08, c * 0.4), h),
    accent: makeOklch(0.26, Math.min(0.05, c * 0.25), h),
    accentForeground: makeOklch(0.9, Math.min(0.08, c * 0.4), h),
    border: makeOklch(0.314, cardC * 0.88, h),
    input: makeOklch(0.36, cardC * 0.82, h),
    ring: makeOklch(Math.min(0.78, l + 0.15), c, h),
  };
}

export function resolveIsDark(mode: ThemeMode | undefined): boolean {
  if (mode === "dark") return true;
  if (mode === "light") return false;
  if (typeof window !== "undefined") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  return false;
}

/** Theme color locked for this document session (set once at bootstrap / first apply). */
let sessionThemeColor: ThemeColor = "default";
let sessionThemeColorLocked = false;

export function getSessionThemeColor(): ThemeColor {
  return sessionThemeColor;
}

export function lockSessionThemeColor(themeColor: ThemeColor) {
  if (sessionThemeColorLocked) return;
  sessionThemeColor = themeColor === "default" || !themeColor ? "default" : themeColor;
  sessionThemeColorLocked = true;
}

export function applyThemeColorToDom(themeColor: ThemeColor, effectiveIsDark: boolean) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const colors =
    themeColor === "default"
      ? effectiveIsDark
        ? DEFAULT_DARK
        : DEFAULT_LIGHT
      : derivePalette(themeColor, effectiveIsDark);

  root.style.setProperty("--background", colors.background);
  root.style.setProperty("--foreground", colors.foreground);
  root.style.setProperty("--card", colors.card);
  root.style.setProperty("--card-foreground", colors.cardForeground);
  root.style.setProperty("--popover", colors.popover);
  root.style.setProperty("--popover-foreground", colors.popoverForeground);
  root.style.setProperty("--primary", colors.primary);
  root.style.setProperty("--primary-foreground", colors.primaryForeground);
  root.style.setProperty("--secondary", colors.secondary);
  root.style.setProperty("--secondary-foreground", colors.secondaryForeground);
  root.style.setProperty("--muted", colors.muted);
  root.style.setProperty("--muted-foreground", colors.mutedForeground);
  root.style.setProperty("--accent", colors.accent);
  root.style.setProperty("--accent-foreground", colors.accentForeground);
  root.style.setProperty("--border", colors.border);
  root.style.setProperty("--input", colors.input);
  root.style.setProperty("--ring", colors.ring);
  root.style.setProperty("--sidebar", colors.card);
  root.style.setProperty("--sidebar-foreground", colors.foreground);
  root.style.setProperty("--sidebar-primary", colors.primary);
  root.style.setProperty("--sidebar-primary-foreground", colors.primaryForeground);
  root.style.setProperty("--sidebar-accent", colors.muted);
  root.style.setProperty("--sidebar-accent-foreground", colors.foreground);
  root.style.setProperty("--sidebar-border", colors.border);
  root.style.setProperty("--sidebar-ring", colors.ring);
}

/** Re-paint using the session-locked theme color (e.g. after .dark toggles). */
export function reapplySessionThemeColorToDom(effectiveIsDark: boolean) {
  applyThemeColorToDom(sessionThemeColor, effectiveIsDark);
}

export function markThemeReady() {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme-ready", "");
}
