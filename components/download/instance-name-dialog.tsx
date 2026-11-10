"use client";

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, TriangleAlert } from "lucide-react";
import { useI18n, type TranslationKey } from "@/components/i18n/use-i18n";
import {
  getInstanceFolderNameWarnings,
  type InstanceFolderNameWarning,
} from "@/lib/instance-name";
import { cn } from "@/lib/utils";
import type { LauncherPathsConfig } from "@/types";

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
  /** 如 `<minecraft>/versions`，用于检测文件夹重名 */
  instancesPath?: string;
  /** 重命名时排除的当前文件夹名 */
  excludeFolderName?: string;
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
  instancesPath: instancesPathProp,
  excludeFolderName,
}: InstanceNameDialogProps) {
  const { t } = useI18n();
  const [inputValue, setInputValue] = useState(defaultName);
  const [existingFolders, setExistingFolders] = useState<string[]>([]);

  const loadExistingFolders = useCallback(async (versionsDir: string) => {
    try {
      const instances = await invoke<{ name: string }[]>("vm_scan_instances", {
        instancesPath: versionsDir,
      });
      setExistingFolders(instances.map((i) => i.name));
    } catch {
      setExistingFolders([]);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setInputValue(defaultName);
    const timer = window.setTimeout(() => {
      const el = document.getElementById("instance-name-dialog-input");
      if (el instanceof HTMLInputElement) {
        el.focus();
        el.select();
      }
    }, 50);
    return () => window.clearTimeout(timer);
  }, [open, defaultName]);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      if (instancesPathProp) {
        await loadExistingFolders(instancesPathProp);
        return;
      }
      try {
        const cfg = await invoke<LauncherPathsConfig>("get_launcher_paths_config");
        const mc = cfg.selected_minecraft_path?.trim();
        if (mc) {
          await loadExistingFolders(`${mc}/versions`);
        } else {
          setExistingFolders([]);
        }
      } catch {
        setExistingFolders([]);
      }
    })();
  }, [open, instancesPathProp, loadExistingFolders]);

  const warnings: InstanceFolderNameWarning[] = open
    ? getInstanceFolderNameWarnings(
        inputValue,
        defaultName,
        existingFolders,
        excludeFolderName,
      )
    : [];

  const warningMessage = (kind: InstanceFolderNameWarning) => {
    switch (kind) {
      case "trailingDot":
        return t("download.instanceNameWarnTrailingDot");
      case "duplicate":
        return t("download.instanceNameWarnDuplicate");
    }
  };

  const hasBlockingWarning = warnings.length > 0;

  const handleConfirm = () => {
    if (hasBlockingWarning) return;
    const trimmed = inputValue.trim();
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
              id="instance-name-dialog-input"
              placeholder={defaultName}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !confirming &&
                  !hasBlockingWarning
                ) {
                  void handleConfirm();
                }
              }}
              disabled={confirming}
              className={cn(
                warnings.length > 0 &&
                  "border-amber-500/60 focus-visible:ring-amber-500/30",
              )}
            />
            {warnings.length > 0 && (
              <ul className="space-y-1.5">
                {warnings.map((w) => (
                  <li
                    key={w}
                    className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400"
                  >
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                    <span>{warningMessage(w)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={confirming}
            >
              {t(cancelKey)}
            </Button>
            <Button
              onClick={handleConfirm}
              disabled={confirming || hasBlockingWarning}
            >
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
