"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ExportInstanceForm } from "@/components/game-settings/export-instance-form";
import { useDownloadManager } from "@/components/download/download-provider";
import { useLaunchContext } from "@/components/launch/launch-provider";
import { useInstancePath } from "@/hooks/use-instance-path";
import type { FlyCoords } from "@/components/process-list/fly-to-process-list";
import { isTauriRuntime } from "@/lib/tauri-runtime";
import type { InstanceExportOptions } from "@/types";

const WEB_DEV_UI_PREVIEW =
  process.env.NODE_ENV === "development" && !isTauriRuntime();

export default function ExportInstancePage() {
  const router = useRouter();
  const { config, configLoaded } = useLaunchContext();
  const {
    instanceFolderName,
    configLoaded: instanceReady,
  } = useInstancePath();
  const { startInstanceExport } = useDownloadManager();

  const effectiveFolder =
    instanceFolderName ||
    (config.loadType !== "0" && config.loadName
      ? config.loadName
      : config.versionName);

  const previewMinecraftPath = WEB_DEV_UI_PREVIEW
    ? "C:/OpenXLauncher-dev-preview/.minecraft"
    : config.minecraftPath;
  const previewFolder = WEB_DEV_UI_PREVIEW
    ? effectiveFolder || "dev-instance"
    : effectiveFolder;

  useEffect(() => {
    if (WEB_DEV_UI_PREVIEW) return;
    if (!configLoaded || !instanceReady) return;
    if (!config.minecraftPath || !effectiveFolder) {
      router.replace("/game-settings");
    }
  }, [
    configLoaded,
    instanceReady,
    config.minecraftPath,
    effectiveFolder,
    router,
  ]);

  if (!previewMinecraftPath || !previewFolder) {
    return null;
  }

  const handleExport = async (
    options: InstanceExportOptions,
    flyFrom?: FlyCoords,
  ) => {
    await startInstanceExport(options, flyFrom);
  };

  return (
    <ExportInstanceForm
      minecraftPath={previewMinecraftPath}
      instanceFolder={previewFolder}
      defaultPackName={previewFolder}
      disabled={WEB_DEV_UI_PREVIEW}
      onExport={handleExport}
    />
  );
}
