"use client";

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useRouter } from "next/navigation";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { isTauriRuntime } from "@/lib/tauri-runtime";
import { useI18n } from "@/components/i18n/use-i18n";
import { useDownloadManager } from "@/components/download/download-provider";

interface JavaIncompatiblePayload {
  requiredMajor: number;
  versionName?: string;
  currentJavaPath?: string;
}

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
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      title={t("launch.javaIncompatible.title")}
      lockDismiss={installing}
      actions={[
        {
          label: t("launch.javaIncompatible.openDownloadCenter"),
          variant: "outline",
          onClick: openDownloadCenter,
        },
        {
          label:
            requiredMajor != null
              ? t("launch.javaIncompatible.installZulu", { major: requiredMajor })
              : t("launch.javaIncompatible.installZuluGeneric"),
          variant: "primary",
          disabled: installing || requiredMajor == null,
          loading: installing,
          onClick: () => void installZulu(),
        },
      ]}
    >
      {requiredMajor != null ? (
        <p>
          {t("launch.javaIncompatible.description", {
            major: requiredMajor,
            version: versionName || "—",
          })}
        </p>
      ) : null}
      <p className="text-xs">{t("launch.javaIncompatible.hint")}</p>
      {installMessage ? (
        <p className="text-xs rounded-md border border-border bg-muted/40 px-3 py-2 mt-2">
          {installMessage}
        </p>
      ) : null}
    </ConfirmDialog>
  );
}
