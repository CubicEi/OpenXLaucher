"use client";

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { isTauriRuntime } from "@/lib/tauri-runtime";
import { appLog } from "@/lib/runtime-log";
import { useI18n } from "@/components/i18n/use-i18n";

type GameExitedPayload = {
  pid: number;
  exitCode: number;
  gameDir?: string;
  terminationRequested?: boolean;
};

function joinGameSubdir(gameDir: string, subdir: string): string {
  const base = gameDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const sub = subdir.replace(/\\/g, "/").replace(/^\/+/, "");
  return `${base}/${sub}`;
}

export function GameExitErrorDialog() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [gameDir, setGameDir] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauriRuntime()) return;

    let active = true;
    let unlisten: (() => void) | undefined;

    void listen<GameExitedPayload | number>("game-exited", (event) => {
      if (!active) return;
      const payload = event.payload;
      const exitCode = typeof payload === "number" ? payload : payload.exitCode;
      if (exitCode !== 1) return;
      if (typeof payload !== "number" && payload.terminationRequested) return;

      const dir =
        typeof payload === "number"
          ? ""
          : typeof payload.gameDir === "string"
            ? payload.gameDir.trim()
            : "";
      setGameDir(dir || null);
      setOpen(true);
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  const openSubdir = useCallback(
    async (subdir: "logs" | "crash-reports") => {
      if (!gameDir) return;
      const path = joinGameSubdir(gameDir, subdir);
      try {
        await invoke("vm_open_path", { path });
      } catch (error) {
        appLog.error("launch", `打开${subdir}目录失败`, {
          path,
          error: String(error),
        });
      }
    },
    [gameDir],
  );

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      title={t("launch.provider.gameErrorTitle")}
      actions={[
        {
          label: t("launch.provider.viewLogs"),
          variant: "outline",
          disabled: !gameDir,
          onClick: () => void openSubdir("logs"),
        },
        {
          label: t("launch.provider.viewCrashReports"),
          variant: "outline",
          disabled: !gameDir,
          onClick: () => void openSubdir("crash-reports"),
        },
        {
          label: t("common.confirm"),
          variant: "primary",
          onClick: () => setOpen(false),
        },
      ]}
    >
      {t("launch.provider.gameErrorDescription")}
    </ConfirmDialog>
  );
}
