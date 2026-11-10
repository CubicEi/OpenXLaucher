"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Palette, Pipette, X } from "lucide-react";

import { useI18n, type TranslationKey } from "@/components/i18n/use-i18n";
import {
  COLOR_PRESETS,
  type ThemeColor,
  type ThemeColorPresetId,
} from "@/components/settings/settings-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { overlayFade, scaleIn } from "@/lib/motion";
import {
  hexToOklch,
  themeColorToHex,
} from "@/lib/theme-color-utils";
import { cn } from "@/lib/utils";

const THEME_COLOR_PRESET_LABEL_KEYS: Record<
  ThemeColorPresetId,
  TranslationKey
> = {
  graphite: "settings.appearance.themeColorPreset.graphite",
  jade: "settings.appearance.themeColorPreset.jade",
  sky: "settings.appearance.themeColorPreset.sky",
  rose: "settings.appearance.themeColorPreset.rose",
  amber: "settings.appearance.themeColorPreset.amber",
  violet: "settings.appearance.themeColorPreset.violet",
  teal: "settings.appearance.themeColorPreset.teal",
  crimson: "settings.appearance.themeColorPreset.crimson",
};

export interface ThemeColorPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: ThemeColor;
  onConfirm: (value: ThemeColor) => void;
}

export function ThemeColorPickerDialog({
  open,
  onOpenChange,
  value,
  onConfirm,
}: ThemeColorPickerDialogProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<ThemeColor>(value);

  useEffect(() => {
    if (open) setDraft(value);
  }, [open, value]);

  const previewHex = themeColorToHex(draft);

  const handleClose = () => onOpenChange(false);

  const handleConfirm = () => {
    onConfirm(draft);
    onOpenChange(false);
  };

  const onCustomColor = (hex: string) => {
    const oklch = hexToOklch(hex);
    if (oklch) setDraft(oklch);
  };

  const isPresetSelected = (oklch: string) => draft === oklch;
  const isDefaultSelected = draft === "default";

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <motion.div
            variants={overlayFade}
            initial="initial"
            animate="animate"
            exit="exit"
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={handleClose}
          />

          <motion.div
            variants={scaleIn}
            initial="initial"
            animate="animate"
            exit="exit"
            className="relative z-10 mx-4 w-full max-w-md"
            role="dialog"
            aria-labelledby="theme-color-picker-title"
            onClick={(e) => e.stopPropagation()}
          >
            <Card className="shadow-2xl">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                <CardTitle
                  id="theme-color-picker-title"
                  className="flex items-center gap-2 text-base"
                >
                  <Palette className="size-4 text-primary" />
                  {t("settings.appearance.themeColorPickerTitle")}
                </CardTitle>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={handleClose}
                  aria-label={t("common.close")}
                >
                  <X className="size-4" />
                </Button>
              </CardHeader>

              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">
                    {t("settings.appearance.themeColorPresets")}
                  </Label>
                  <div className="grid grid-cols-4 gap-2">
                    <button
                      type="button"
                      onClick={() => setDraft("default")}
                      className={cn(
                        "group relative flex flex-col items-center gap-1 rounded-lg border p-2 transition-colors",
                        isDefaultSelected
                          ? "border-primary bg-primary/5 ring-2 ring-primary/40"
                          : "border-border hover:border-primary/40 hover:bg-muted/50",
                      )}
                    >
                      <span
                        className="size-8 rounded-md border border-border shadow-inner"
                        style={{
                          background:
                            "linear-gradient(135deg, #f5f5f4 50%, #292524 50%)",
                        }}
                      />
                      <span className="text-[10px] leading-tight text-muted-foreground text-center">
                        {t("settings.appearance.themeColorPresetDefault")}
                      </span>
                      {isDefaultSelected && (
                        <Check className="absolute right-1 top-1 size-3 text-primary" />
                      )}
                    </button>

                    {COLOR_PRESETS.map((preset) => {
                      const hex = themeColorToHex(preset.oklch);
                      const selected = isPresetSelected(preset.oklch);
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() => setDraft(preset.oklch)}
                          className={cn(
                            "group relative flex flex-col items-center gap-1 rounded-lg border p-2 transition-colors",
                            selected
                              ? "border-primary bg-primary/5 ring-2 ring-primary/40"
                              : "border-border hover:border-primary/40 hover:bg-muted/50",
                          )}
                        >
                          <span
                            className="size-8 rounded-md border border-black/10 shadow-sm"
                            style={{ backgroundColor: hex }}
                          />
                          <span className="text-[10px] leading-tight text-muted-foreground text-center line-clamp-2">
                            {t(THEME_COLOR_PRESET_LABEL_KEYS[preset.id])}
                          </span>
                          {selected && (
                            <Check className="absolute right-1 top-1 size-3 text-primary" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">
                    {t("settings.appearance.themeColorCustom")}
                  </Label>
                  <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 p-2.5">
                    <label className="relative shrink-0 cursor-pointer">
                      <span className="sr-only">{t("settings.appearance.themeColorCustom")}</span>
                      <input
                        type="color"
                        value={previewHex}
                        onChange={(e) => onCustomColor(e.target.value)}
                        className="h-9 w-9 cursor-pointer appearance-none rounded-md border border-border bg-transparent p-0"
                      />
                    </label>
                    <Pipette className="size-3.5 shrink-0 text-muted-foreground" />
                    <div
                      className="h-2 min-w-0 flex-1 rounded-full border border-border/60"
                      style={{ backgroundColor: previewHex }}
                    />
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {previewHex.toUpperCase()}
                    </span>
                  </div>
                </div>

                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {t("settings.appearance.themeColorApplyHint")}
                </p>

                <div className="flex justify-end gap-2 pt-1">
                  <Button type="button" variant="ghost" size="sm" onClick={handleClose}>
                    {t("common.cancel")}
                  </Button>
                  <Button type="button" size="sm" onClick={handleConfirm}>
                    {t("common.confirm")}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
