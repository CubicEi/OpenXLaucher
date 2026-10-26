"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { type UnlistenFn } from "@tauri-apps/api/event";
import { dismissTaskIds, isTaskDismissed } from "./download-dismissed-tasks";
import {
  bindBackendTaskId,
  bindVersionInstallPair,
  makeStartDownloadFn,
} from "./download-event-utils";
import { isTauriRuntime } from "@/lib/tauri-runtime";
import { flyToProcessList } from "@/components/process-list/fly-to-process-list";
import {
  DownloadCornerNoticeProvider,
  useDownloadCornerNotice,
  type PushDownloadCornerNoticeInput,
} from "@/components/download/download-corner-notice";
import {
  downloadTaskLabel,
  formatJavaInvokeError,
  installTaskLabel,
  planMcVersionForJava,
  planNeedsJava,
  registerVanillaQueueUnlock,
  type JavaCheckResult,
  type VersionInstallPlanInput,
  type VersionInstallSessionStart,
} from "./version-install";

export type DownloadTaskStatus =
  | "queued"
  | "downloading"
  | "success"
  | "warning"
  | "error"
  | "cancelled";

export interface DownloadTask {
  /** React 渲染用的稳定本地标识；后端 taskId 更新时不变。 */
  clientId: string;
  taskId: number;
  label: string;
  mcVersion: string;
  status: DownloadTaskStatus;
  progress?: number;
  /** 当前阶段文案（如「下载原版文件」「安装mod加载器」） */
  detail?: string;
  /** 后端 progress 事件的 stage 字段（优先于 detail 展示） */
  stage?: string;
  /** 瞬时下载速度（字节/秒），仅在涉及下载的阶段有意义 */
  speedBps?: number;
  /** 已下载字节数（用于速度估算） */
  bytesDownloaded?: number;
  error?: string;
  /** 部分失败的文件数量 */
  failedCount?: number;
  /** 时间戳，用于排序 */
  startedAt: number;
  /** 目标实例目录名（组包/加载器安装完成后的 versions 文件夹名） */
  targetInstanceName?: string;
  /** Dual-task version-install role */
  role?: "download" | "install";
  /** Shared session id for download+install pair */
  sessionId?: string;
  /** Install tasks use indeterminate UI (no percent/speed) */
  progressMode?: "percent" | "indeterminate";
}

/** Matches Rust `ModUpdateInfo` (camelCase serde). */
export interface ModUpdatePayload {
  fileName: string;
  modId: string;
  modName: string;
  currentVersion: string;
  newVersion: string;
  source: string;
  downloadUrl: string;
  newFileName: string;
  slug: string;
}

interface DownloadContextValue {
  tasks: DownloadTask[];
  /** 启动一个原版下载任务（排队制）*/
  startDownload: (label: string, mcVersion: string, instanceName?: string) => Promise<number>;
  /** 启动 Java 下载（不排队）*/
  startJavaDownload: (runtimeName: string) => Promise<number>;
  /** 启动 OptiFine 下载（不排队）*/
  startOptifineDownload: (optifineVersion: string, mcVersion: string, instanceName?: string, optifineFallbackUrl?: string) => Promise<number>;
  /** 启动 Fabric 下载（不排队）*/
  startFabricDownload: (mcVersion: string, loaderVersion: string, apiVersion?: string, instanceName?: string) => Promise<number>;
  /** 启动 Quilt 下载（不排队）*/
  startQuiltDownload: (mcVersion: string, loaderVersion: string, apiVersion?: string, instanceName?: string) => Promise<number>;
  /** 启动 Forge 下载（不排队）*/
  startForgeDownload: (mcVersion: string, forgeVersion: string, instanceName?: string) => Promise<number>;
  /** 启动 NeoForge 下载（不排队）*/
  startNeoForgeDownload: (mcVersion: string, neoforgeVersion: string, instanceName?: string) => Promise<number>;
  /** 启动 LiteLoader 下载（不排队）*/
  startLiteLoaderDownload: (mcVersion: string, liteloaderVersion: string, instanceName?: string) => Promise<number>;
  /** 组合安装（原版必选 + 多个兼容加载器 + Fabric API，自动组包成实例）*/
  startCombinedInstall: (
    label: string,
    mcVersion: string,
    selections: { loader: string; version: string }[],
    instanceName: string
  ) => Promise<number>;
  /** Mod 文件下载 */
  startModDownload: (
    modSlug: string,
    modName: string,
    mcVersion: string,
    modLoader: string,
    downloadUrl: string,
    platform?: "modrinth" | "curseforge",
    projectId?: string
  ) => Promise<number>;
  /** 通用资源文件下载（mod / resourcepack / shaderpack / datapack / world） */
  startResourceDownload: (
    resourceKind: string,
    resourceSlug: string,
    resourceName: string,
    mcVersion: string,
    modLoader: string,
    downloadUrl: string,
    platform?: "modrinth" | "curseforge",
    projectId?: string,
    browseCategory?: string | null,
    apiProjectType?: string | null
  ) => Promise<number>;
  /** 整合包安装（异步） */
  startModpackDownload: (modpackName: string, path: string) => Promise<number>;
  /** 工具中心：自定义 URL 下载 */
  startCustomDownload: (opts: {
    url: string;
    directory: string;
    fileName?: string | null;
  }) => Promise<number>;
  /** 单个模组更新（下载到临时目录后替换，进度走 mod-download 事件） */
  startModUpdate: (
    instanceDir: string,
    mcVersion: string,
    loader: string,
    update: ModUpdatePayload,
    resourceKind?: string
  ) => Promise<number>;
  /** 批量模组更新 */
  startModUpdateAll: (
    instanceDir: string,
    mcVersion: string,
    loader: string,
    updates: ModUpdatePayload[],
    resourceKind?: string
  ) => Promise<number>;
  /** 取消一个下载任务 */
  cancelDownload: (taskId: number) => Promise<void>;
  /** 清除所有已完成/失败/取消的任务 */
  clearFinished: () => void;
  /** 从任务列表中移除单个任务 */
  removeTask: (taskId: number) => void;
  /** 右下角提示（版本列表加载等） */
  pushNotice: (input: PushDownloadCornerNoticeInput) => string;
  dismissNotice: (id: string) => void;
}

const DownloadContext = createContext<DownloadContextValue | null>(null);

export function useDownloadManager() {
  const ctx = useContext(DownloadContext);
  if (!ctx) {
    throw new Error("useDownloadManager must be used within DownloadProvider");
  }
  return ctx;
}

/** 排队中的任务（还未发往后端，只用于原版下载）*/
interface QueueItem {
  localDownloadId: number;
  localInstallId: number;
  displayName: string;
  mcVersion: string;
  instanceName?: string;
}

export function DownloadProvider({ children }: { children: React.ReactNode }) {
  return (
    <DownloadCornerNoticeProvider>
      <DownloadProviderInner>{children}</DownloadProviderInner>
    </DownloadCornerNoticeProvider>
  );
}

function DownloadProviderInner({ children }: { children: React.ReactNode }) {
  const { pushNotice, dismissNotice } = useDownloadCornerNotice();
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const unlistensRef = useRef<UnlistenFn[]>([]);
  const listenerSetupRef = useRef<Promise<void> | null>(null);
  const listenerOwnerActiveRef = useRef(true);
  const pendingQueueRef = useRef<QueueItem[]>([]);
  const isDownloadingRef = useRef(false);
  const localIdCounterRef = useRef(-1);
  /** 非原版下载的 taskId 计数器（从 1_000_000 起，避免与后端 taskId 冲突）*/
  const taskIdCounterRef = useRef(1_000_000);
  /** Local placeholder IDs cancelled before backend bind — remap cancel to real taskId. */
  const cancelledLocalIdsRef = useRef(new Set<number>());
  const showJavaPrecheckFailure = useCallback(
    (message: string) => {
      pushNotice({
        variant: "error",
        message,
      });
    },
    [pushNotice]
  );

  /** Strict Java preflight — returns false when UI should abort (no tasks created yet). */
  const ensureJavaForPlan = useCallback(
    async (plan: VersionInstallPlanInput): Promise<boolean> => {
      if (!planNeedsJava(plan)) return true;
      const mcVersion = planMcVersionForJava(plan);
      try {
        const result = await invoke<JavaCheckResult>("check_java_for_mc_version", {
          mcVersion,
          needsJava: true,
        });
        if (result.ok) return true;
        showJavaPrecheckFailure(
          result.errorMessage ||
            `未找到适用于 Minecraft ${mcVersion} 的 Java ${result.requiredMajor}+，请先前往设置下载或配置 Java。`
        );
        return false;
      } catch (e) {
        showJavaPrecheckFailure(formatJavaInvokeError(e));
        return false;
      }
    },
    [showJavaPrecheckFailure]
  );

  /** Avoid TDZ between dequeue ↔ session start ↔ listener warmup. */
  const ensureDownloadListenersRef = useRef<() => Promise<void>>(async () => {});
  const startVersionInstallSessionRef = useRef<
    (opts: {
      plan: VersionInstallPlanInput;
      displayName: string;
      mcVersion: string;
      instanceName?: string;
      localDownloadId?: number;
      localInstallId?: number;
      placeholdersExist?: boolean;
    }) => Promise<number>
  >(async () => {
    throw new Error("startVersionInstallSession not ready");
  });

  /** ========== 排队机制（仅用于原版 Minecraft 下载）========== */
  const dequeueNext = useCallback(async () => {
    if (isDownloadingRef.current) return;
    const next = pendingQueueRef.current.shift();
    if (!next) return;

    isDownloadingRef.current = true;
    try {
      await ensureDownloadListenersRef.current();
      const downloadTaskId = await startVersionInstallSessionRef.current({
        plan: {
          kind: "vanillaOnly",
          mcVersion: next.mcVersion,
          instanceName: next.instanceName ?? null,
        },
        displayName: next.displayName,
        mcVersion: next.mcVersion,
        instanceName: next.instanceName,
        localDownloadId: next.localDownloadId,
        localInstallId: next.localInstallId,
        placeholdersExist: true,
      });
      registerVanillaQueueUnlock(downloadTaskId);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("JAVA_PRECHECK_FAILED")) {
        setTasks((prev) =>
          prev.filter(
            (t) =>
              t.taskId !== next.localDownloadId && t.taskId !== next.localInstallId
          )
        );
      } else {
        setTasks((prev) =>
          prev.map((t) =>
            t.taskId === next.localDownloadId || t.taskId === next.localInstallId
              ? { ...t, status: "error" as const, error: msg }
              : t
          )
        );
      }
      isDownloadingRef.current = false;
      void dequeueNext();
    }
  }, []);

  /** 标记下载已结束，释放排队锁并尝试启动下一个任务 */
  const markDownloadDone = useCallback(() => {
    isDownloadingRef.current = false;
    void dequeueNext();
  }, [dequeueNext]);

  /** 首次下载前确保监听已经完成注册，空闲时会提前预热。 */
  const ensureDownloadListeners = useCallback(async () => {
    if (!isTauriRuntime() || unlistensRef.current.length > 0) return;
    if (!listenerSetupRef.current) {
      listenerSetupRef.current = import("./download-listeners")
        .then(({ setupAllDownloadListeners }) =>
          setupAllDownloadListeners(setTasks, markDownloadDone)
        )
        .then((unlistens) => {
          if (!listenerOwnerActiveRef.current) {
            unlistens.forEach((unlisten) => unlisten());
            listenerSetupRef.current = null;
            return;
          }
          unlistensRef.current = unlistens;
        })
        .catch((error) => {
          listenerSetupRef.current = null;
          throw error;
        });
    }
    await listenerSetupRef.current;
  }, [markDownloadDone]);
  ensureDownloadListenersRef.current = ensureDownloadListeners;

  /**
   * Create dual placeholders, invoke start_version_install_session, bind both IDs.
   * Returns downloadTaskId (compat with existing callers).
   * Callers must run Java-sensitive plans only after listeners are warm; Java is
   * checked here **before** creating placeholders.
   */
  const startVersionInstallSession = useCallback(
    async (opts: {
      plan: VersionInstallPlanInput;
      displayName: string;
      mcVersion: string;
      instanceName?: string;
      localDownloadId?: number;
      localInstallId?: number;
      placeholdersExist?: boolean;
    }): Promise<number> => {
      await ensureDownloadListenersRef.current();
      const {
        plan,
        displayName,
        mcVersion,
        instanceName,
        placeholdersExist = false,
      } = opts;

      if (!(await ensureJavaForPlan(plan))) {
        throw new Error("JAVA_PRECHECK_FAILED");
      }

      const localDownloadId = opts.localDownloadId ?? taskIdCounterRef.current++;
      const localInstallId = opts.localInstallId ?? taskIdCounterRef.current++;
      const startedAt = Date.now();

      if (!placeholdersExist) {
        const downloadTask: DownloadTask = {
          clientId: `client-${localDownloadId}`,
          taskId: localDownloadId,
          label: downloadTaskLabel(displayName),
          mcVersion,
          status: "downloading",
          detail: "准备下载",
          role: "download",
          progressMode: "percent",
          startedAt,
          ...(instanceName?.trim()
            ? { targetInstanceName: instanceName.trim() }
            : {}),
        };
        const installTask: DownloadTask = {
          clientId: `client-${localInstallId}`,
          taskId: localInstallId,
          label: installTaskLabel(displayName),
          mcVersion,
          status: "downloading",
          detail: "准备安装",
          role: "install",
          progressMode: "indeterminate",
          startedAt,
          ...(instanceName?.trim()
            ? { targetInstanceName: instanceName.trim() }
            : {}),
        };
        setTasks((prev) => [downloadTask, installTask, ...prev]);
        flyToProcessList();
      } else {
        setTasks((prev) =>
          prev.map((t) => {
            if (t.taskId === localDownloadId || t.taskId === localInstallId) {
              return {
                ...t,
                status: "downloading" as const,
                startedAt,
              };
            }
            return t;
          })
        );
      }

      try {
        const start = await invoke<VersionInstallSessionStart>(
          "start_version_install_session",
          { plan }
        );
        setTasks((prev) =>
          bindVersionInstallPair(
            prev,
            localDownloadId,
            localInstallId,
            start.downloadTaskId,
            start.installTaskId,
            start.sessionId,
            { status: "downloading" }
          ).map((t) => {
            if (t.taskId === start.downloadTaskId) {
              return {
                ...t,
                label: downloadTaskLabel(start.displayName || displayName),
                detail: t.detail ?? "准备下载",
              };
            }
            if (t.taskId === start.installTaskId) {
              return {
                ...t,
                label: installTaskLabel(start.displayName || displayName),
                detail: t.detail ?? "准备安装",
              };
            }
            return t;
          })
        );

        if (
          cancelledLocalIdsRef.current.has(localDownloadId) ||
          cancelledLocalIdsRef.current.has(localInstallId)
        ) {
          cancelledLocalIdsRef.current.delete(localDownloadId);
          cancelledLocalIdsRef.current.delete(localInstallId);
          cancelledLocalIdsRef.current.add(start.downloadTaskId);
          cancelledLocalIdsRef.current.add(start.installTaskId);
          dismissTaskIds(localDownloadId, localInstallId);
          if (isTaskDismissed(localDownloadId) || isTaskDismissed(localInstallId)) {
            dismissTaskIds(start.downloadTaskId, start.installTaskId);
          } else {
            setTasks((prev) =>
              prev.map((t) =>
                t.sessionId === start.sessionId ||
                t.taskId === start.downloadTaskId ||
                t.taskId === start.installTaskId
                  ? { ...t, status: "cancelled" as const, error: "已取消" }
                  : t
              )
            );
          }
          try {
            await invoke("cancel_version_install_session", {
              sessionId: start.sessionId,
            });
          } catch (cancelErr) {
            console.error("取消版本安装会话失败:", cancelErr);
          }
        }
        return start.downloadTaskId;
      } catch (e) {
        const message = String(e).includes("JAVA_")
          ? formatJavaInvokeError(e)
          : String(e);
        if (String(e).includes("JAVA_")) {
          showJavaPrecheckFailure(message);
        }
        setTasks((prev) =>
          prev.map((t) =>
            t.taskId === localDownloadId || t.taskId === localInstallId
              ? { ...t, status: "error" as const, error: message }
              : t
          )
        );
        throw e;
      }
    },
    [ensureJavaForPlan, showJavaPrecheckFailure]
  );
  startVersionInstallSessionRef.current = startVersionInstallSession;

  /** ========== 空闲时预热事件监听 ========== */
  useEffect(() => {
    if (!isTauriRuntime()) return;

    let cancelled = false;
    listenerOwnerActiveRef.current = true;
    const warmUp = () => {
      void ensureDownloadListeners().catch((error) => {
        if (!cancelled) console.error("注册下载事件监听失败:", error);
      });
    };
    const timeoutId = window.setTimeout(warmUp, 0);

    return () => {
      cancelled = true;
      listenerOwnerActiveRef.current = false;
      window.clearTimeout(timeoutId);
      unlistensRef.current.forEach((fn) => fn());
      unlistensRef.current = [];
      listenerSetupRef.current = null;
    };
  }, [ensureDownloadListeners]);

  /** ========== 启动函数 ========== */

  /** 原版下载（排队制）— dual-task version-install session */
  const startDownload = useCallback(
    async (label: string, mcVersion: string, instanceName?: string): Promise<number> => {
      await ensureDownloadListeners();
      const displayName = instanceName?.trim() || label || mcVersion;
      flyToProcessList();
      if (!isDownloadingRef.current) {
        isDownloadingRef.current = true;
        try {
          const downloadTaskId = await startVersionInstallSession({
            plan: {
              kind: "vanillaOnly",
              mcVersion,
              instanceName: instanceName ?? null,
            },
            displayName,
            mcVersion,
            instanceName,
          });
          registerVanillaQueueUnlock(downloadTaskId);
          return downloadTaskId;
        } catch (e) {
          isDownloadingRef.current = false;
          void dequeueNext();
          if (String(e).includes("JAVA_PRECHECK_FAILED")) return -1;
          throw e;
        }
      }

      const localDownloadId = localIdCounterRef.current--;
      const localInstallId = localIdCounterRef.current--;
      pendingQueueRef.current.push({
        localDownloadId,
        localInstallId,
        displayName,
        mcVersion,
        instanceName,
      });
      const startedAt = Date.now();
      const downloadTask: DownloadTask = {
        clientId: `client-${localDownloadId}`,
        taskId: localDownloadId,
        label: downloadTaskLabel(displayName),
        mcVersion,
        status: "queued",
        role: "download",
        progressMode: "percent",
        startedAt,
        ...(instanceName?.trim()
          ? { targetInstanceName: instanceName.trim() }
          : {}),
      };
      const installTask: DownloadTask = {
        clientId: `client-${localInstallId}`,
        taskId: localInstallId,
        label: installTaskLabel(displayName),
        mcVersion,
        status: "queued",
        role: "install",
        progressMode: "indeterminate",
        startedAt,
        ...(instanceName?.trim()
          ? { targetInstanceName: instanceName.trim() }
          : {}),
      };
      setTasks((prev) => [downloadTask, installTask, ...prev]);
      return localDownloadId;
    },
    [dequeueNext, ensureDownloadListeners, startVersionInstallSession]
  );

  /** 使用工厂生成的通用 start 函数 */
  const startModLoaderDownload = makeStartDownloadFn(
    setTasks,
    taskIdCounterRef,
    dequeueNext,
    ensureDownloadListeners,
    cancelledLocalIdsRef
  );

  /** Java 下载 - 只创建前端 task，不 invoke，Java 下载由其他命令触发 */
  const startJavaDownload = useCallback(async (runtimeName: string) => {
    await ensureDownloadListeners();
    flyToProcessList();
    const taskId = taskIdCounterRef.current++;
    setTasks((prev) => {
      const isDownloading = prev.some(
        (t) => t.label === runtimeName && (t.status === "downloading" || t.status === "success")
      );
      if (isDownloading) return prev;
      const task: DownloadTask = {
        clientId: `client-${taskId}`,
        taskId,
        label: runtimeName,
        mcVersion: "Java",
        status: "downloading",
        detail: "下载",
        startedAt: Date.now(),
      };
      return [task, ...prev];
    });
    return taskId;
  }, [ensureDownloadListeners]);

  const startSingleLoaderSession = useCallback(
    async (
      loaderType: string,
      mcVersion: string,
      loaderVersion: string,
      displayName: string,
      instanceName?: string,
      apiVersion?: string
    ) => {
      try {
        return await startVersionInstallSession({
          plan: {
            kind: "singleLoader",
            loaderType,
            mcVersion,
            loaderVersion,
            apiVersion: apiVersion || null,
            instanceName: instanceName ?? null,
          },
          displayName: instanceName?.trim() || displayName,
          mcVersion,
          instanceName,
        });
      } catch (e) {
        if (String(e).includes("JAVA_PRECHECK_FAILED")) return -1;
        throw e;
      }
    },
    [startVersionInstallSession]
  );

  /** OptiFine */
  const startOptifineDownload = useCallback(
    async (optifineVersion: string, mcVersion: string, instanceName?: string, _optifineFallbackUrl?: string) => {
      return startSingleLoaderSession(
        "optifine",
        mcVersion,
        optifineVersion,
        optifineVersion,
        instanceName
      );
    },
    [startSingleLoaderSession]
  );

  /** Fabric */
  const startFabricDownload = useCallback(
    async (mcVersion: string, loaderVersion: string, apiVersion?: string, instanceName?: string) => {
      const label = `Fabric ${loaderVersion}${apiVersion ? ` + API ${apiVersion}` : ""}`;
      return startSingleLoaderSession(
        "fabric",
        mcVersion,
        loaderVersion,
        label,
        instanceName,
        apiVersion
      );
    },
    [startSingleLoaderSession]
  );

  /** Quilt */
  const startQuiltDownload = useCallback(
    async (mcVersion: string, loaderVersion: string, apiVersion?: string, instanceName?: string) => {
      const label = `Quilt ${loaderVersion}${apiVersion ? ` + API ${apiVersion}` : ""}`;
      return startSingleLoaderSession(
        "quilt",
        mcVersion,
        loaderVersion,
        label,
        instanceName,
        apiVersion
      );
    },
    [startSingleLoaderSession]
  );

  /** Forge */
  const startForgeDownload = useCallback(
    async (mcVersion: string, forgeVersion: string, instanceName?: string) => {
      const label = `Forge ${forgeVersion} (MC ${mcVersion})`;
      return startSingleLoaderSession("forge", mcVersion, forgeVersion, label, instanceName);
    },
    [startSingleLoaderSession]
  );

  /** NeoForge */
  const startNeoForgeDownload = useCallback(
    async (mcVersion: string, neoforgeVersion: string, instanceName?: string) => {
      const label = `NeoForge ${neoforgeVersion} (MC ${mcVersion})`;
      return startSingleLoaderSession(
        "neoforge",
        mcVersion,
        neoforgeVersion,
        label,
        instanceName
      );
    },
    [startSingleLoaderSession]
  );

  /** LiteLoader */
  const startLiteLoaderDownload = useCallback(
    async (mcVersion: string, liteloaderVersion: string, instanceName?: string) => {
      const label = `LiteLoader ${liteloaderVersion} (MC ${mcVersion})`;
      return startSingleLoaderSession(
        "liteloader",
        mcVersion,
        liteloaderVersion,
        label,
        instanceName
      );
    },
    [startSingleLoaderSession]
  );

  /** Mod 文件下载 */
  const startModDownload = useCallback(
    async (
      modSlug: string,
      modName: string,
      mcVersion: string,
      modLoader: string,
      downloadUrl: string,
      platform?: "modrinth" | "curseforge",
      projectId?: string
    ) => {
      const label = `${modName} (${mcVersion})`;
      return startModLoaderDownload({
        label,
        mcVersion,
        tauriCommand: "download_mod_file",
        params: {
          modSlug,
          modName,
          mcVersion,
          modLoader,
          downloadUrl,
          platform: platform ?? null,
          projectId: projectId ?? null,
        },
      });
    },
    [startModLoaderDownload]
  );

  /** 通用资源文件下载（mod / resourcepack / shaderpack / datapack / world） */
  const startResourceDownload = useCallback(
    async (
      resourceKind: string,
      resourceSlug: string,
      resourceName: string,
      mcVersion: string,
      modLoader: string,
      downloadUrl: string,
      platform?: "modrinth" | "curseforge",
      projectId?: string,
      browseCategory?: string | null,
      apiProjectType?: string | null
    ) => {
      const label = `${resourceName} (${mcVersion})`;
      return startModLoaderDownload({
        label,
        mcVersion,
        tauriCommand: "download_resource_file",
        params: {
          resourceKind,
          resourceSlug,
          resourceName,
          mcVersion,
          modLoader,
          downloadUrl,
          platform: resourceKind === "mod" ? (platform ?? null) : null,
          projectId: resourceKind === "mod" ? (projectId ?? null) : null,
          browseCategory: browseCategory ?? null,
          apiProjectType: apiProjectType ?? null,
        },
      });
    },
    [startModLoaderDownload]
  );

  /** 组合安装（原版 + 多个兼容加载器 + Fabric API）— dual-task session */
  const startCombinedInstall = useCallback(
    async (
      label: string,
      mcVersion: string,
      selections: { loader: string; version: string }[],
      instanceName: string
    ) => {
      try {
        return await startVersionInstallSession({
          plan: {
            kind: "combined",
            mcVersion,
            selections: selections.map((s) => ({
              loaderType: s.loader,
              version: s.version,
            })),
            instanceName: instanceName || null,
          },
          displayName: instanceName.trim() || label || mcVersion,
          mcVersion,
          instanceName,
        });
      } catch (e) {
        if (String(e).includes("JAVA_PRECHECK_FAILED")) return -1;
        throw e;
      }
    },
    [startVersionInstallSession]
  );

  /** 整合包安装（异步，进度显示在任务队列） */
  const startModpackDownload = useCallback(
    async (modpackName: string, path: string) => {
      try {
        return await startVersionInstallSession({
          plan: { kind: "modpack", zipPath: path },
          displayName: modpackName,
          mcVersion: "整合包",
        });
      } catch (e) {
        if (String(e).includes("JAVA_PRECHECK_FAILED")) return -1;
        throw e;
      }
    },
    [startVersionInstallSession]
  );

  const updateKindLabel = (resourceKind: string) => {
    switch (resourceKind) {
      case "resourcepack":
        return "资源包";
      case "shaderpack":
        return "光影包";
      case "datapack":
        return "数据包";
      case "mod":
      default:
        return "模组";
    }
  };

  /** 单个模组更新 */
  const startModUpdate = useCallback(
    async (
      instanceDir: string,
      mcVersion: string,
      loader: string,
      update: ModUpdatePayload,
      resourceKind: string = "mod"
    ) => {
      const kind = updateKindLabel(resourceKind);
      const label = `更新${kind} ${update.modName} (${update.currentVersion} → ${update.newVersion})`;
      const command = resourceKind === "mod" ? "update_mod" : "update_resource";
      return startModLoaderDownload({
        label,
        mcVersion,
        tauriCommand: command,
        params: {
          instanceDir,
          mcVersion,
          loader,
          update,
          displayLabel: label,
          ...(resourceKind !== "mod" ? { resourceKind } : {}),
        },
      });
    },
    [startModLoaderDownload]
  );

  /** 批量模组更新 */
  const startModUpdateAll = useCallback(
    async (
      instanceDir: string,
      mcVersion: string,
      loader: string,
      updates: ModUpdatePayload[],
      resourceKind: string = "mod"
    ) => {
      const kind = updateKindLabel(resourceKind);
      const label = `更新${kind} ×${updates.length}`;
      const command = resourceKind === "mod" ? "update_mods" : "update_resources";
      return startModLoaderDownload({
        label,
        mcVersion,
        tauriCommand: command,
        params: {
          instanceDir,
          mcVersion,
          loader,
          updates,
          displayLabel: label,
          ...(resourceKind !== "mod" ? { resourceKind } : {}),
        },
      });
    },
    [startModLoaderDownload]
  );

  const startCustomDownload = useCallback(
    async (opts: { url: string; directory: string; fileName?: string | null }) => {
      await ensureDownloadListeners();
      const localTaskId = taskIdCounterRef.current++;
      const trimmedName = opts.fileName?.trim() ?? "";
      let displayName = trimmedName;
      if (!displayName) {
        try {
          const segment = new URL(opts.url.trim()).pathname.split("/").filter(Boolean).pop();
          displayName = segment && segment.length > 0 ? segment : "download.bin";
        } catch {
          displayName = "download.bin";
        }
      }
      const label = `自定义下载: ${displayName}`;

      setTasks((prev) => {
        const task: DownloadTask = {
          clientId: `client-${localTaskId}`,
          taskId: localTaskId,
          label,
          mcVersion: "—",
          status: "downloading",
          detail: "准备中…",
          startedAt: Date.now(),
        };
        return [task, ...prev];
      });

      flyToProcessList();

      try {
        const returnedTaskId = await invoke<number>("start_custom_download", {
          url: opts.url.trim(),
          directory: opts.directory.trim(),
          fileName: trimmedName.length > 0 ? trimmedName : null,
        });
        if (returnedTaskId !== localTaskId) {
          setTasks((prev) => bindBackendTaskId(prev, localTaskId, returnedTaskId));
        }
        const effectiveId = returnedTaskId;
        if (cancelledLocalIdsRef.current.has(localTaskId)) {
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
        console.error("启动自定义下载失败:", err);
        setTasks((prev) =>
          prev.map((t) =>
            t.taskId === localTaskId ? { ...t, status: "error", error: String(err) } : t
          )
        );
        throw err;
      }
    },
    [ensureDownloadListeners]
  );

  /** ========== 取消与清理 ========== */
  const cancelDownload = useCallback(
    async (taskId: number) => {
      // Snapshot pairing from latest tasks state.
      const snapshot = await new Promise<{
        sessionId?: string;
        pairedIds: number[];
      }>((resolve) => {
        setTasks((prev) => {
          const target = prev.find((t) => t.taskId === taskId);
          let pairedIds = [taskId];
          const sid = target?.sessionId;
          if (sid) {
            pairedIds = prev.filter((t) => t.sessionId === sid).map((t) => t.taskId);
          } else if (target?.role) {
            const sibling = prev.find(
              (t) =>
                t.taskId !== taskId &&
                !t.sessionId &&
                t.role &&
                t.role !== target.role &&
                t.mcVersion === target.mcVersion &&
                Math.abs(t.startedAt - target.startedAt) < 2000
            );
            if (sibling) pairedIds = [taskId, sibling.taskId];
          }
          resolve({ sessionId: sid, pairedIds });
          return prev;
        });
      });

      const { sessionId, pairedIds } = snapshot;

      pendingQueueRef.current = pendingQueueRef.current.filter(
        (item) =>
          !pairedIds.includes(item.localDownloadId) &&
          !pairedIds.includes(item.localInstallId)
      );

      for (const id of pairedIds) {
        cancelledLocalIdsRef.current.add(id);
        dismissTaskIds(id);
      }

      const allQueuedLocal = pairedIds.every((id) => id < 0);
      if (allQueuedLocal) {
        setTasks((prev) => prev.filter((t) => !pairedIds.includes(t.taskId)));
        return;
      }

      setTasks((prev) =>
        prev.map((t) =>
          pairedIds.includes(t.taskId) &&
          (t.status === "downloading" || t.status === "queued")
            ? { ...t, status: "cancelled" as const, error: "已取消" }
            : t
        )
      );

      try {
        if (sessionId) {
          await invoke("cancel_version_install_session", { sessionId });
        } else {
          // Legacy / unbound: cancel by either task id (backend maps to session).
          await Promise.allSettled([
            ...pairedIds.flatMap((id) => [
              invoke("cancel_download", { taskId: id }),
              invoke("cancel_combined_download", { taskId: id }),
              invoke("cancel_optifine_download", { taskId: id }),
              invoke("cancel_fabric_download", { taskId: id }),
              invoke("cancel_quilt_download", { taskId: id }),
              invoke("cancel_forge_download", { taskId: id }),
              invoke("cancel_neoforge_download", { taskId: id }),
              invoke("cancel_liteloader_download", { taskId: id }),
              invoke("cancel_modpack_install", { taskId: id }),
            ]),
            invoke("cancel_mod_download", { taskId }),
            invoke("cancel_custom_download", { taskId }),
            invoke("cancel_java_download", { taskId }),
          ]);
        }
      } catch (e) {
        console.error("取消下载失败:", e);
      }
      isDownloadingRef.current = false;
      void dequeueNext();
    },
    [dequeueNext]
  );

  const clearFinished = useCallback(() => {
    setTasks((prev) => {
      const keep: DownloadTask[] = [];
      const removedIds: number[] = [];
      for (const t of prev) {
        if (t.status === "downloading" || t.status === "queued") {
          keep.push(t);
        } else {
          removedIds.push(t.taskId);
        }
      }
      dismissTaskIds(...removedIds);
      return keep;
    });
  }, []);

  const removeTask = useCallback((taskId: number) => {
    dismissTaskIds(taskId);
    cancelledLocalIdsRef.current.delete(taskId);
    setTasks((prev) => prev.filter((t) => t.taskId !== taskId));
  }, []);

  return (
    <DownloadContext.Provider
      value={{
        tasks,
        startDownload,
        startJavaDownload,
        startOptifineDownload,
        startFabricDownload,
        startQuiltDownload,
        startForgeDownload,
        startNeoForgeDownload,
        startLiteLoaderDownload,
        startCombinedInstall,
        startModDownload,
        startResourceDownload,
        startModpackDownload,
        startCustomDownload,
        startModUpdate,
        startModUpdateAll,
        cancelDownload,
        clearFinished,
        removeTask,
        pushNotice,
        dismissNotice,
      }}
    >
      {children}
    </DownloadContext.Provider>
  );
}
