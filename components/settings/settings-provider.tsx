"use client";

import * as React from "react";
import {
  lockSessionThemeColor,
  markThemeReady,
  reapplySessionThemeColorToDom,
  resolveIsDark,
  type ThemeColor as PaletteThemeColor,
} from "@/lib/appearance-palette";
import {
  deleteBackgroundImage,
  hydrateBackgroundConfig,
  revokeBackgroundObjectUrl,
} from "@/lib/appearance-background-idb";
import {
  applySessionBackgroundToDomIfNeeded,
  backgroundHasImageFlag,
  captureSessionBackgroundFromDom,
  lockSessionBackground,
} from "@/lib/appearance-background-session";
import { settingsForLocalStorage } from "@/lib/appearance-background-persist";

export { persistLauncherBackground } from "@/lib/appearance-background-persist";

// ============================================================
// 类型定义
// ============================================================
export type ThemeMode = "light" | "dark" | "system";
export type HomeMode = "simple" | "full";
export type AppLanguage = "zh-CN" | "en-US";

export interface BackgroundConfig {
  /** 用于 CSS / 预览的 blob: URL（运行时，不持久化） */
  imageObjectUrl?: string;
  /** 内存中的图片数据，持久化写入 IndexedDB */
  imageBlob?: Blob;
  /** @deprecated 旧版 localStorage 内联数据，加载后会迁移 */
  imageDataUrl?: string;
  /**
   * 压缩 JPEG data URL，仅写入 localStorage，供硬刷新首帧同步绘制。
   * 完整原图仍在 IndexedDB。
   */
  bootstrapDataUrl?: string;
  /** 图片本体在 IndexedDB；localStorage 只存 opacity/blur 与此标记 */
  hasStoredImage?: boolean;
  opacity: number; // 0 ~ 1（精确到 0.01）
  blur: number; // 0 ~ 20（整数 px）
}

// 自定义主题色：仅启动时写入 DOM，会话内锁定；外观页「应用」后需重启
export type ThemeColor = PaletteThemeColor;

export interface AppearanceSettings {
  themeId: string;
  themeMode: ThemeMode;
  themeColor: ThemeColor; // "default" 或 oklch 字符串
  fontSize: number; // 12 ~ 18（整数 px，仅影响文字）
  background: BackgroundConfig;
  homeMode: HomeMode; // 主页模式：simple（简约）或 full（经典）
}

export interface GeneralSettings {
  language: AppLanguage;
  /** 下载 Modrinth 或 CurseForge 模组时自动下载其必需依赖。 */
  autoDownloadModDependencies: boolean;
  /** 是否将操作系统代理同步到本进程（写入 HTTP(S)_PROXY），默认关闭。 */
  useSystemProxy: boolean;
}

export interface DownloadSettings {
  /** 单文件 Range 下载连接数（默认 16，最大 32） */
  workersPerFile: number;
  /** 全局连接上限：1–256；0 表示无限制 */
  maxTotalWorkers: number;
}

export interface LauncherSettings {
  general: GeneralSettings;
  download: DownloadSettings;
  appearance: AppearanceSettings;
}

export const DOWNLOAD_WORKERS_PER_FILE_MIN = 1;
export const DOWNLOAD_WORKERS_PER_FILE_MAX = 32;
/** 0 = 无限制 */
export const DOWNLOAD_MAX_TOTAL_WORKERS_UNLIMITED = 0;
export const DOWNLOAD_MAX_TOTAL_WORKERS_MIN = 1;
export const DOWNLOAD_MAX_TOTAL_WORKERS_MAX = 256;
/** 滑动条在 256 之后再拉一格即为无限制 */
export const DOWNLOAD_TOTAL_WORKERS_SLIDER_UNLIMITED = 257;

// ============================================================
// 默认值
// ============================================================
export const DEFAULT_SETTINGS: LauncherSettings = {
  general: {
    language: "zh-CN",
    autoDownloadModDependencies: true,
    useSystemProxy: false,
  },
  download: {
    workersPerFile: 16,
    maxTotalWorkers: 64,
  },
  appearance: {
    themeId: "builtin.default",
    themeMode: "system",
    themeColor: "default",
    fontSize: 14,
    background: {
      opacity: 0.55,
      blur: 6,
    },
    homeMode: "simple", // 默认简约模式
  },
};

// 字体大小范围（整数）
export const FONT_SIZE_MIN = 1;
export const FONT_SIZE_MAX = 30;

// 背景模糊范围（整数 px）
export const BG_BLUR_MIN = 0;
export const BG_BLUR_MAX = 20;

// 背景不透明度的百分比表示：0% ~ 100%
export const BG_OPACITY_MIN = 0;
export const BG_OPACITY_MAX = 100;

export const SETTINGS_STORAGE_KEY = "openxlauncher:settings:v4";
const LEGACY_STORAGE_KEYS = [
  "openxlauncher:settings:v3",
  "rtlauncher:settings:v4",
  "rtlauncher:settings:v3",
] as const;

type LegacySettings = {
  general?: Partial<GeneralSettings>;
  download?: Partial<DownloadSettings>;
  appearance?: Partial<Omit<AppearanceSettings, "themeId">>;
};

export function clampDownloadSettings(download: Partial<DownloadSettings> | undefined): DownloadSettings {
  let workersPerFile = download?.workersPerFile ?? DEFAULT_SETTINGS.download.workersPerFile;
  let maxTotalWorkers = download?.maxTotalWorkers ?? DEFAULT_SETTINGS.download.maxTotalWorkers;
  workersPerFile = Math.min(
    DOWNLOAD_WORKERS_PER_FILE_MAX,
    Math.max(DOWNLOAD_WORKERS_PER_FILE_MIN, Math.round(workersPerFile)),
  );
  if (maxTotalWorkers === DOWNLOAD_MAX_TOTAL_WORKERS_UNLIMITED) {
    return { workersPerFile, maxTotalWorkers: DOWNLOAD_MAX_TOTAL_WORKERS_UNLIMITED };
  }
  maxTotalWorkers = Math.min(
    DOWNLOAD_MAX_TOTAL_WORKERS_MAX,
    Math.max(DOWNLOAD_MAX_TOTAL_WORKERS_MIN, Math.round(maxTotalWorkers)),
  );
  if (maxTotalWorkers < workersPerFile) {
    maxTotalWorkers = workersPerFile;
  }
  return { workersPerFile, maxTotalWorkers };
}

export function migrateSettingsV3(settings: LegacySettings): Partial<LauncherSettings> {
  return {
    ...settings,
    appearance: {
      ...DEFAULT_SETTINGS.appearance,
      ...(settings.appearance ?? {}),
      background: {
        ...DEFAULT_SETTINGS.appearance.background,
        ...(settings.appearance?.background ?? {}),
      },
      themeId: "builtin.default",
    },
  } as Partial<LauncherSettings>;
}

function isAppLanguage(value: unknown): value is AppLanguage {
  return value === "zh-CN" || value === "en-US";
}

export function languageFromSystemPreference(preferred: string | undefined): AppLanguage {
  if (!preferred) return "zh-CN";
  return preferred.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

/** 首次使用时根据系统（WebView）首选语言决定默认界面语言。 */
export function detectSystemLanguage(): AppLanguage {
  if (typeof navigator === "undefined") return "zh-CN";
  return languageFromSystemPreference(navigator.languages?.[0] || navigator.language);
}

// ============================================================
// Provider
// ============================================================
interface SettingsContextValue {
  settings: LauncherSettings;
  update: <K extends keyof LauncherSettings>(
    section: K,
    patch: Partial<LauncherSettings[K]>
  ) => void;
  reset: () => void;
}

const SettingsContext = React.createContext<SettingsContextValue | null>(null);

// ============================================================
// DOM 应用函数（主题色见 lib/appearance-palette — 仅启动锁定）
// ============================================================

// 应用字体大小 —— 核心是让 body 的 font-size 动态变化，
// 同时设置 --app-font-scale 让 text-* / h1-h4 也同步缩放
function applyFontSizeToDom(fontSize: number) {
  const root = document.documentElement;
  const clamped = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, Math.round(fontSize)));

  // 设置 body 的默认字号（像素）
  document.body.style.fontSize = `${clamped}px`;

  // 设置 CSS 变量供其他地方使用
  root.style.setProperty("--app-font-size", `${clamped}px`);
  root.style.setProperty("--app-font-scale", (clamped / 14).toFixed(3));
}

// 应用主题模式：给 html 加/去 .dark class
// 注意：当 mode 为 "system" 时，交给 next-themes 管理，不做手动操作
function applyThemeModeToDom(mode: ThemeMode) {
  if (mode === "system") return;
  const root = document.documentElement;
  root.classList.toggle("dark", mode === "dark");
}

// ============================================================
// Provider 组件
// ============================================================
export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = React.useState<LauncherSettings>(DEFAULT_SETTINGS);
  const [ready, setReady] = React.useState(false);
  // 初始化：读取本地存储 + IndexedDB 背景图
  React.useEffect(() => {
    let cancelled = false;

    void (async () => {
      let merged: LauncherSettings = {
        ...DEFAULT_SETTINGS,
        general: {
          ...DEFAULT_SETTINGS.general,
          language: detectSystemLanguage(),
        },
        download: { ...DEFAULT_SETTINGS.download },
        appearance: {
          ...DEFAULT_SETTINGS.appearance,
          background: { ...DEFAULT_SETTINGS.appearance.background },
        },
      };

      try {
        const current = localStorage.getItem(SETTINGS_STORAGE_KEY);
        let legacyRaw: string | null = null;
        let legacyKey: string | null = null;
        if (!current) {
          for (const key of LEGACY_STORAGE_KEYS) {
            const value = localStorage.getItem(key);
            if (value != null) {
              legacyRaw = value;
              legacyKey = key;
              break;
            }
          }
        }
        const raw = current ?? legacyRaw;
        if (raw) {
          const stored = JSON.parse(raw) as Partial<LauncherSettings>;
          const parsed = legacyKey?.endsWith(":v3")
            ? migrateSettingsV3(stored as LegacySettings)
            : stored;
          merged = {
            general: {
              ...DEFAULT_SETTINGS.general,
              ...(parsed.general ?? {}),
              language: isAppLanguage(parsed.general?.language)
                ? parsed.general.language
                : detectSystemLanguage(),
              useSystemProxy:
                typeof parsed.general?.useSystemProxy === "boolean"
                  ? parsed.general.useSystemProxy
                  : DEFAULT_SETTINGS.general.useSystemProxy,
            },
            download: clampDownloadSettings(parsed.download),
            appearance: {
              ...DEFAULT_SETTINGS.appearance,
              ...parsed.appearance,
              background: {
                ...DEFAULT_SETTINGS.appearance.background,
                ...(parsed.appearance?.background ?? {}),
              },
            },
          };
        }
      } catch (e) {
        console.warn("[settings] 读取失败，使用默认值", e);
      }

      try {
        const hydratedBg = await hydrateBackgroundConfig(merged.appearance.background);
        merged = {
          ...merged,
          appearance: { ...merged.appearance, background: hydratedBg },
        };
      } catch (e) {
        console.warn("[settings] 背景图加载失败", e);
      }

      if (cancelled) return;
      setSettings(merged);
      setReady(true);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Lock session theme color once (bootstrap already painted; do not recolor on draft edits)
  React.useEffect(() => {
    if (!ready) return;
    const bootAttr = document.documentElement.getAttribute("data-session-theme-color");
    const locked =
      bootAttr && bootAttr.length > 0
        ? (bootAttr as ThemeColor)
        : settings.appearance.themeColor;
    lockSessionThemeColor(locked);
    markThemeReady();
    // Intentionally only when settings become ready — never unlock mid-session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // 页面背景：bootstrap 可能已绘制，锁定会话 URL/不透明度/模糊，本会话内不再变更
  React.useEffect(() => {
    if (!ready) return;
    const hydrated = settings.appearance.background;
    const hydratedUrl = hydrated.imageObjectUrl;
    let captured = captureSessionBackgroundFromDom(hydrated);
    if (!captured.imageObjectUrl && backgroundHasImageFlag(hydrated) && hydratedUrl) {
      captured = {
        ...captured,
        imageObjectUrl: hydratedUrl,
      };
    }
    // 同步首帧可能是压缩 data URL：锁定前升级为 IndexedDB 原图 blob，减轻色差
    if (
      hydratedUrl?.startsWith("blob:") &&
      captured.imageObjectUrl &&
      (captured.imageObjectUrl.startsWith("data:") ||
        captured.imageObjectUrl !== hydratedUrl)
    ) {
      captured = {
        ...captured,
        imageObjectUrl: hydratedUrl,
      };
    }
    lockSessionBackground(captured);
    applySessionBackgroundToDomIfNeeded(captured);

    const previewUrl = captured.imageObjectUrl;
    const bg = settings.appearance.background;
    const needsPreviewSync =
      bg.imageObjectUrl !== previewUrl ||
      Math.abs(bg.opacity - captured.opacity) > 0.005 ||
      Math.round(bg.blur) !== Math.round(captured.blur);
    if (needsPreviewSync) {
      setSettings((prev) => ({
        ...prev,
        appearance: {
          ...prev.appearance,
          background: {
            ...prev.appearance.background,
            imageObjectUrl: previewUrl,
            opacity: captured.opacity,
            blur: captured.blur,
            hasStoredImage: backgroundHasImageFlag({
              ...prev.appearance.background,
              imageObjectUrl: previewUrl,
            }),
          },
        },
      }));
    }
    // 仅撤销未被会话采用的多余 blob；会话 URL 本身勿 revoke
    if (
      hydratedUrl &&
      previewUrl &&
      hydratedUrl !== previewUrl &&
      hydratedUrl.startsWith("blob:") &&
      previewUrl.startsWith("blob:")
    ) {
      queueMicrotask(() => revokeBackgroundObjectUrl(hydratedUrl));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // 旧背景缺少同步首帧预览时补写，减轻之后硬刷新闪成无背景
  React.useEffect(() => {
    if (!ready) return;
    const bg = settings.appearance.background;
    if (!backgroundHasImageFlag(bg) || bg.bootstrapDataUrl || !bg.imageBlob) return;
    let cancelled = false;
    void import("@/lib/appearance-background-bootstrap-preview")
      .then(({ createBootstrapBackgroundDataUrl }) =>
        createBootstrapBackgroundDataUrl(bg.imageBlob!),
      )
      .then((bootstrapDataUrl) => {
        if (cancelled || !bootstrapDataUrl) return;
        setSettings((prev) => {
          if (prev.appearance.background.bootstrapDataUrl) return prev;
          return {
            ...prev,
            appearance: {
              ...prev.appearance,
              background: {
                ...prev.appearance.background,
                bootstrapDataUrl,
              },
            },
          };
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // Persist + apply non-theme-color appearance (mode / font)；背景仅「应用+重启」时持久化
  React.useEffect(() => {
    if (!ready) return;

    const effectiveIsDark =
      settings.appearance.themeMode === "system"
        ? document.documentElement.classList.contains("dark") ||
          resolveIsDark("system")
        : settings.appearance.themeMode === "dark";

    document.documentElement.lang = settings.general.language;
    applyThemeModeToDom(settings.appearance.themeMode);
    // Theme color CSS vars: session-locked — never apply settings.appearance.themeColor here
    reapplySessionThemeColorToDom(effectiveIsDark);
    applyFontSizeToDom(settings.appearance.fontSize);

    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settingsForLocalStorage(settings)));
    } catch (e) {
      console.warn("[settings] 写入失败", e);
    }
  }, [settings, ready]);

  React.useEffect(() => {
    if (!ready) return;
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<boolean>("get_network_proxy_preference"))
      .then((useSystemProxy) => {
        setSettings((prev) => ({ ...prev, general: { ...prev.general, useSystemProxy } }));
      })
      .catch(() => {
        /* 浏览器预览或非 Tauri */
      });
  }, [ready]);

  React.useEffect(() => {
    if (!ready) return;
    const { workersPerFile, maxTotalWorkers } = settings.download;
    void import("@tauri-apps/api/core")
      .then(({ invoke }) =>
        invoke("set_download_worker_config", { workersPerFile, maxTotalWorkers }),
      )
      .catch(() => {
        /* 浏览器预览或无 Tauri 时忽略 */
      });
  }, [ready, settings.download]);

  // .dark toggles: re-paint with session-locked theme color only
  React.useEffect(() => {
    if (!ready) return;

    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      const externalIsDark = root.classList.contains("dark");
      reapplySessionThemeColorToDom(externalIsDark);
    });

    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [ready]);

  const update = React.useCallback(<K extends keyof LauncherSettings>(
    section: K,
    patch: Partial<LauncherSettings[K]>
  ) => {
    setSettings((prev) => ({
      ...prev,
      [section]: { ...prev[section], ...patch } as LauncherSettings[K],
    }));
  }, []);

  const reset = React.useCallback(() => {
    void deleteBackgroundImage();
    setSettings({
      ...DEFAULT_SETTINGS,
      general: {
        ...DEFAULT_SETTINGS.general,
        language: detectSystemLanguage(),
      },
    });
  }, []);

  const value = React.useMemo<SettingsContextValue>(
    () => ({ settings, update, reset }),
    [settings, update, reset]
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  const ctx = React.useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings 必须在 SettingsProvider 内部使用");
  return ctx;
}
