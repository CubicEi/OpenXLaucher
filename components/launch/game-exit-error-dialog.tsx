"use client";

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { isTauriRuntime } from "@/lib/tauri-runtime";
import { appLog } from "@/lib/runtime-log";
import { useI18n } from "@/components/i18n/use-i18n";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type GameExitedPayload = {
  pid: number;
  exitCode: number;
  gameDir?: string;
  /** Launcher-initiated stop (kill_game_process); do not treat as a crash. */
  terminationRequested?: boolean;
};

function joinGameSubdir(gameDir: string, subdir: string): string {
  const base = gameDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const sub = subdir.replace(/\\/g, "/").replace(/^\/+/, "");
  return `${base}/${sub}`;
}

/** Shown when the game process exits with code 1 and the stop was not launcher-initiated. */
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

      // taskkill/kill from the launcher often yields exit code 1 — skip the crash dialog.
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
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("launch.provider.gameErrorTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("launch.provider.gameErrorDescription")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="sm:flex-wrap">
          <Button
            type="button"
            variant="outline"
            disabled={!gameDir}
            onClick={() => void openSubdir("logs")}
          >
            {t("launch.provider.viewLogs")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!gameDir}
            onClick={() => void openSubdir("crash-reports")}
          >
            {t("launch.provider.viewCrashReports")}
          </Button>
          <Button type="button" onClick={() => setOpen(false)}>
            {t("common.confirm")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
