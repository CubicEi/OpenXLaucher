"use client";

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useRouter } from "next/navigation";
import { AlertCircle, Download, ExternalLink, Loader2 } from "lucide-react";

import { isTauriRuntime } from "@/lib/tauri-runtime";
import { useI18n } from "@/components/i18n/use-i18n";
import { useDownloadManager } from "@/components/download/download-provider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface JavaIncompatiblePayload {
  requiredMajor: number;
  versionName?: string;
  currentJavaPath?: string;
}

/**
 * Listens for launch-time `java-incompatible` and offers:
 * - open Download Center → Java tab
 * - one-click install Zulu JDK N
 */
export function JavaIncompatibleDialog() {
  const { t } = useI18n();
  const router = useRouter();
  const { startJavaDownload } = useDownloadManager();
  const [open, setOpen] = useState(false);
  const [requiredMajor, setRequiredMajor] = useState<number | null>(null);
  const [versionName, setVersionName] = useState<string | undefined>();
  const [installing, setInstalling] = useState(false);
  const [installMessage, setInstallMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let active = true;
    let unlisten: (() => void) | undefined;

    void listen<JavaIncompatiblePayload>("java-incompatible", (event) => {
      if (!active) return;
      const major = Number(event.payload?.requiredMajor);
      if (!Number.isFinite(major) || major <= 0) return;
      setRequiredMajor(major);
      setVersionName(event.payload?.versionName);
      setInstallMessage(null);
      setInstalling(false);
      setOpen(true);
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  const openDownloadCenter = () => {
    setOpen(false);
    router.push("/download?tab=java");
  };

  const installZulu = async () => {
    if (requiredMajor == null) return;
    setInstalling(true);
    setInstallMessage(null);
    const label = `Zulu JDK ${requiredMajor}`;
    try {
      const taskId = await startJavaDownload(label);
      const result = await invoke<{ message: string }>("install_zulu_jdk", {
        major: requiredMajor,
        taskId,
      });
      setInstallMessage(result.message || t("launch.javaIncompatible.installStarted"));
    } catch (err) {
      setInstallMessage(
        t("launch.javaIncompatible.installFailed", { error: String(err) })
      );
    } finally {
      setInstalling(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertCircle className="size-5 text-destructive" />
            {t("launch.javaIncompatible.title")}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 px-5 py-4">
          <p className="text-sm text-muted-foreground">
            {requiredMajor != null
              ? t("launch.javaIncompatible.description", {
                  major: requiredMajor,
                  version: versionName || "—",
                })
              : null}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("launch.javaIncompatible.hint")}
          </p>
          {installMessage ? (
            <p className="text-xs rounded-md border border-border bg-muted/40 px-3 py-2">
              {installMessage}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2 border-t border-border px-5 py-3 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={openDownloadCenter} className="gap-1.5">
            <ExternalLink className="size-3.5" />
            {t("launch.javaIncompatible.openDownloadCenter")}
          </Button>
          <Button
            type="button"
            onClick={() => void installZulu()}
            disabled={installing || requiredMajor == null}
            className="gap-1.5"
          >
            {installing ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Download className="size-3.5" />
            )}
            {requiredMajor != null
              ? t("launch.javaIncompatible.installZulu", { major: requiredMajor })
              : t("launch.javaIncompatible.installZuluGeneric")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
