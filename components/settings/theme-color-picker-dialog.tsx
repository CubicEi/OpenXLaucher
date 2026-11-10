"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Palette, X } from "lucide-react";
import { BuiltinColorPicker } from "@/components/settings/builtin-color-picker";

import { useI18n } from "@/components/i18n/use-i18n";
import type { ThemeColor } from "@/components/settings/settings-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { overlayFade, scaleIn } from "@/lib/motion";
import {
  hexToOklch,
  themeColorToHex,
} from "@/lib/theme-color-utils";

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
                <BuiltinColorPicker
                  hex={previewHex}
                  onChangeHex={onCustomColor}
                />

                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {t("settings.appearance.themeColorApplyHint")}
                </p>

                <div className="flex items-center justify-between gap-2 pt-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-xs"
                    onClick={() => setDraft("default")}
                  >
                    {t("settings.appearance.themeColorUseDefault")}
                  </Button>
                  <div className="flex justify-end gap-2">
                    <Button type="button" variant="ghost" size="sm" onClick={handleClose}>
                      {t("common.cancel")}
                    </Button>
                    <Button type="button" size="sm" onClick={handleConfirm}>
                      {t("common.confirm")}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
