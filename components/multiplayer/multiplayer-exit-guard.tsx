"use client";

import { useEffect, useRef } from "react";

import { useConfirmDialog } from "@/components/confirm-dialog";
import { useI18n } from "@/components/i18n/use-i18n";
import { useMultiplayerContext } from "@/components/multiplayer/multiplayer-provider";

/**
 * Intercepts launcher window close:
 * - If EasyTier is running, confirm that multiplayer will be interrupted.
 * - On confirm (or if EasyTier is not running), stop EasyTier then destroy the window.
 */
export function MultiplayerExitGuard() {
  const { t } = useI18n();
  const { confirm } = useConfirmDialog();
  const { isRunning, stopSession } = useMultiplayerContext();
  const busyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const setup = async () => {
      try {
        const { getCurrentWebviewWindow } = await import(
          "@tauri-apps/api/webviewWindow"
        );
        const webviewWindow = getCurrentWebviewWindow();

        unlisten = await webviewWindow.onCloseRequested(async (event) => {
          if (cancelled || busyRef.current) {
            event.preventDefault();
            return;
          }

          event.preventDefault();
          busyRef.current = true;

          try {
            let running = false;
            try {
              running = await isRunning();
            } catch {
              running = false;
            }

            if (running) {
              const accepted = await confirm({
                title: t("multiplayer.exit.title"),
                description: t("multiplayer.exit.description"),
                confirmLabel: t("multiplayer.exit.confirm"),
                cancelLabel: t("multiplayer.exit.cancel"),
                destructive: true,
              });
              if (!accepted || cancelled) return;
            }

            try {
              await stopSession();
            } catch (error) {
              console.error("退出前停止联机会话失败:", error);
            }

            if (cancelled) return;

            try {
              await webviewWindow.destroy();
            } catch {
              await webviewWindow.close();
            }
          } finally {
            busyRef.current = false;
          }
        });
      } catch (error) {
        console.log("Multiplayer exit guard unavailable:", error);
      }
    };

    void setup();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [confirm, isRunning, stopSession, t]);

  return null;
}
