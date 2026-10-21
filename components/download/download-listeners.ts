"use client";

import type { Dispatch, SetStateAction } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DownloadTask, DownloadTaskStatus } from "./download-provider";

interface ProgressPayload {
  task_id: number;
  percent: number;
  label?: string;
  stage?: string;
  message?: string;
}

interface FinishedPayload {
  task_id: number;
  success: boolean;
  error: string | null;
  failed_count?: number;
  label?: string;
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
      return "Mod";
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

function makeProgressHandler(
  setTasks: Dispatch<SetStateAction<DownloadTask[]>>,
  cancelledRef: { current: boolean },
  eventName: string
) {
  return (event: { payload: ProgressPayload }) => {
    if (cancelledRef.current) return;
    const { task_id, percent, label: payloadLabel } = event.payload;
    if (typeof percent !== "number" || Number.isNaN(percent)) return;
    const isCompleted = percent >= 99.99;
    setTasks((prev) => {
      const existing = prev.find((t) => t.taskId === task_id);
      if (existing) {
        return prev.map((task) => {
          if (task.taskId !== task_id) return task;
          if (task.status === "cancelled" || task.status === "success" || task.status === "error" || task.status === "warning") {
            return isCompleted && task.status !== "cancelled" && task.status !== "error"
              ? { ...task, progress: 100 }
              : task;
          }
          return {
            ...task,
            progress: isCompleted ? 100 : percent,
            status: (isCompleted ? "success" : "downloading") as DownloadTaskStatus,
            ...(payloadLabel ? { label: payloadLabel } : {}),
          };
        });
      }
      // Do not invent a Java runtime task for unrelated/combined/vanilla progress.
      const newTask: DownloadTask = {
        clientId: `backend-${task_id}`,
        taskId: task_id,
        label: payloadLabel || defaultLabelForEvent(eventName),
        mcVersion: eventName.startsWith("java-") ? "Java" : "",
        status: "downloading",
        progress: isCompleted ? 100 : percent,
        startedAt: Date.now(),
      };
      return [newTask, ...prev];
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
    setTasks((prev) => {
      const existing = prev.find((t) => t.taskId === task_id);
      if (existing) {
        return prev.map((task) => {
          if (task.taskId !== task_id || task.status === "cancelled") return task;
          const isWarning = success && failed_count > 0;
          return {
            ...task,
            status: (isWarning ? "warning" : success ? "success" : "error") as DownloadTaskStatus,
            progress: success ? 100 : task.progress,
            error: error ?? undefined,
            failedCount: failed_count > 0 ? failed_count : undefined,
            ...(payloadLabel ? { label: payloadLabel } : {}),
          };
        });
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
      return [newTask, ...prev];
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
      setTasks((prev) =>
        prev.map((task) =>
          task.taskId === payload.task_id && task.status !== "cancelled"
            ? {
                ...task,
                status: (payload.success ? "success" : "error") as DownloadTaskStatus,
                progress: payload.success ? 100 : task.progress,
                error: payload.success ? undefined : String(payload.message),
              }
            : task
        )
      );
    })
  );
  return unlistens;
}
