"use client";

import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useLaunchContext } from "@/components/launch/launch-provider";
import { invalidateInstancesCache } from "@/hooks/use-instances";
import {
  takePendingRetargetInstall,
  clearRetargetContext,
  type PendingRetargetInstall,
} from "@/lib/retarget-version";
import type { VersionInstallFinishedPayload } from "./version-install";
import { isTauriRuntime } from "@/lib/tauri-runtime";

function configPatchFromRetarget(
  pending: PendingRetargetInstall,
  targetFolder: string,
  config: {
    versionName: string;
    loadName: string;
    loadType: string;
  }
) {
  const wasSource =
    config.versionName === pending.sourceFolderName ||
    config.loadName === pending.sourceFolderName;
  if (!wasSource) return null;

  const hasLoader = pending.selections.some(
    (s) => s.loader !== "fabric_api" && s.loader !== "vanilla"
  );
  return {
    versionName: targetFolder,
    minecraftVersion: pending.targetMcVersion,
    loadType: hasLoader ? "1" : "0",
    loadName: hasLoader ? targetFolder : "",
  };
}

/** 版本修改安装成功后同步启动配置与实例缓存 */
export function RetargetInstallListener() {
  const { config, updateConfig } = useLaunchContext();

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    void listen<VersionInstallFinishedPayload>(
      "version-install-finished",
      (event) => {
        const payload = event.payload;
        if (payload.role !== "install" || !payload.success || !payload.session_id) {
          return;
        }
        const pending = takePendingRetargetInstall(payload.session_id);
        if (!pending) return;

        const target =
          payload.instance_name?.trim() || pending.sourceFolderName;
        const patch = configPatchFromRetarget(pending, target, {
          versionName: config.versionName,
          loadName: config.loadName,
          loadType: config.loadType,
        });
        if (patch) {
          updateConfig(patch);
        }
        if (config.minecraftPath) {
          invalidateInstancesCache(`${config.minecraftPath}/versions`);
        }
        clearRetargetContext();
      }
    ).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [
    config.loadName,
    config.loadType,
    config.minecraftPath,
    config.versionName,
    updateConfig,
  ]);

  return null;
}
