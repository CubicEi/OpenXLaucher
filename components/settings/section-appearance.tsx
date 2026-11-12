"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import {
  useSettings,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  BG_BLUR_MIN,
  BG_BLUR_MAX,
  BG_OPACITY_MIN,
  BG_OPACITY_MAX,
  type ThemeMode,
  type HomeMode,
  type ThemeColor,
  type BackgroundConfig,
  persistLauncherBackground,
} from "@/components/settings/settings-provider";
import {
  backgroundHasImageFlag,
  draftBackgroundDiffersFromSaved,
  getSessionBackground,
  savedBackgroundNeedsRestart,
} from "@/lib/appearance-background-session";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ImagePlus, RotateCcw, Palette, Type, X, Layout } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { cn } from "@/lib/utils";
import { useI18n } from "@/components/i18n/use-i18n";
import { ThemeSwitcher } from "@/components/settings/theme-switcher";
import { ThemeColorPickerDialog } from "@/components/settings/theme-color-picker-dialog";
import { useDownloadManager } from "@/components/download/download-provider";
import { getSessionThemeColor } from "@/lib/appearance-palette";
import { themeColorToHex } from "@/lib/theme-color-utils";

// ============================================================
// 主题模式（浅色 / 深色 / 跟随系统）
// ============================================================
function ThemeModeRow({
  value,
  onChange,
}: {
  value: ThemeMode;
  onChange: (v: ThemeMode) => void;
}) {
  const { t } = useI18n();

  const getModeLabel = (mode: ThemeMode) => {
    switch (mode) {
      case "light":
        return t("settings.appearance.light");
      case "dark":
        return t("settings.appearance.dark");
      case "system":
        return t("settings.appearance.system");
    }
  };

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between">
        <Label className="font-medium text-sm">{t("settings.appearance.theme")}</Label>
        <span className="text-xs text-muted-foreground">{getModeLabel(value)}</span>
      </div>
      <Select value={value} onValueChange={(next) => onChange(next as ThemeMode)}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="light">{t("settings.appearance.light")}</SelectItem>
          <SelectItem value="dark">{t("settings.appearance.dark")}</SelectItem>
          <SelectItem value="system">{t("settings.appearance.system")}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

// ============================================================
// 字体大小：滑块（1~30 px，整数）
// ============================================================
function FontSizeRow({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const { t } = useI18n();
  const rounded = Math.round(value);

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between">
        <Label className="font-medium text-sm flex items-center gap-1.5">
          <Type className="size-3.5 text-muted-foreground" />
          {t("settings.appearance.fontSize")}
        </Label>
        <span className="text-xs text-muted-foreground font-mono">{rounded}px</span>
      </div>

      <div className="flex items-center gap-3">
        <input
          type="range"
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          step={1}
          value={rounded}
          onChange={(e) => onChange(parseInt(e.target.value, 10))}
          className="accent-primary h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-muted"
        />
      </div>
    </div>
  );
}

// ============================================================
// 主题色 + 页面背景（会话锁定，共用一个「应用」与重启）
// ============================================================
function SessionAppearanceRow({
  savedThemeColor,
  savedBackground,
  onApply,
  buildPersistedSettings,
}: {
  savedThemeColor: ThemeColor;
  savedBackground: BackgroundConfig;
  onApply: (patch: { themeColor: ThemeColor; background: BackgroundConfig }) => void;
  buildPersistedSettings: (patch: {
    themeColor: ThemeColor;
    background: BackgroundConfig;
  }) => Parameters<typeof persistLauncherBackground>[0];
}) {
  const { t } = useI18n();
  const { tasks, cancelDownload } = useDownloadManager();
  const fileRef = useRef<HTMLInputElement>(null);
  const sessionThemeColor = getSessionThemeColor();

  const [themeDraft, setThemeDraft] = useState<ThemeColor>(savedThemeColor);
  const [backgroundDraft, setBackgroundDraft] = useState<BackgroundConfig>(savedBackground);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [restartOpen, setRestartOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    setThemeDraft(savedThemeColor);
  }, [savedThemeColor]);

  useEffect(() => {
    setBackgroundDraft({
      opacity: savedBackground.opacity,
      blur: savedBackground.blur,
      hasStoredImage: savedBackground.hasStoredImage,
      imageObjectUrl: savedBackground.imageObjectUrl,
      imageBlob: savedBackground.imageBlob,
    });
  }, [savedBackground]);

  const previewColor = themeColorToHex(themeDraft);
  const sessionBgUrl = getSessionBackground().imageObjectUrl;
  const previewImageUrl = backgroundDraft.imageObjectUrl ?? sessionBgUrl;
  const hasImage = backgroundHasImageFlag(backgroundDraft) || !!sessionBgUrl;
  const themeDirty = themeDraft !== savedThemeColor;
  const backgroundDirty = draftBackgroundDiffersFromSaved(backgroundDraft, savedBackground);
  const canApply = (themeDirty || backgroundDirty) && !restarting;
  const pendingRestart =
    savedThemeColor !== sessionThemeColor || savedBackgroundNeedsRestart(savedBackground);

  const patchBackground = (next: BackgroundConfig) => {
    setBackgroundDraft(next);
  };

  const handleFile = (f: File) => {
    if (
      backgroundDraft.imageObjectUrl?.startsWith("blob:") &&
      backgroundDraft.imageObjectUrl !== savedBackground.imageObjectUrl
    ) {
      URL.revokeObjectURL(backgroundDraft.imageObjectUrl);
    }
    const imageObjectUrl = URL.createObjectURL(f);
    patchBackground({
      opacity: backgroundDraft.opacity,
      blur: backgroundDraft.blur,
      imageObjectUrl,
      imageBlob: f,
      hasStoredImage: true,
    });
  };

  const handleConfirmRestart = async () => {
    if (restarting) return;
    setRestarting(true);
    try {
      const patch = { themeColor: themeDraft, background: backgroundDraft };
      await persistLauncherBackground(buildPersistedSettings(patch));
      onApply(patch);
      const activeIds = [
        ...new Set(
          tasks
            .filter((task) => task.status === "downloading" || task.status === "queued")
            .map((task) => task.taskId),
        ),
      ];
      await Promise.allSettled(activeIds.map((id) => cancelDownload(id)));
      await invoke("restart_launcher_cmd");
    } catch (e) {
      console.error("重启启动器失败:", e);
      setRestarting(false);
      setRestartOpen(false);
    }
  };

  const opacityPct = Math.round(backgroundDraft.opacity * 100);
  const blurInt = Math.round(backgroundDraft.blur);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <Label className="font-medium text-sm">{t("settings.appearance.themeColorAndPageBackground")}</Label>
        <Button
          type="button"
          size="sm"
          className="h-7 shrink-0 px-2.5 text-xs"
          disabled={!canApply}
          onClick={() => setRestartOpen(true)}
        >
          {t("settings.appearance.applyAppearanceSession")}
        </Button>
      </div>

      <div className="space-y-2.5">
        <Label className="text-xs text-muted-foreground">{t("settings.appearance.themeColor")}</Label>
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="flex w-full items-center gap-3 rounded-lg border border-border bg-card p-2.5 text-left transition-colors hover:border-primary/40 hover:bg-muted/30"
        >
          <span
            className="size-9 shrink-0 rounded-md border border-border shadow-sm"
            style={{
              backgroundColor: previewColor,
              ...(themeDraft === "default"
                ? {
                    background: "linear-gradient(135deg, #f5f5f4 50%, #292524 50%)",
                  }
                : {}),
            }}
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{t("settings.appearance.themeColor")}</p>
            <p className="truncate font-mono text-xs text-muted-foreground">
              {themeDraft === "default" ? "default" : previewColor.toUpperCase()}
            </p>
          </div>
          <span className="shrink-0 text-xs text-primary">
            {t("settings.appearance.chooseThemeColor")}
          </span>
        </button>
      </div>

      <ThemeColorPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        value={themeDraft}
        onConfirm={setThemeDraft}
      />

      <div className="h-px bg-border" />

      <div className="space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <Label className="text-xs text-muted-foreground">{t("settings.appearance.pageBackground")}</Label>
          {hasImage && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                if (
                  backgroundDraft.imageObjectUrl?.startsWith("blob:") &&
                  backgroundDraft.imageObjectUrl !== savedBackground.imageObjectUrl
                ) {
                  URL.revokeObjectURL(backgroundDraft.imageObjectUrl);
                }
                patchBackground({
                  opacity: backgroundDraft.opacity,
                  blur: backgroundDraft.blur,
                  hasStoredImage: false,
                  imageObjectUrl: undefined,
                  imageBlob: undefined,
                });
              }}
              className="h-7 gap-1 px-2 text-xs"
            >
              <X className="size-3" />
              {t("settings.appearance.remove")}
            </Button>
          )}
        </div>

      {/* 上传区 / 图片预览 —— 更紧凑的高度 */}
      <div
        className={cn(
          "relative flex items-center justify-center rounded-lg border border-dashed overflow-hidden transition-colors",
          hasImage ? "border-border h-28" : "border-border hover:border-primary/50 h-24"
        )}
      >
        {hasImage ? (
          <>
            <div
              className="absolute inset-0"
              style={{
                backgroundImage: previewImageUrl
                  ? `url(${JSON.stringify(previewImageUrl)})`
                  : undefined,
                backgroundSize: "cover",
                backgroundPosition: "center",
                filter: `blur(${backgroundDraft.blur}px)`,
                opacity: backgroundDraft.opacity,
                transform: "scale(1.08)",
              }}
            />
            <div className="relative z-10 rounded-full bg-black/40 px-3 py-1 text-xs text-white backdrop-blur">
              {t("settings.appearance.preview")}
            </div>
          </>
        ) : (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex w-full flex-col items-center gap-1.5 py-3 text-muted-foreground transition-colors hover:text-foreground"
          >
            <ImagePlus className="size-6" />
            <span className="text-xs">{t("settings.appearance.uploadBackgroundImage")}</span>
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
            e.target.value = "";
          }}
        />
      </div>

      {/* 不透明度滑块 */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-muted-foreground">{t("settings.appearance.opacity")}</Label>
          <span className="text-xs text-muted-foreground font-mono">{opacityPct}%</span>
        </div>
        <input
          type="range"
          min={BG_OPACITY_MIN}
          max={BG_OPACITY_MAX}
          step={1}
          value={opacityPct}
          disabled={!hasImage}
          onChange={(e) =>
            patchBackground({ ...backgroundDraft, opacity: parseInt(e.target.value, 10) / 100 })
          }
          className="accent-primary h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted disabled:cursor-not-allowed"
        />
      </div>

      {/* 高斯模糊滑块 */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-muted-foreground">{t("settings.appearance.gaussianBlur")}</Label>
          <span className="text-xs text-muted-foreground font-mono">{blurInt}px</span>
        </div>
        <input
          type="range"
          min={BG_BLUR_MIN}
          max={BG_BLUR_MAX}
          step={1}
          value={blurInt}
          disabled={!hasImage}
          onChange={(e) =>
            patchBackground({ ...backgroundDraft, blur: parseInt(e.target.value, 10) })
          }
          className="accent-primary h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted disabled:cursor-not-allowed"
        />
      </div>
      </div>

      <p className="text-[11px] text-muted-foreground">
        {pendingRestart
          ? t("settings.appearance.appearanceSessionRestartPending")
          : t("settings.appearance.appearanceSessionApplyHint")}
      </p>

      <ConfirmDialog
        open={restartOpen}
        onOpenChange={(open) => {
          if (restarting) return;
          setRestartOpen(open);
        }}
        title={t("settings.appearance.appearanceSessionRestartTitle")}
        lockDismiss={restarting}
        actions={[
          {
            label: t("common.cancel"),
            variant: "outline",
            disabled: restarting,
            onClick: () => setRestartOpen(false),
          },
          {
            label: t("settings.appearance.appearanceSessionRestartConfirm"),
            variant: "primary",
            disabled: restarting,
            loading: restarting,
            onClick: () => void handleConfirmRestart(),
          },
        ]}
      >
        {t("settings.appearance.appearanceSessionRestartDescription")}
      </ConfirmDialog>
    </div>
  );
}

// ============================================================
// 主页模式（简约 simple / 经典 full）
// ============================================================
function HomeModeRow({
  value,
  onChange,
}: {
  value: HomeMode;
  onChange: (v: HomeMode) => void;
}) {
  const { t } = useI18n();

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between">
        <Label className="font-medium text-sm flex items-center gap-1.5">
          <Layout className="size-3.5 text-muted-foreground" />
          {t("settings.appearance.homeLayout")}
        </Label>
        <span className="text-xs text-muted-foreground">{value === "simple" ? t("settings.appearance.simple") : t("settings.appearance.full")}</span>
      </div>
      <Select value={value} onValueChange={(next) => onChange(next as HomeMode)}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="simple">{t("settings.appearance.simple")}</SelectItem>
          <SelectItem value="full">{t("settings.appearance.full")}</SelectItem>
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        {value === "simple" 
          ? t("settings.appearance.simpleLayoutOnlyAccountRelatedContentIsShown")
          : t("settings.appearance.fullLayoutAllFeatureSectionsAreShown")}
      </p>
    </div>
  );
}

// ============================================================
// 主组件
// ============================================================
export function AppearanceSection() {
  const { settings, update, reset } = useSettings();
  const { t } = useI18n();
  const { appearance } = settings;
  const { setTheme: setNextTheme } = useTheme();
  // 主题模式切换时同步到 next-themes，确保全站一致
  const handleThemeModeChange = (mode: ThemeMode) => {
    update("appearance", { themeMode: mode });
    setNextTheme(mode);
  };

  return (
    <Card id="section-appearance" className="scroll-mt-4">
      <CardHeader className="pb-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Palette className="size-4 text-primary" />
              {t("settings.appearance.appearance")}
            </CardTitle>
            <CardDescription className="text-xs mt-1">{t("settings.appearance.themeColorFontSizeAndPageBackground")}</CardDescription>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={reset} className="shrink-0 gap-1.5 h-8">
            <RotateCcw className="size-3.5" />
            {t("settings.appearance.reset")}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <ThemeSwitcher />

        <div className="h-px bg-border" />

        <ThemeModeRow
          value={appearance.themeMode}
          onChange={handleThemeModeChange}
        />

        <div className="h-px bg-border" />

        <FontSizeRow
          value={appearance.fontSize}
          onChange={(v) => update("appearance", { fontSize: v })}
        />

        <div className="h-px bg-border" />

        <HomeModeRow
          value={appearance.homeMode}
          onChange={(v) => update("appearance", { homeMode: v })}
        />

        <div className="h-px bg-border" />

        <SessionAppearanceRow
          savedThemeColor={appearance.themeColor}
          savedBackground={appearance.background}
          onApply={({ themeColor, background }) =>
            update("appearance", { themeColor, background })
          }
          buildPersistedSettings={({ themeColor, background }) => ({
            ...settings,
            appearance: { ...settings.appearance, themeColor, background },
          })}
        />
      </CardContent>
    </Card>
  );
}
