"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import { useI18n, type TranslationKey } from "@/components/i18n/use-i18n";

export interface InstanceNameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 留空则使用默认名称（与组合安装一致） */
  defaultName: string;
  onConfirm: (resolvedName: string) => void | Promise<void>;
  titleKey?: TranslationKey;
  hintKey?: TranslationKey;
  confirmKey?: TranslationKey;
  cancelKey?: TranslationKey;
  confirming?: boolean;
}

/**
 * 实例 / 版本文件夹命名对话框（与组合安装、下载流程共用同一输入体验）。
 */
export function InstanceNameDialog({
  open,
  onOpenChange,
  defaultName,
  onConfirm,
  titleKey = "download.instanceName",
  hintKey = "download.instanceNameHint",
  confirmKey = "download.startDownload",
  cancelKey = "download.cancel",
  confirming = false,
}: InstanceNameDialogProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const el = inputRef.current;
    if (!el) return;
    el.value = defaultName;
    const timer = window.setTimeout(() => {
      el.focus();
      el.select();
    }, 50);
    return () => window.clearTimeout(timer);
  }, [open, defaultName]);

  const handleConfirm = () => {
    const trimmed = (inputRef.current?.value ?? "").trim();
    const resolved = trimmed.length > 0 ? trimmed : defaultName;
    void onConfirm(resolved);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!max-w-lg p-0">
        <DialogHeader>
          <DialogTitle>{t(titleKey)}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 p-5">
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {t(hintKey)}
              <code className="mx-1 rounded bg-muted px-1.5 py-0.5 text-xs">
                {defaultName}
              </code>
            </p>
            <Input
              ref={inputRef}
              placeholder={defaultName}
              defaultValue={defaultName}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !confirming) void handleConfirm();
              }}
              disabled={confirming}
            />
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={confirming}
            >
              {t(cancelKey)}
            </Button>
            <Button onClick={handleConfirm} disabled={confirming}>
              {confirming ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}
              {t(confirmKey)}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
