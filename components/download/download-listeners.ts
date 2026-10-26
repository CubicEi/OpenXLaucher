"use client";

import type { Dispatch, SetStateAction } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTaskDismissed } from "./download-dismissed-tasks";
import type { DownloadTask, DownloadTaskStatus } from "./download-provider";
import { progressTrace } from "@/lib/progress-trace-log";
import {
  consumeVanillaQueueUnlock,
  downloadTaskLabel,
  installTaskLabel,
  type VersionInstallFinishedPayload,
  type VersionInstallProgressPayload,
  type VersionInstallSessionStartedPayload,
} from "./version-install";

interface ProgressPayload {
  task_id: number;
  percent: number;
  label?: string;
  stage?: string;
  message?: string;
  /** Bytes per second when backend provides it */
  speed?: number;
  downloaded?: number;
  total?: number;
}

interface FinishedPayload {
  task_id: number;
  success: boolean;
  error: string | null;
  failed_count?: number;
  label?: string;
}

/** Per-task samples for estimating / smoothing speed from byte deltas. */
type SpeedSampleState = {
  bytes: number;
  at: number;
  /** Smoothed B/s once a stable sample exists. */
  ema: number | undefined;
};

const speedSamples = new Map<number, SpeedSampleState>();

/** Prefer ≥0.3s between samples; show as soon as one good interval exists. */
const MIN_SPEED_DT_SEC = 0.3;
/** Hard cap — absurd spikes (bad dt / accidental cache credit). Real NICs stay under this. */
const MAX_PLAUSIBLE_BPS = 500 * 1024 * 1024;
const EMA_ALPHA = 0.4;

function isPlausibleRate(bps: number, ema: number | undefined): boolean {
  if (!Number.isFinite(bps) || bps <= 0) return false;
  if (bps > MAX_PLAUSIBLE_BPS) return false;
  // Reject sudden 20× jumps once we have a stable EMA (startup / cache bursts).
  // Looser than before so legitimate multi-connection ramps still show.
  if (ema != null && ema > 8 * 1024 && bps > ema * 20) return false;
  return true;
}

function blendEma(prev: number | undefined, sample: number): number {
  if (prev == null || prev <= 0) return sample;
  return EMA_ALPHA * sample + (1 - EMA_ALPHA) * prev;
}

function sanitizeExplicit(speed: number | undefined): number | undefined {
  if (typeof speed !== "number" || !Number.isFinite(speed) || speed <= 0) return undefined;
  if (speed > MAX_PLAUSIBLE_BPS) return undefined;
  return speed;
}

/**
 * Derive a stable bytes/sec for the UI from consecutive progress samples.
 * - Prefer byte-delta / dt over a short window (0.3–1s).
 * - Show after ≥1 good interval (or a already-windowed backend speed).
 * - Do not require endless priming; keep EMA across thin windows.
 */
function estimateSpeedBps(
  taskId: number,
  downloaded: number | undefined,
  explicitSpeed: number | undefined
): number | undefined {
  const now = Date.now();
  const prev = speedSamples.get(taskId);
  const explicit = sanitizeExplicit(explicitSpeed);

  if (typeof downloaded === "number" && Number.isFinite(downloaded) && downloaded >= 0) {
    if (!prev) {
      // Prime baseline; if backend already measured a windowed speed, show it now.
      const ema = explicit != null ? explicit : undefined;
      speedSamples.set(taskId, { bytes: downloaded, at: now, ema });
      return ema;
    }

    const dt = (now - prev.at) / 1000;
    if (dt < MIN_SPEED_DT_SEC) {
      // Hold the window open. Accept a sanitized explicit if we still have no EMA.
      if (prev.ema == null && explicit != null) {
        speedSamples.set(taskId, { bytes: prev.bytes, at: prev.at, ema: explicit });
        return explicit;
      }
      return prev.ema;
    }

    const delta = downloaded - prev.bytes;
    let instant: number | undefined;
    if (delta > 0 && dt > 0) {
      const rate = delta / dt;
      if (isPlausibleRate(rate, prev.ema)) instant = rate;
    }
    if (instant == null && explicit != null && isPlausibleRate(explicit, prev.ema)) {
      instant = explicit;
    }

    if (instant == null) {
      // Advance baseline so a flat / rejected window does not poison the next one.
      speedSamples.set(taskId, {
        bytes: downloaded,
        at: now,
        ema: prev.ema,
      });
      return prev.ema;
    }

    const ema = blendEma(prev.ema, instant);
    speedSamples.set(taskId, { bytes: downloaded, at: now, ema });
    return ema;
  }

  // No byte counter — use sanitized backend speed (already windowed server-side).
  if (explicit != null) {
    if (!prev) {
      speedSamples.set(taskId, { bytes: 0, at: now, ema: explicit });
      return explicit;
    }
    const dt = (now - prev.at) / 1000;
    if (dt < MIN_SPEED_DT_SEC) return prev.ema ?? explicit;
    if (!isPlausibleRate(explicit, prev.ema)) return prev.ema;
    const ema = blendEma(prev.ema, explicit);
    speedSamples.set(taskId, { bytes: prev.bytes, at: now, ema });
    return ema;
  }

  return prev?.ema;
}

function clearSpeedSample(taskId: number) {
  speedSamples.delete(taskId);
}

function resolveProgressLabels(payload: ProgressPayload): {
  stage: string | undefined;
  detail: string | undefined;
} {
  const stage = payload.stage?.trim() || undefined;
  const message = payload.message?.trim() || undefined;
  return {
    stage,
    detail: message ?? stage,
  };
}

/** True while the row still uses its local placeholder id (not yet bound to backend). */
function isUnboundClientPlaceholder(task: DownloadTask): boolean {
  return task.clientId === `client-${task.taskId}`;
}

/** Fallback labels for orphan backend tasks — never default to「Java 运行时」. */
function defaultLabelForEvent(eventName: string): string {
  switch (eventName) {
    case "java-download-progress":
    case "java-download-finished":
      return "Java JDK";
    case "download-progress":
    case "download-finished":
      return "Minecraft";
    case "optifine-download-progress":
    case "optifine-download-finished":
      return "OptiFine";
    case "fabric-download-progress":
    case "fabric-download-finished":
      return "Fabric";
    case "forge-download-progress":
    case "forge-download-finished":
      return "Forge";
    case "neoforge-download-progress":
    case "neoforge-download-finished":
      return "NeoForge";
    case "liteloader-download-progress":
    case "liteloader-download-finished":
      return "LiteLoader";
    case "quilt-download-progress":
    case "quilt-download-finished":
      return "Quilt";
    case "mod-download-progress":
    case "mod-download-finished":
      return "资源下载";
    case "custom-download-progress":
    case "custom-download-finished":
      return "自定义下载";
    case "combined-download-progress":
    case "combined-download-finished":
      return "组合安装";
    case "modpack-progress":
    case "modpack-finished":
      return "整合包";
    default:
      return "下载任务";
  }
}

function applyProgressFields(
  task: DownloadTask,
  percent: number,
  payloadLabel: string | undefined,
  stage: string | undefined,
  detail: string | undefined,
  speedBps: number | undefined,
  bytesDownloaded: number | undefined,
  isCompleted?: boolean
): DownloadTask {
  if (task.role === "install" || task.progressMode === "indeterminate") {
    return {
      ...task,
      progress: undefined,
      speedBps: undefined,
      progressMode: "indeterminate",
      role: "install",
      ...(payloadLabel ? { label: payloadLabel } : {}),
      ...(stage ? { stage, detail: detail ?? stage } : {}),
    };
  }
  const stageChanged =
    stage != null && stage.length > 0 && stage !== (task.stage?.trim() ?? "");
  const resolvedSpeed =
    isCompleted
      ? undefined
      : stageChanged
        ? speedBps
        : speedBps ?? task.speedBps;
  const resolvedBytes =
    bytesDownloaded != null
      ? bytesDownloaded
      : stageChanged
        ? undefined
        : task.bytesDownloaded;
  const monotonicProgress =
    isCompleted
      ? 100
      : task.status === "downloading" && typeof task.progress === "number"
        ? Math.max(task.progress, percent)
        : percent;
  return {
    ...task,
    progress: monotonicProgress,
    status: (isCompleted ? "success" : "downloading") as DownloadTaskStatus,
    ...(payloadLabel ? { label: payloadLabel } : {}),
    ...(stage ? { stage } : {}),
    ...(detail ? { detail } : {}),
    speedBps: resolvedSpeed,
    ...(resolvedBytes != null ? { bytesDownloaded: resolvedBytes } : {}),
  };
}

/**
 * Backend events may arrive before invoke returns; adopt a single pending client placeholder.
 * Only adopt when there is exactly one unambiguous placeholder to avoid cross-wiring
 * concurrent downloads. Cancelled placeholders are adopted (id only) so later events
 * do not spawn a duplicate「组合安装」orphan row.
 */
function adoptPendingClientTask(
  prev: DownloadTask[],
  backendTaskId: number,
  percent: number,
  payloadLabel: string | undefined,
  stage: string | undefined,
  detail: string | undefined,
  speedBps: number | undefined,
  bytesDownloaded: number | undefined,
  isCompleted?: boolean
): DownloadTask[] | null {
  if (prev.some((t) => t.taskId === backendTaskId)) return null;
  const pending = prev.filter(
    (t) =>
      isUnboundClientPlaceholder(t) &&
      (t.status === "downloading" || t.status === "queued" || t.status === "cancelled")
  );
  if (pending.length !== 1) return null;
  const target = pending[0];
  if (target.status === "cancelled") {
    return prev.map((t) => (t === target ? { ...t, taskId: backendTaskId } : t));
  }
  return prev.map((t) =>
    t === target
      ? {
          ...applyProgressFields(
            t,
            percent,
            payloadLabel,
            stage,
            detail,
            speedBps,
            bytesDownloaded,
            isCompleted
          ),
          taskId: backendTaskId,
        }
      : t
  );
}

/** Collapse duplicate rows that share the same backend taskId (keep the earliest / client-owned). */
function dedupeSameTaskId(tasks: DownloadTask[], taskId: number): DownloadTask[] {
  const matches = tasks.filter((t) => t.taskId === taskId);
  if (matches.length <= 1) return tasks;
  const keeper =
    matches.find((t) => t.clientId.startsWith("client-")) ??
    matches.find((t) => t.clientId.startsWith("server-")) ??
    matches[0];
  const merged = matches.reduce<DownloadTask>((acc, t) => {
    if (t === keeper) return acc;
    return {
      ...acc,
      progress: t.progress ?? acc.progress,
      stage: t.stage ?? acc.stage,
      detail: t.detail ?? acc.detail,
      status: t.status !== "queued" ? t.status : acc.status,
      speedBps: t.speedBps ?? acc.speedBps,
      bytesDownloaded: t.bytesDownloaded ?? acc.bytesDownloaded,
      error: t.error ?? acc.error,
      failedCount: t.failedCount ?? acc.failedCount,
      label: acc.label || t.label,
      role: acc.role ?? t.role,
      progressMode: acc.progressMode ?? t.progressMode,
      sessionId: acc.sessionId ?? t.sessionId,
    };
  }, keeper);
  return tasks.flatMap((t) => {
    if (t.taskId !== taskId) return [t];
    if (t === keeper) return [merged];
    return [];
  });
}

function makeProgressHandler(
  setTasks: Dispatch<SetStateAction<DownloadTask[]>>,
  cancelledRef: { current: boolean },
  eventName: string
) {
  return (event: { payload: ProgressPayload }) => {
    if (cancelledRef.current) return;
    const payload = event.payload;
    const { task_id, percent, label: payloadLabel } = payload;
    if (typeof percent !== "number" || Number.isNaN(percent)) return;
    if (isTaskDismissed(task_id)) {
      clearSpeedSample(task_id);
      return;
    }
    const isCompleted = percent >= 99.99;
    const { stage, detail } = resolveProgressLabels(payload);
    // #region agent log
    if (eventName === "combined-download-progress") {
      progressTrace("C", "download-listeners.ts:progress", "ui_progress_event", {
        task_id,
        percent,
        stage,
        detail,
        isCompleted,
        downloaded: payload.downloaded,
        speed: payload.speed,
      });
    }
    // #endregion
    const speedBps = estimateSpeedBps(task_id, payload.downloaded, payload.speed);
    const bytesDownloaded =
      typeof payload.downloaded === "number" ? payload.downloaded : undefined;

    if (isCompleted) clearSpeedSample(task_id);

    setTasks((prev) => {
      if (isTaskDismissed(task_id)) return prev;
      const deduped = dedupeSameTaskId(prev, task_id);
      const existing = deduped.find((t) => t.taskId === task_id);
      if (existing) {
        return deduped.map((task) => {
          if (task.taskId !== task_id) return task;
          if (task.role === "install" || task.progressMode === "indeterminate") {
            return task;
          }
          if (
            task.status === "cancelled" ||
            task.status === "success" ||
            task.status === "error" ||
            task.status === "warning"
          ) {
            return isCompleted && task.status !== "cancelled" && task.status !== "error"
              ? { ...task, progress: 100, speedBps: undefined }
              : task;
          }
          if (
            stage &&
            stage !== (task.stage?.trim() ?? "") &&
            task.status === "downloading"
          ) {
            clearSpeedSample(task_id);
          }
          const monotonicPercent =
            eventName === "combined-download-progress" && !isCompleted
              ? Math.max(task.progress ?? 0, percent)
              : percent;
          const next = applyProgressFields(
            task,
            monotonicPercent,
            payloadLabel,
            stage,
            detail,
            speedBps,
            bytesDownloaded,
            isCompleted
          );
          // #region agent log
          if (eventName === "combined-download-progress" && (task.progress ?? 0) !== (next.progress ?? 0)) {
            progressTrace("E", "download-listeners.ts:apply", "ui_task_progress_applied", {
              task_id,
              prev_progress: task.progress,
              next_progress: next.progress,
              prev_stage: task.stage,
              next_stage: next.stage,
            });
          }
          // #endregion
          return next;
        });
      }
      const adopted = adoptPendingClientTask(
        deduped,
        task_id,
        percent,
        payloadLabel,
        stage,
        detail,
        speedBps,
        bytesDownloaded,
        isCompleted
      );
      if (adopted) return adopted;

      // User removed/cleared this backend task — never recreate an orphan row.
      if (isTaskDismissed(task_id)) return deduped;

      // create-before-invoke flows always have a client placeholder; never invent
      // rows from late progress after cancel/delete (esp.「组合安装」).
      if (eventName.startsWith("combined-") || eventName === "download-progress") {
        return deduped;
      }

      // Do not invent a Java runtime task for unrelated/combined/vanilla progress.
      const newTask: DownloadTask = {
        clientId: `backend-${task_id}`,
        taskId: task_id,
        label: payloadLabel || defaultLabelForEvent(eventName),
        mcVersion: eventName.startsWith("java-") ? "Java" : "",
        status: "downloading",
        progress: isCompleted ? 100 : percent,
        stage,
        detail: detail ?? (eventName.startsWith("java-") ? "下载" : undefined),
        speedBps,
        bytesDownloaded,
        startedAt: Date.now(),
      };
      return [newTask, ...deduped];
    });
  };
}

function makeFinishedHandler(
  setTasks: Dispatch<SetStateAction<DownloadTask[]>>,
  cancelledRef: { current: boolean },
  eventName: string,
  onEnd?: () => void
) {
  return (event: { payload: FinishedPayload }) => {
    if (cancelledRef.current) return;
    const { task_id, success, error, failed_count = 0, label: payloadLabel } = event.payload;
    clearSpeedSample(task_id);
    if (isTaskDismissed(task_id)) {
      onEnd?.();
      return;
    }
    setTasks((prev) => {
      if (isTaskDismissed(task_id)) return prev;
      const deduped = dedupeSameTaskId(prev, task_id);
      const existing = deduped.find((t) => t.taskId === task_id);
      if (existing) {
        return deduped.map((task) => {
          if (task.taskId !== task_id || task.status === "cancelled") return task;
          const isWarning = success && failed_count > 0;
          return {
            ...task,
            status: (isWarning ? "warning" : success ? "success" : "error") as DownloadTaskStatus,
            progress: success ? 100 : task.progress,
            error: error ?? undefined,
            failedCount: failed_count > 0 ? failed_count : undefined,
            speedBps: undefined,
            ...(payloadLabel ? { label: payloadLabel } : {}),
          };
        });
      }
      const adopted = adoptPendingClientTask(
        deduped,
        task_id,
        success ? 100 : 0,
        payloadLabel,
        undefined,
        undefined,
        undefined,
        undefined,
        success
      );
      if (adopted) {
        return adopted.map((task) => {
          if (task.taskId !== task_id) return task;
          if (task.status === "cancelled") return task;
          return {
            ...task,
            status: (success && failed_count > 0
              ? "warning"
              : success
                ? "success"
                : "error") as DownloadTaskStatus,
            progress: success ? 100 : task.progress,
            error: error ?? undefined,
            failedCount: failed_count > 0 ? failed_count : undefined,
            speedBps: undefined,
          };
        });
      }
      if (isTaskDismissed(task_id)) return deduped;
      // Same as progress: create-before-invoke flows must not resurrect after cancel/delete.
      if (eventName.startsWith("combined-") || eventName === "download-finished") {
        return deduped;
      }
      const newTask: DownloadTask = {
        clientId: `backend-${task_id}`,
        taskId: task_id,
        label: payloadLabel || defaultLabelForEvent(eventName),
        mcVersion: eventName.startsWith("java-") ? "Java" : "",
        status: (success ? "success" : "error") as DownloadTaskStatus,
        progress: success ? 100 : 0,
        error: error ?? undefined,
        failedCount: failed_count > 0 ? failed_count : undefined,
        startedAt: Date.now(),
      };
      return [newTask, ...deduped];
    });
    onEnd?.();
  };
}

/** 在真正需要下载能力时才注册全部 Tauri 下载事件。 */
export async function setupAllDownloadListeners(
  setTasks: Dispatch<SetStateAction<DownloadTask[]>>,
  dequeueNext: () => void
): Promise<UnlistenFn[]> {
  const cancelledRef = { current: false };
  const eventPairs: Array<[string, string, "vanilla" | "other"]> = [
    ["download-progress", "download-finished", "vanilla"],
    ["java-download-progress", "java-download-finished", "other"],
    ["optifine-download-progress", "optifine-download-finished", "other"],
    ["fabric-download-progress", "fabric-download-finished", "other"],
    ["forge-download-progress", "forge-download-finished", "other"],
    ["mod-download-progress", "mod-download-finished", "other"],
    ["custom-download-progress", "custom-download-finished", "other"],
    ["neoforge-download-progress", "neoforge-download-finished", "other"],
    ["liteloader-download-progress", "liteloader-download-finished", "other"],
    ["quilt-download-progress", "quilt-download-finished", "other"],
    ["combined-download-progress", "combined-download-finished", "other"],
  ];

  const unlistens: UnlistenFn[] = [];
  for (const [progressEvent, finishedEvent, kind] of eventPairs) {
    unlistens.push(
      await listen<ProgressPayload>(
        progressEvent,
        makeProgressHandler(setTasks, cancelledRef, progressEvent)
      )
    );
    unlistens.push(
      await listen<FinishedPayload>(
        finishedEvent,
        makeFinishedHandler(
          setTasks,
          cancelledRef,
          finishedEvent,
          kind === "vanilla" ? dequeueNext : undefined
        )
      )
    );
  }

  unlistens.push(
    await listen<ProgressPayload>(
      "modpack-progress",
      makeProgressHandler(setTasks, cancelledRef, "modpack-progress")
    )
  );
  unlistens.push(
    await listen("modpack-finished", (event) => {
      const payload = event.payload as {
        task_id: number;
        success: boolean;
        message: string;
      };
      clearSpeedSample(payload.task_id);
      if (isTaskDismissed(payload.task_id)) return;
      setTasks((prev) => {
        if (isTaskDismissed(payload.task_id)) return prev;
        return dedupeSameTaskId(prev, payload.task_id).map((task) =>
          task.taskId === payload.task_id && task.status !== "cancelled"
            ? {
                ...task,
                status: (payload.success ? "success" : "error") as DownloadTaskStatus,
                progress: payload.success ? 100 : task.progress,
                error: payload.success ? undefined : String(payload.message),
                speedBps: undefined,
              }
            : task
        );
      });
    })
  );

  // —— Dual-task version-install session events ——
  unlistens.push(
    await listen<VersionInstallSessionStartedPayload>(
      "version-install-session-started",
      (event) => {
        if (cancelledRef.current) return;
        const p = event.payload;
        const {
          session_id,
          download_task_id,
          install_task_id,
          display_name,
        } = p;
        if (isTaskDismissed(download_task_id) && isTaskDismissed(install_task_id)) {
          return;
        }
        setTasks((prev) => {
          let next = dedupeSameTaskId(dedupeSameTaskId(prev, download_task_id), install_task_id);
          const hasDownload = next.some((t) => t.taskId === download_task_id);
          const hasInstall = next.some((t) => t.taskId === install_task_id);

          const unboundDownload = next.filter(
            (t) =>
              isUnboundClientPlaceholder(t) &&
              t.role === "download" &&
              (t.status === "downloading" || t.status === "queued" || t.status === "cancelled")
          );
          const unboundInstall = next.filter(
            (t) =>
              isUnboundClientPlaceholder(t) &&
              t.role === "install" &&
              (t.status === "downloading" || t.status === "queued" || t.status === "cancelled")
          );

          // Bind unmatched placeholders when invoke has not returned yet.
          if (!hasDownload && unboundDownload.length === 1) {
            const target = unboundDownload[0];
            next = next.map((t) =>
              t === target
                ? {
                    ...t,
                    taskId: download_task_id,
                    sessionId: session_id,
                    role: "download" as const,
                    progressMode: "percent" as const,
                    label: downloadTaskLabel(display_name) || t.label,
                  }
                : t
            );
          }
          if (!hasInstall && unboundInstall.length === 1) {
            const target = unboundInstall[0];
            next = next.map((t) =>
              t === target
                ? {
                    ...t,
                    taskId: install_task_id,
                    sessionId: session_id,
                    role: "install" as const,
                    progressMode: "indeterminate" as const,
                    label: installTaskLabel(display_name) || t.label,
                    progress: undefined,
                    speedBps: undefined,
                  }
                : t
            );
          }

          const afterBindDownload = next.some((t) => t.taskId === download_task_id);
          const afterBindInstall = next.some((t) => t.taskId === install_task_id);

          // Legacy single-placeholder path: adopt download placeholder, create install row.
          if (!afterBindDownload) {
            const legacyPending = next.filter(
              (t) =>
                isUnboundClientPlaceholder(t) &&
                !t.role &&
                (t.status === "downloading" || t.status === "queued" || t.status === "cancelled")
            );
            if (legacyPending.length === 1) {
              const target = legacyPending[0];
              next = next.map((t) =>
                t === target
                  ? {
                      ...t,
                      taskId: download_task_id,
                      sessionId: session_id,
                      role: "download" as const,
                      progressMode: "percent" as const,
                      label: downloadTaskLabel(display_name) || t.label,
                    }
                  : t
              );
            }
          }

          const ensureDownload = next.some((t) => t.taskId === download_task_id);
          const ensureInstall = next.some((t) => t.taskId === install_task_id);
          const startedAt = Date.now();

          if (!ensureDownload && !isTaskDismissed(download_task_id)) {
            next = [
              {
                clientId: `backend-${download_task_id}`,
                taskId: download_task_id,
                label: downloadTaskLabel(display_name),
                mcVersion: display_name,
                status: "downloading",
                detail: "准备下载",
                role: "download",
                sessionId: session_id,
                progressMode: "percent",
                startedAt,
              },
              ...next,
            ];
          } else {
            next = next.map((t) =>
              t.taskId === download_task_id
                ? {
                    ...t,
                    sessionId: session_id,
                    role: "download",
                    progressMode: "percent",
                  }
                : t
            );
          }

          if (!ensureInstall && !isTaskDismissed(install_task_id)) {
            next = [
              {
                clientId: `backend-${install_task_id}`,
                taskId: install_task_id,
                label: installTaskLabel(display_name),
                mcVersion: display_name,
                status: "downloading",
                detail: "准备安装",
                role: "install",
                sessionId: session_id,
                progressMode: "indeterminate",
                startedAt,
              },
              ...next,
            ];
          } else if (afterBindInstall || ensureInstall) {
            next = next.map((t) =>
              t.taskId === install_task_id
                ? {
                    ...t,
                    sessionId: session_id,
                    role: "install",
                    progressMode: "indeterminate",
                  }
                : t
            );
          }

          return next;
        });
      }
    )
  );

  unlistens.push(
    await listen<VersionInstallProgressPayload>("version-install-progress", (event) => {
      if (cancelledRef.current) return;
      const payload = event.payload;
      const taskId = payload.task_id;
      if (isTaskDismissed(taskId)) {
        clearSpeedSample(taskId);
        return;
      }

      const stageText =
        payload.stage_label?.trim() ||
        payload.message?.trim() ||
        payload.stage?.trim() ||
        undefined;
      const isInstall = payload.role === "install" || payload.progress_mode === "indeterminate";
      const percent =
        typeof payload.percent === "number" && Number.isFinite(payload.percent)
          ? payload.percent
          : undefined;
      const speedBps = isInstall
        ? undefined
        : estimateSpeedBps(
            taskId,
            typeof payload.downloaded === "number" ? payload.downloaded : undefined,
            typeof payload.speed === "number" ? payload.speed : undefined
          );
      const bytesDownloaded =
        typeof payload.downloaded === "number" ? payload.downloaded : undefined;

      setTasks((prev) => {
        if (isTaskDismissed(taskId)) return prev;
        const deduped = dedupeSameTaskId(prev, taskId);
        const existing = deduped.find((t) => t.taskId === taskId);
        if (!existing) {
          // Prefer session-started / placeholders; avoid inventing orphan rows mid-flight.
          return deduped;
        }
        return deduped.map((task) => {
          if (task.taskId !== taskId) return task;
          if (
            task.status === "cancelled" ||
            task.status === "success" ||
            task.status === "error" ||
            task.status === "warning"
          ) {
            return task;
          }
          if (isInstall) {
            return {
              ...task,
              status: "downloading" as const,
              role: "install",
              sessionId: payload.session_id || task.sessionId,
              progressMode: "indeterminate",
              progress: undefined,
              speedBps: undefined,
              ...(stageText ? { stage: stageText, detail: stageText } : {}),
            };
          }
          const nextPercent =
            percent != null
              ? Math.max(task.progress ?? 0, percent)
              : task.progress;
          return {
            ...task,
            status: "downloading" as const,
            role: "download",
            sessionId: payload.session_id || task.sessionId,
            progressMode: "percent",
            progress: nextPercent,
            speedBps: speedBps ?? task.speedBps,
            ...(bytesDownloaded != null ? { bytesDownloaded } : {}),
            ...(stageText ? { stage: stageText, detail: stageText } : {}),
          };
        });
      });
    })
  );

  unlistens.push(
    await listen<VersionInstallFinishedPayload>("version-install-finished", (event) => {
      if (cancelledRef.current) return;
      const payload = event.payload;
      const taskId = payload.task_id;
      clearSpeedSample(taskId);

      if (payload.role === "download" && consumeVanillaQueueUnlock(taskId)) {
        dequeueNext();
      }

      if (isTaskDismissed(taskId)) return;

      setTasks((prev) => {
        if (isTaskDismissed(taskId)) return prev;
        const deduped = dedupeSameTaskId(prev, taskId);
        const existing = deduped.find((t) => t.taskId === taskId);
        if (!existing) return deduped;
        const sessionId = payload.session_id || existing.sessionId;
        const success = payload.success;
        const cancelled =
          !success && (payload.error === "已取消" || payload.error === "cancelled");
        const next = deduped.map((task) => {
          if (task.taskId !== taskId || task.status === "cancelled") return task;
          return {
            ...task,
            status: (cancelled
              ? "cancelled"
              : success
                ? "success"
                : "error") as DownloadTaskStatus,
            progress:
              payload.role === "install"
                ? success
                  ? 100
                  : 0
                : success
                  ? 100
                  : task.progress,
            error: success ? undefined : payload.error ?? undefined,
            speedBps: undefined,
            sessionId: payload.session_id || task.sessionId,
            role: payload.role,
            progressMode: (payload.role === "install"
              ? "indeterminate"
              : "percent") as DownloadTask["progressMode"],
            ...(payload.instance_name
              ? { targetInstanceName: payload.instance_name }
              : {}),
          };
        });
        // Download finished → kick install row (e.g. modpack waits on download task).
        if (payload.role === "download" && success && sessionId) {
          return next.map((task) => {
            if (
              task.sessionId === sessionId &&
              task.role === "install" &&
              task.status === "queued"
            ) {
              return {
                ...task,
                status: "downloading" as const,
                progressMode: "indeterminate" as const,
                progress: undefined,
              };
            }
            return task;
          });
        }
        return next;
      });
    })
  );

  unlistens.push(() => {
    cancelledRef.current = true;
    speedSamples.clear();
  });

  return unlistens;
}
