"use client";

import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { flyToProcessList } from "@/components/process-list/fly-to-process-list";
import { dismissTaskIds, isTaskDismissed } from "./download-dismissed-tasks";
import type { DownloadTask } from "./download-provider";

interface StartDownloadOptions {
  /** 用于生成 label，显示在 UI 上 */
  label: string;
  /** Minecraft 版本，用于在任务列表显示 */
  mcVersion: string;
  /** 后端 Tauri 命令名称，如 "download_and_install_forge" */
  tauriCommand: string;
  /** 传给后端的参数对象 */
  params: Record<string, unknown>;
}

const TERMINAL_STATUSES = new Set(["cancelled", "error", "success", "warning"]);

/**
 * Bind a local placeholder task to the real backend taskId.
 * Merges away any orphan event-created task that already used the backend id.
 * Never resurrects a terminal (cancelled/error/success/warning) local row.
 */
export function bindBackendTaskId(
  prev: DownloadTask[],
  localTaskId: number,
  backendTaskId: number,
  patch?: Partial<DownloadTask>
): DownloadTask[] {
  if (localTaskId === backendTaskId) {
    return prev;
  }
  const localTask = prev.find((task) => task.taskId === localTaskId);
  if (!localTask) {
    // Placeholder was removed/cleared before bind — suppress orphans for the real id
    // and drop any event-created row that already appeared under the backend id.
    if (isTaskDismissed(localTaskId)) {
      dismissTaskIds(backendTaskId);
      return prev.filter((task) => task.taskId !== backendTaskId);
    }
    return prev;
  }

  const eventTask = prev.find(
    (task) => task.taskId === backendTaskId && task.clientId !== localTask.clientId
  );

  const localTerminal = TERMINAL_STATUSES.has(localTask.status);
  const eventTerminal = eventTask ? TERMINAL_STATUSES.has(eventTask.status) : false;

  return prev.flatMap((task) => {
    if (task === eventTask) return [];
    if (task !== localTask) return [task];

    // Prefer keeping a user/terminal outcome over a "still downloading" patch.
    let status = localTask.status;
    let error = localTask.error;
    if (!localTerminal) {
      if (eventTerminal && eventTask) {
        status = eventTask.status;
        error = eventTask.error ?? error;
      } else if (patch?.status) {
        status = patch.status;
        error = patch.error ?? eventTask?.error ?? error;
      } else if (eventTask?.status) {
        status = eventTask.status;
        error = eventTask.error ?? error;
      }
    }

    const { status: _patchStatus, error: _patchError, ...restPatch } = patch ?? {};
    void _patchStatus;
    void _patchError;

    return [
      {
        ...localTask,
        ...(eventTask
          ? {
              progress: eventTask.progress ?? localTask.progress,
              detail: eventTask.detail ?? localTask.detail,
              stage: eventTask.stage ?? localTask.stage,
              failedCount: eventTask.failedCount ?? localTask.failedCount,
              speedBps: eventTask.speedBps ?? localTask.speedBps,
              bytesDownloaded: eventTask.bytesDownloaded ?? localTask.bytesDownloaded,
              role: eventTask.role ?? localTask.role,
              sessionId: eventTask.sessionId ?? localTask.sessionId,
              progressMode: eventTask.progressMode ?? localTask.progressMode,
            }
          : {}),
        ...restPatch,
        clientId: localTask.clientId,
        taskId: backendTaskId,
        status,
        error,
        label: localTask.label || eventTask?.label || patch?.label || "",
        mcVersion: localTask.mcVersion || eventTask?.mcVersion || "",
        targetInstanceName:
          localTask.targetInstanceName ?? eventTask?.targetInstanceName,
        role: restPatch.role ?? eventTask?.role ?? localTask.role,
        sessionId: restPatch.sessionId ?? eventTask?.sessionId ?? localTask.sessionId,
        progressMode:
          restPatch.progressMode ?? eventTask?.progressMode ?? localTask.progressMode,
        startedAt: localTask.startedAt,
      },
    ];
  });
}

/** Bind a dual-task session's download + install placeholders to backend IDs. */
export function bindVersionInstallPair(
  prev: DownloadTask[],
  localDownloadId: number,
  localInstallId: number,
  downloadTaskId: number,
  installTaskId: number,
  sessionId: string,
  patch?: Partial<DownloadTask>
): DownloadTask[] {
  let next = bindBackendTaskId(prev, localDownloadId, downloadTaskId, {
    ...patch,
    role: "download",
    sessionId,
    progressMode: "percent",
  });
  next = bindBackendTaskId(next, localInstallId, installTaskId, {
    ...patch,
    role: "install",
    sessionId,
    progressMode: "indeterminate",
    progress: undefined,
    speedBps: undefined,
  });
  return next.map((t) =>
    t.taskId === downloadTaskId || t.taskId === installTaskId
      ? { ...t, sessionId }
      : t
  );
}

/**
 * 生成一个 startXXXDownload 函数的工厂
 *
 * 所有下载器（Forge / NeoForge / Fabric / Quilt / OptiFine / Mod 都走这套逻辑
 * 只有原版下载不一样（它走队列）
 */
export function makeStartDownloadFn(
  setTasks: Dispatch<SetStateAction<DownloadTask[]>>,
  taskIdCounterRef: { current: number },
  dequeueNext?: () => void,
  ensureListeners?: () => Promise<void>,
  cancelledLocalIdsRef?: MutableRefObject<Set<number>>
) {
  return async function startDownload(opts: StartDownloadOptions): Promise<number> {
    const localTaskId = taskIdCounterRef.current++;
    const { label, mcVersion, tauriCommand, params } = opts;

    setTasks((prev) => {
      const isDownloading = prev.some(
        (t) => t.label === label && (t.status === "downloading" || t.status === "success")
      );
      if (isDownloading) return prev;

      const instanceName =
        typeof params.instanceName === "string" ? params.instanceName.trim() : "";
      const isUpdate =
        tauriCommand === "update_mod" ||
        tauriCommand === "update_mods" ||
        tauriCommand === "update_resource" ||
        tauriCommand === "update_resources";
      const task: DownloadTask = {
        clientId: `client-${localTaskId}`,
        taskId: localTaskId,
        label,
        mcVersion,
        status: "downloading",
        detail: isUpdate ? "下载" : "准备中…",
        startedAt: Date.now(),
        ...(instanceName ? { targetInstanceName: instanceName } : {}),
      };
      return [task, ...prev];
    });

    flyToProcessList();

    try {
      await ensureListeners?.();
      const returnedTaskId = await invoke<number>(tauriCommand, params);
      // 如果后端返回的 taskId 与我们生成的不一样，替换掉
      if (returnedTaskId !== localTaskId) {
        setTasks((prev) => bindBackendTaskId(prev, localTaskId, returnedTaskId));
      }
      const effectiveId = returnedTaskId;
      if (cancelledLocalIdsRef?.current.has(localTaskId)) {
        cancelledLocalIdsRef.current.delete(localTaskId);
        cancelledLocalIdsRef.current.add(effectiveId);
        if (isTaskDismissed(localTaskId)) {
          dismissTaskIds(effectiveId);
        } else {
          setTasks((prev) =>
            prev.map((t) =>
              t.taskId === effectiveId
                ? { ...t, status: "cancelled" as const, error: "已取消" }
                : t
            )
          );
        }
      }
      return returnedTaskId;
    } catch (err) {
      console.error(`启动下载失败 (${tauriCommand}):`, err);
      // 标记任务为失败
      setTasks((prev) =>
        prev.map((t) =>
          t.taskId === localTaskId ? { ...t, status: "error", error: String(err) } : t
        )
      );
      // 启动失败后尝试下一个排队任务
      dequeueNext?.();
      throw err;
    }
  };
}
