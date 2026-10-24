"use client";

import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@/lib/tauri-runtime";
import {
  useDownloadManager,
  type ModUpdatePayload,
} from "@/components/download/download-provider";
import { useI18n, type TranslationKey } from "@/components/i18n/use-i18n";
import type { ResourceKindWire } from "@/lib/resource-kind";

export function useInstanceResourceUpdates(options: {
  resourceKind: ResourceKindWire;
  needsLoader: boolean;
  instanceDir?: string;
  mcVersion?: string;
  modLoader?: string;
  onRefresh: () => void;
}) {
  const { t } = useI18n();
  const { resourceKind, needsLoader, instanceDir, mcVersion, modLoader, onRefresh } =
    options;
  const { startModUpdate, startModUpdateAll } = useDownloadManager();

  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updatesByFile, setUpdatesByFile] = useState<Map<string, ModUpdatePayload>>(
    new Map()
  );
  const [updatingFiles, setUpdatingFiles] = useState<Set<string>>(new Set());
  const [checkMessage, setCheckMessage] = useState<string | null>(null);

  const loaderForApi = needsLoader ? (modLoader ?? "") : "";

  const handleCheckUpdates = useCallback(async () => {
    if (!isTauriRuntime()) return;
    if (!instanceDir || !mcVersion || (needsLoader && !modLoader)) {
      setCheckMessage(t("panel.updateSourceNotFound"));
      return;
    }
    setCheckingUpdates(true);
    setCheckMessage(null);
    try {
      const results = await invoke<ModUpdatePayload[]>("check_resource_updates", {
        instanceDir,
        mcVersion,
        loader: loaderForApi,
        resourceKind,
      });
      const map = new Map<string, ModUpdatePayload>();
      for (const item of results) {
        map.set(item.fileName, item);
      }
      setUpdatesByFile(map);
      setCheckMessage(
        map.size > 0
          ? t("panel.updatesFound", { count: map.size })
          : t("panel.noUpdatesFound")
      );
    } catch (e) {
      console.error("check_resource_updates failed:", e);
      const msg = String(e);
      setCheckMessage(
        msg.startsWith("panel.") ? t(msg as TranslationKey) : msg
      );
    } finally {
      setCheckingUpdates(false);
    }
  }, [instanceDir, mcVersion, modLoader, needsLoader, loaderForApi, resourceKind, t]);

  const normalizeGameDir = (path: string) =>
    path.replace(/\//g, "\\").toLowerCase();

  const assertInstanceNotRunning = useCallback(
    async (dir: string) => {
      if (!isTauriRuntime()) return true;
      const state = await invoke<{
        running: boolean;
        gameDir?: string | null;
        instances?: Array<{ pid: number; gameDir: string; displayName: string; fullyStarted: boolean }>;
      }>("get_running_game_state");
      const target = normalizeGameDir(dir);
      const blockedByInstances =
        Array.isArray(state.instances) &&
        state.instances.some((inst) => normalizeGameDir(inst.gameDir) === target);
      const blockedByLegacy =
        !Array.isArray(state.instances) &&
        !!state.running &&
        !!state.gameDir &&
        normalizeGameDir(state.gameDir) === target;
      if (blockedByInstances || blockedByLegacy) {
        setCheckMessage(t("panel.closeGameBeforeUpdate"));
        return false;
      }
      return true;
    },
    [t]
  );

  const handleUpdateOne = useCallback(
    async (fileName: string) => {
      const update = updatesByFile.get(fileName);
      if (!update || !instanceDir || !mcVersion || (needsLoader && !modLoader)) {
        return;
      }
      if (!(await assertInstanceNotRunning(instanceDir))) return;
      setUpdatingFiles((prev) => new Set(prev).add(fileName));
      try {
        await startModUpdate(
          instanceDir,
          mcVersion,
          loaderForApi,
          update,
          resourceKind
        );
        setUpdatesByFile((prev) => {
          const next = new Map(prev);
          next.delete(fileName);
          return next;
        });
        onRefresh();
      } catch (e) {
        console.error("update_resource failed:", e);
      } finally {
        setUpdatingFiles((prev) => {
          const next = new Set(prev);
          next.delete(fileName);
          return next;
        });
      }
    },
    [
      updatesByFile,
      instanceDir,
      mcVersion,
      modLoader,
      needsLoader,
      loaderForApi,
      startModUpdate,
      resourceKind,
      assertInstanceNotRunning,
      onRefresh,
    ]
  );

  const handleUpdateAll = useCallback(async () => {
    if (!instanceDir || !mcVersion || (needsLoader && !modLoader)) return;
    if (updatesByFile.size === 0) return;
    if (!(await assertInstanceNotRunning(instanceDir))) return;
    const updates = Array.from(updatesByFile.values());
    const files = updates.map((u) => u.fileName);
    setUpdatingFiles(new Set(files));
    try {
      await startModUpdateAll(
        instanceDir,
        mcVersion,
        loaderForApi,
        updates,
        resourceKind
      );
      setUpdatesByFile(new Map());
      onRefresh();
    } catch (e) {
      console.error("update_resources failed:", e);
    } finally {
      setUpdatingFiles(new Set());
    }
  }, [
    instanceDir,
    mcVersion,
    modLoader,
    needsLoader,
    loaderForApi,
    updatesByFile,
    startModUpdateAll,
    resourceKind,
    assertInstanceNotRunning,
    onRefresh,
  ]);

  const modUpdatesForPanel = new Map(
    Array.from(updatesByFile.entries()).map(([file, u]) => [
      file,
      {
        newVersion: u.newVersion,
        currentVersion: u.currentVersion,
        source: u.source,
      },
    ])
  );

  return {
    checkingUpdates,
    updatesByFile,
    updatingFiles,
    checkMessage,
    handleCheckUpdates,
    handleUpdateOne,
    handleUpdateAll,
    modUpdatesForPanel,
  };
}
