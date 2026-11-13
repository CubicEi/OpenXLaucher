"use client";

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TriangleAlert } from "lucide-react";
import { useI18n, type TranslationKey } from "@/components/i18n/use-i18n";
import {
  getInstanceFolderNameWarnings,
  type InstanceFolderNameWarning,
} from "@/lib/instance-name";
import { cn } from "@/lib/utils";
import { InputDialog } from "@/components/input-dialog";

export interface InstanceNameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultName: string;
  onConfirm: (resolvedName: string) => void | Promise<void>;
  titleKey?: TranslationKey;
  hintKey?: TranslationKey;
  confirmKey?: TranslationKey;
  cancelKey?: TranslationKey;
  confirming?: boolean;
  instancesPath?: string;
  excludeFolderName?: string;
}

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
    if (!open || !instancesPathProp) return;
    void loadExistingFolders(instancesPathProp);
  }, [open, instancesPathProp, loadExistingFolders]);

  const warnings: InstanceFolderNameWarning[] = open
    ? getInstanceFolderNameWarnings(
        inputValue,
        defaultName,
        existingFolders,
        excludeFolderName,
      )
    : [];

  const warningMessage = (w: InstanceFolderNameWarning) => {
    switch (w) {
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
    <InputDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t(titleKey)}
      value={inputValue}
      onValueChange={setInputValue}
      inputId="instance-name-dialog-input"
      placeholder={defaultName}
      confirmLabel={t(confirmKey)}
      cancelLabel={t(cancelKey)}
      confirming={confirming}
      confirmDisabled={hasBlockingWarning}
      onConfirm={handleConfirm}
      onInputKeyDown={(e) => {
        if (e.key === "Enter" && !confirming && !hasBlockingWarning) {
          handleConfirm();
        }
      }}
      inputClassName={cn(
        warnings.length > 0 &&
          "border-amber-500/60 focus-visible:ring-amber-500/30",
      )}
    >
      <p>
        {t(hintKey)}
        <code className="mx-1 rounded bg-muted px-1.5 py-0.5 text-xs">
          {defaultName}
        </code>
      </p>
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
    </InputDialog>
  );
}
