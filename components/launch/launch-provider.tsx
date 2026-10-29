"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAccountContext } from "@/components/accounts/account-provider";
import { isTauriRuntime } from "@/lib/tauri-runtime";
import { isAutoJavaSelection, JAVA_AUTO_SELECT_PATH } from "@/lib/java-paths";
import { appLog } from "@/lib/runtime-log";
import { readMigratedLocalStorage } from "@/lib/storage-migrate";
import { log4jParser } from "@/components/launch/log4j-progress-parser";
import { useI18n } from "@/components/i18n/use-i18n";
import { analyzeLaunchLogs } from "@/components/launch/launch-analyzer";
import { setLaunchInFlight } from "@/lib/launch-in-flight";
import type {
  LaunchAnalysisReport,
  LaunchConfig,
  LaunchLogEntry,
  LaunchProgress,
  LaunchStatus,
  RunningLaunchInstance,
} from "@/types";

/** 默认启动配置 */
export const DEFAULT_INITIAL_JVM_ARGS = `-XX:+UnlockExperimentalVMOptions
-XX:+DisableExplicitGC
-XX:MaxGCPauseMillis=200
-Dfml.ignorePatchDiscrepancies=true
-Dfml.ignoreInvalidMinecraftCertificates=true
-Duser.language=zh
-Duser.country=CN
-Dminecraft.api.env=production
-Dminecraft.api.location=https://api.minecraftservices.com/
-Dfml.readTimeout=180
-Dio.netty.allocator.type=unpooled`;

const DEFAULT_LAUNCH_CONFIG: LaunchConfig = {
  minecraftPath: "",
  javaPath: "",
  wrapperPath: "",
  processPriority: "medium",
  maxMemory: "2048",
  autoMemory: true,
  versionName: "",
  minecraftVersion: "",
  loadType: "0",
  loadName: "",
  playerName: "",
  authToken: "",
  uuid: "",
  windowWidth: "873",
  windowHeight: "486",
  authlibInjectorPath: "",
  yggdrasilApi: "",
  prefetchedData: "",
  customJvmArgs: DEFAULT_INITIAL_JVM_ARGS,
};

const MAX_LOG_ENTRIES = 500;

interface LaunchContextValue {
  config: LaunchConfig;
  updateConfig: (patch: Partial<LaunchConfig>) => void;
  status: LaunchStatus;
  logs: LaunchLogEntry[];
  logsByPid: Record<number, LaunchLogEntry[]>;
  selectedLogPid: number | null;
  setSelectedLogPid: (pid: number | null) => void;
  runningInstances: RunningLaunchInstance[];
  errorMessage: string | null;
  launchGame: (overrides?: Partial<LaunchConfig>) => Promise<void>;
  cancelLaunch: () => Promise<void>;
  clearLogs: () => void;
  lastCommandArgs: string | null;
  lastLaunchTime: string | null;
  configLoaded: boolean;
  progress: LaunchProgress | null;
  launchStartedAt: number | null;
  launchEndedAt: number | null;
  lastExitCode: number | null;
  generateReport: () => LaunchAnalysisReport;
  exportLaunchReport: () => Promise<string>;
}

const LaunchContext = createContext<LaunchContextValue | null>(null);

export function useLaunchContext() {
  const ctx = useContext(LaunchContext);
  if (!ctx) {
    throw new Error("useLaunchContext must be used within LaunchProvider");
  }
  return ctx;
}

function appendLogEntry(
  prev: LaunchLogEntry[],
  entry: LaunchLogEntry,
): LaunchLogEntry[] {
  const next = [...prev, entry];
  return next.length > MAX_LOG_ENTRIES ? next.slice(-MAX_LOG_ENTRIES) : next;
}

function deriveStatus(options: {
  launchInFlight: boolean;
  instances: RunningLaunchInstance[];
  lastStatusHint: LaunchStatus | null;
}): LaunchStatus {
  const { launchInFlight, instances, lastStatusHint } = options;
  if (launchInFlight) {
    return lastStatusHint === "launching" ? "launching" : "preparing";
  }
  if (instances.length === 0) {
    return lastStatusHint === "error"
      ? "error"
      : lastStatusHint === "stopped"
        ? "stopped"
        : "idle";
  }
  if (instances.some((i) => !i.fullyStarted)) {
    return "launching";
  }
  return "running";
}

export function LaunchProvider({ children }: { children: React.ReactNode }) {
  const { t, language } = useI18n();
  const [config, setConfig] = useState<LaunchConfig>(DEFAULT_LAUNCH_CONFIG);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [status, setStatus] = useState<LaunchStatus>("idle");
  const [logsByPid, setLogsByPid] = useState<Record<number, LaunchLogEntry[]>>({});
  const [selectedLogPid, setSelectedLogPid] = useState<number | null>(null);
  const [runningInstances, setRunningInstances] = useState<RunningLaunchInstance[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastCommandArgs, setLastCommandArgs] = useState<string | null>(null);
  const [lastLaunchTime, setLastLaunchTime] = useState<string | null>(null);
  const [progress, setProgress] = useState<LaunchProgress | null>(null);
  const [launchStartedAt, setLaunchStartedAt] = useState<number | null>(null);
  const [launchEndedAt, setLaunchEndedAt] = useState<number | null>(null);
  const [lastExitCode, setLastExitCode] = useState<number | null>(null);
  const logIdRef = useRef(0);
  const pendingLogsRef = useRef<LaunchLogEntry[]>([]);
  const launchInFlightRef = useRef(false);
  /** Bumped on each launch start and on cancel; stale launchGame loops exit when mismatched. */
  const launchGenerationRef = useRef(0);
  const statusHintRef = useRef<LaunchStatus | null>(null);
  const fullyStartedPidsRef = useRef<Set<number>>(new Set());
  const instancesRef = useRef<RunningLaunchInstance[]>([]);
  const selectedLogPidRef = useRef<number | null>(null);

  const syncLaunchInFlight = useCallback((active: boolean) => {
    launchInFlightRef.current = active;
    setLaunchInFlight(active);
  }, []);

  const syncStatus = useCallback((instances: RunningLaunchInstance[]) => {
    instancesRef.current = instances;
    setStatus(
      deriveStatus({
        launchInFlight: launchInFlightRef.current,
        instances,
        lastStatusHint: statusHintRef.current,
      }),
    );
  }, []);

  // 本地配置先恢复，使首屏不必等待原生 I/O；原生路径查询完成后再无缝合并。
  useEffect(() => {
    let cancelled = false;
    let savedConfig: Partial<LaunchConfig> = {};
    try {
      const saved = readMigratedLocalStorage("openx-launch-config", ["rtl-launch-config"]);
      if (saved) savedConfig = JSON.parse(saved);
      const savedTime = readMigratedLocalStorage("openx-last-launch-time", ["rtl-last-launch-time"]);
      if (savedTime) setLastLaunchTime(savedTime);
    } catch { /* ignore */ }

    let nativePathsResolved = false;
    let localConfigApplied = false;

    const tryMarkLoaded = () => {
      if (!cancelled && localConfigApplied && nativePathsResolved) {
        appLog.info("launch", "config loaded", {
          localConfigApplied,
          nativePathsResolved,
        });
        setConfigLoaded(true);
      }
    };

    queueMicrotask(() => {
      if (cancelled) return;
      setConfig((prev) => ({ ...prev, ...savedConfig }));
      localConfigApplied = true;
      tryMarkLoaded();
    });

    const loadNativePaths = async () => {
      if (!isTauriRuntime()) {
        nativePathsResolved = true;
        tryMarkLoaded();
        return;
      }
      try {
        const setup = await invoke<{
          executed: boolean;
          recommended_memory_mb: number;
          selected_java_path: string;
          selected_minecraft_path: string;
        }>("run_portable_first_launch_setup");

        const pathsCfg = await invoke<{
          selected_java_path: string;
          selected_minecraft_path: string;
        }>("get_launcher_paths_config");

        try {
          await invoke<string | null>("maybe_install_bundled_modpack_cmd");
        } catch (bundledErr) {
          console.warn("bundled modpack install:", bundledErr);
        }

        if (cancelled) return;

        const autoMemory =
          typeof savedConfig.autoMemory === "boolean"
            ? savedConfig.autoMemory
            : setup.executed ||
              !savedConfig.maxMemory ||
              savedConfig.maxMemory === DEFAULT_LAUNCH_CONFIG.maxMemory;

        setConfig((prev) => ({
          ...prev,
          autoMemory,
          ...(autoMemory
            ? { maxMemory: String(setup.recommended_memory_mb) }
            : {}),
          javaPath: pathsCfg.selected_java_path || JAVA_AUTO_SELECT_PATH,
          ...(pathsCfg.selected_minecraft_path
            ? { minecraftPath: pathsCfg.selected_minecraft_path }
            : {}),
        }));
      } catch {
        /* ignore */
      } finally {
        nativePathsResolved = true;
        tryMarkLoaded();
      }
    };

    void loadNativePaths();
    return () => { cancelled = true; };
  }, []);

  // 恢复已在跑的进程（热重载 / 重启前端）
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    void invoke<{
      running: boolean;
      instances?: RunningLaunchInstance[];
    }>("get_running_game_state")
      .then((state) => {
        if (cancelled) return;
        const instances = state.instances ?? [];
        setRunningInstances(instances);
        instancesRef.current = instances;
        for (const inst of instances) {
          if (inst.fullyStarted) fullyStartedPidsRef.current.add(inst.pid);
        }
        if (instances.length > 0) {
          setSelectedLogPid((prev) => prev ?? instances[instances.length - 1]!.pid);
          syncStatus(instances);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [syncStatus]);

  const { selectedProfile, prepareMicrosoftAccountForLaunch, cancelMicrosoftLogin } =
    useAccountContext();

  useEffect(() => {
    selectedLogPidRef.current = selectedLogPid;
  }, [selectedLogPid]);

  const pushLogToPid = useCallback((pid: number, entry: LaunchLogEntry) => {
    setLogsByPid((prev) => ({
      ...prev,
      [pid]: appendLogEntry(prev[pid] ?? [], entry),
    }));
  }, []);

  const addPendingOrSelectedLog = useCallback(
    (level: LaunchLogEntry["level"], message: string) => {
      const entry: LaunchLogEntry = {
        id: ++logIdRef.current,
        timestamp: new Date().toLocaleTimeString(),
        level,
        message,
      };
      const targetPid = selectedLogPidRef.current;
      if (targetPid != null && instancesRef.current.some((i) => i.pid === targetPid)) {
        pushLogToPid(targetPid, entry);
        return;
      }
      pendingLogsRef.current = appendLogEntry(pendingLogsRef.current, entry);
      // 尚无 pid 时也刷新到「未绑定」视图
      setLogsByPid((prev) => ({ ...prev }));
    },
    [pushLogToPid],
  );

  const logs = useMemo(() => {
    if (selectedLogPid != null) {
      return logsByPid[selectedLogPid] ?? [];
    }
    return pendingLogsRef.current;
  }, [logsByPid, selectedLogPid]);

  const updateConfig = useCallback((patch: Partial<LaunchConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem("openx-launch-config", JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const clearLogs = useCallback(() => {
    if (selectedLogPid != null) {
      setLogsByPid((prev) => ({ ...prev, [selectedLogPid]: [] }));
    } else {
      pendingLogsRef.current = [];
      setLogsByPid((prev) => ({ ...prev }));
    }
  }, [selectedLogPid]);

  // 监听游戏日志事件（来自 Minecraft log4j stdout/stderr）
  useEffect(() => {
    if (!isTauriRuntime()) return;

    let unlisten: (() => void) | null = null;
    listen<{ pid?: number | null; level: string; message: string }>("game-log", (event) => {
      const { pid, level, message } = event.payload;
      const logLevel: "error" | "info" | "warn" =
        level === "error" || level === "warn" ? level : "info";

      if (launchInFlightRef.current || status === "launching" || status === "preparing") {
        const parsedProgress = log4jParser.parseLog(message);
        if (parsedProgress.stage) {
          const allStages = log4jParser.getAllStages();
          const currentStageIndex = allStages.findIndex((s) => s.id === parsedProgress.stage?.id);
          setProgress({
            currentStep: currentStageIndex + 1,
            totalSteps: allStages.length,
            currentStage: parsedProgress.stage.name,
            percentage: parsedProgress.progress,
          });
        }
      }

      const entry: LaunchLogEntry = {
        id: ++logIdRef.current,
        timestamp: new Date().toLocaleTimeString(),
        level: logLevel,
        message,
      };

      if (typeof pid === "number") {
        setLogsByPid((prev) => ({
          ...prev,
          [pid]: appendLogEntry(prev[pid] ?? [], entry),
        }));
      } else {
        pendingLogsRef.current = appendLogEntry(pendingLogsRef.current, entry);
        setLogsByPid((prev) => ({ ...prev }));
      }
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [status]);

  // 新进程登记
  useEffect(() => {
    if (!isTauriRuntime()) return;

    let unlisten: (() => void) | null = null;
    listen<{ pid: number; gameDir: string; displayName: string }>(
      "game-process-started",
      (event) => {
        const { pid, gameDir, displayName } = event.payload;
        const pending = pendingLogsRef.current;
        pendingLogsRef.current = [];
        if (pending.length > 0) {
          setLogsByPid((prev) => {
            const merged = [...pending, ...(prev[pid] ?? [])];
            return {
              ...prev,
              [pid]:
                merged.length > MAX_LOG_ENTRIES
                  ? merged.slice(-MAX_LOG_ENTRIES)
                  : merged,
            };
          });
        }

        setRunningInstances((prev) => {
          if (prev.some((i) => i.pid === pid)) return prev;
          const next = [
            ...prev,
            { pid, gameDir, displayName, fullyStarted: false },
          ];
          syncStatus(next);
          return next;
        });
        setSelectedLogPid(pid);
        syncLaunchInFlight(false);
        statusHintRef.current = "launching";
        setStatus("launching");
      },
    ).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [syncStatus, syncLaunchInFlight]);

  // 监听游戏进程退出事件
  useEffect(() => {
    if (!isTauriRuntime()) return;

    let unlisten: (() => void) | null = null;
    listen<{ pid: number; exitCode: number; gameDir?: string } | number>("game-exited", (event) => {
      const payload = event.payload;
      const exitCode = typeof payload === "number" ? payload : payload.exitCode;
      const pid = typeof payload === "number" ? null : payload.pid;
      const hadFullyStarted =
        pid != null
          ? fullyStartedPidsRef.current.has(pid)
          : fullyStartedPidsRef.current.size > 0;
      if (pid != null) fullyStartedPidsRef.current.delete(pid);

      const now = Date.now();
      const timeStr = new Date(now).toLocaleString();
      setLastLaunchTime(timeStr);
      setLaunchEndedAt(now);
      setLastExitCode(exitCode);
      try { localStorage.setItem("openx-last-launch-time", timeStr); } catch { /* ignore */ }

      const exitEntry: LaunchLogEntry = {
        id: ++logIdRef.current,
        timestamp: new Date(now).toLocaleTimeString(),
        level: exitCode === 0 || hadFullyStarted ? "info" : "warn",
        message: t("launch.provider.gameExitedWithCodeExitCode", { exitCode }),
      };
      if (pid != null) {
        pushLogToPid(pid, exitEntry);
      } else {
        pendingLogsRef.current = appendLogEntry(pendingLogsRef.current, exitEntry);
      }

      setRunningInstances((prev) => {
        const next = pid != null ? prev.filter((i) => i.pid !== pid) : [];
        if (next.length === 0) {
          setProgress(null);
          log4jParser.reset();
          statusHintRef.current =
            exitCode === 0 || hadFullyStarted ? "stopped" : "error";
        }
        syncStatus(next);
        setSelectedLogPid((current) => {
          if (pid != null && current === pid) {
            return next.length > 0 ? next[next.length - 1]!.pid : null;
          }
          return current;
        });
        return next;
      });
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [t, pushLogToPid, syncStatus]);

  // 监听游戏完全启动事件（JVM 启动完成、资源加载完成）
  useEffect(() => {
    if (!isTauriRuntime()) return;

    let unlisten: (() => void) | null = null;
    listen<{ pid: number } | number>("game-fully-started", (event) => {
      const payload = event.payload;
      const pid = typeof payload === "number" ? payload : payload.pid;
      fullyStartedPidsRef.current.add(pid);
      setProgress(null);

      setRunningInstances((prev) => {
        const next = prev.map((i) =>
          i.pid === pid ? { ...i, fullyStarted: true } : i,
        );
        syncStatus(next);
        return next;
      });

      pushLogToPid(pid, {
        id: ++logIdRef.current,
        timestamp: new Date().toLocaleTimeString(),
        level: "info",
        message: t("launch.provider.gameFullyStartedPidPidStoppedJvmTracking", { pid }),
      });
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [t, pushLogToPid, syncStatus]);

  // 监听启动进度事件
  useEffect(() => {
    if (!isTauriRuntime()) return;

    let unlisten: (() => void) | null = null;
    listen<{ current_step: number; total_steps: number; current_stage: string; percentage: number }>("launch-progress", (event) => {
      const { current_step, total_steps, current_stage, percentage } = event.payload;
      setProgress({
        currentStep: current_step,
        totalSteps: total_steps,
        currentStage: current_stage,
        percentage: percentage,
      });
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  const abortLaunchUi = useCallback(
    (logMessage?: string) => {
      const now = Date.now();
      if (logMessage) {
        addPendingOrSelectedLog("warn", logMessage);
      }
      setLaunchEndedAt(now);
      syncLaunchInFlight(false);
      statusHintRef.current =
        instancesRef.current.length > 0 ? null : "stopped";
      if (instancesRef.current.length === 0) {
        setStatus("stopped");
      } else {
        syncStatus(instancesRef.current);
      }
      setProgress(null);
    },
    [addPendingOrSelectedLog, syncLaunchInFlight, syncStatus],
  );

  const cancelLaunch = useCallback(
    async () => {
      const instances = instancesRef.current;
      const inLaunchSession =
        launchInFlightRef.current ||
        status === "preparing" ||
        status === "launching";

      if (
        !inLaunchSession &&
        instances.length === 0 &&
        status !== "running"
      ) {
        return;
      }

      // Direction 1: invalidate the in-flight launchGame async chain.
      launchGenerationRef.current += 1;

      // Direction 2: stop Microsoft token refresh / device-code polling during prep.
      if (inLaunchSession) {
        cancelMicrosoftLogin();
      }

      const targetPid =
        selectedLogPid != null && instances.some((i) => i.pid === selectedLogPid)
          ? selectedLogPid
          : instances.length > 0
            ? instances[instances.length - 1]!.pid
            : null;

      const cancelledMessage = t("launch.provider.launchCancelledByUser");

      if (targetPid != null) {
        try {
          const result = await invoke<string>("kill_game_process", {
            pid: targetPid,
          });
          const now = Date.now();
          const entry: LaunchLogEntry = {
            id: ++logIdRef.current,
            timestamp: new Date(now).toLocaleTimeString(),
            level: "warn",
            message: result,
          };
          pushLogToPid(targetPid, entry);
          if (inLaunchSession) {
            syncLaunchInFlight(false);
            setProgress(null);
          }
        } catch (e) {
          if (inLaunchSession) {
            abortLaunchUi(cancelledMessage);
          } else {
            setErrorMessage(e instanceof Error ? e.message : String(e));
            syncStatus(instancesRef.current);
          }
        }
        return;
      }

      if (inLaunchSession) {
        abortLaunchUi(cancelledMessage);
      }
    },
    [
      status,
      selectedLogPid,
      pushLogToPid,
      syncStatus,
      syncLaunchInFlight,
      cancelMicrosoftLogin,
      abortLaunchUi,
      t,
    ],
  );

  const beginLaunchUi = useCallback(() => {
    launchGenerationRef.current += 1;
    setErrorMessage(null);
    setProgress(null);
    log4jParser.reset();
    const now = Date.now();
    setLaunchStartedAt(now);
    setLaunchEndedAt(null);
    setLastExitCode(null);
    syncLaunchInFlight(true);
    statusHintRef.current = "preparing";
    // 同步写入 React state，点击后立即切换启动中图标
    setStatus("preparing");
  }, [syncLaunchInFlight]);

  const failLaunchUi = useCallback(
    (msg: string) => {
      setLaunchEndedAt(Date.now());
      syncLaunchInFlight(false);
      statusHintRef.current =
        instancesRef.current.length > 0 ? null : "error";
      if (instancesRef.current.length === 0) {
        setStatus("error");
      } else {
        syncStatus(instancesRef.current);
      }
      setErrorMessage(msg);
      setProgress(null);
    },
    [syncStatus, syncLaunchInFlight],
  );

  const launchGame = useCallback(
    async (overrides?: Partial<LaunchConfig>) => {
      const merged = { ...config, ...overrides };

      if (!merged.minecraftPath) {
        setErrorMessage(t("launch.provider.setTheMinecraftGameDirectory"));
        return;
      }
      if (!isAutoJavaSelection(merged.javaPath) && !merged.javaPath) {
        setErrorMessage(t("launch.provider.setAJavaPath"));
        return;
      }
      if (!merged.versionName) {
        setErrorMessage(t("launch.provider.selectAGameVersion"));
        return;
      }
      if (!selectedProfile) {
        setErrorMessage(t("launch.provider.selectAPlayerAccountFirst"));
        return;
      }

      // 校验通过后立刻进入「正在启动」，再做微软刷新 / 内存探测等耗时步骤
      beginLaunchUi();
      const launchGen = launchGenerationRef.current;
      const sessionAborted = () => launchGenerationRef.current !== launchGen;

      addPendingOrSelectedLog("info", t("launch.provider.preparingLaunchArguments"));

      let microsoftAccessToken: string | null = null;
      if (selectedProfile.authType === "microsoft") {
        const prep = await prepareMicrosoftAccountForLaunch(selectedProfile);
        if (sessionAborted()) {
          return;
        }
        if (!prep.ok) {
          const msg =
            prep.reason === "network"
              ? "无法连接微软服务器以刷新登录令牌，请检查网络后重试。"
              : prep.reason === "credentials"
                ? "当前正版账号缺少有效登录令牌，请在账户中重新登录微软账号。"
                : prep.reason === "cancelled"
                  ? "已取消微软登录，游戏未启动。"
                  : "微软账号准备失败，游戏未启动。";
          if (prep.reason === "cancelled" || sessionAborted()) {
            abortLaunchUi(
              sessionAborted()
                ? t("launch.provider.launchCancelledByUser")
                : msg,
            );
          } else {
            failLaunchUi(msg);
            addPendingOrSelectedLog("error", `${t("launch.provider.launchFailed")}: ${msg}`);
          }
          return;
        }
        microsoftAccessToken = prep.accessToken;
      }

      if (sessionAborted()) {
        return;
      }

      try {
        let launchMaxMemory = merged.maxMemory;
        if (merged.autoMemory !== false && isTauriRuntime()) {
          try {
            const mem = await invoke<{ recommended_mb: number }>("get_system_memory");
            if (sessionAborted()) {
              return;
            }
            if (mem.recommended_mb > 0) {
              launchMaxMemory = String(mem.recommended_mb);
              updateConfig({ maxMemory: launchMaxMemory, autoMemory: true });
            }
          } catch {
            /* keep saved maxMemory */
          }
        }

        if (sessionAborted()) {
          return;
        }

        statusHintRef.current = "launching";
        setStatus("launching");
        addPendingOrSelectedLog(
          "info",
          t("launch.provider.launchVersionVersionName", { versionName: merged.versionName }),
        );
        addPendingOrSelectedLog(
          "info",
          t("launch.provider.playerName", { name: selectedProfile.name }),
        );
        addPendingOrSelectedLog(
          "info",
          t("launch.provider.maximumMemoryMaxMemoryMb", { maxMemory: launchMaxMemory }) +
            (merged.autoMemory !== false ? ` (${t("launch.config.autoLabel")})` : ""),
        );

        if (merged.loadType !== "0") {
          addPendingOrSelectedLog(
            "info",
            t("launch.provider.loaderLoadName", { loadName: merged.loadName }),
          );
        }

        const isYggdrasilAccount =
          selectedProfile.authType === "littleskin" ||
          selectedProfile.authType === "third_party";
        const accountAuthToken =
          selectedProfile.authType === "offline"
            ? "0"
            : microsoftAccessToken ?? selectedProfile.accessToken ?? "";
        const accountYggdrasilApi = isYggdrasilAccount
          ? selectedProfile.yggdrasilUrl || merged.yggdrasilApi || ""
          : "";

        const result = await invoke<string>("launch_game", {
          minecraftPath: merged.minecraftPath,
          javaPath: merged.javaPath,
          wrapperPath: merged.wrapperPath,
          maxMemory: launchMaxMemory,
          versionName: merged.versionName,
          minecraftVersion: merged.minecraftVersion,
          playerName: merged.playerName || selectedProfile.name,
          authToken: accountAuthToken,
          uuid: merged.uuid || selectedProfile.uuid || selectedProfile.id,
          authlibInjectorPath: merged.authlibInjectorPath,
          yggdrasilApi: accountYggdrasilApi,
          prefetchedData: accountYggdrasilApi ? merged.prefetchedData : "",
          loadType: merged.loadType,
          loadName: merged.loadName,
          windowWidth: merged.windowWidth || "873",
          windowHeight: merged.windowHeight || "486",
          customJvmArgs: merged.customJvmArgs || "",
          processPriority: merged.processPriority || "medium",
        });

        if (sessionAborted()) {
          try {
            await invoke<string>("kill_game_process", { pid: null });
          } catch {
            /* process may not be registered yet */
          }
          return;
        }

        setLastCommandArgs(result);
        // invoke 成功后立即恢复就绪，可再次启动；进程列表由后续事件维护
        syncLaunchInFlight(false);
        statusHintRef.current = null;
        syncStatus(instancesRef.current);
        addPendingOrSelectedLog("info", t("launch.provider.gameLaunched"));
      } catch (err) {
        if (sessionAborted()) {
          return;
        }
        const raw = err instanceof Error ? err.message : String(err);
        const msg = raw.includes("模组正在更新")
          ? t("launch.provider.modUpdateInProgress")
          : raw;
        failLaunchUi(msg);
        addPendingOrSelectedLog("error", `${t("launch.provider.launchFailed")}: ${msg}`);
      }
    },
    [
      config,
      selectedProfile,
      addPendingOrSelectedLog,
      t,
      updateConfig,
      beginLaunchUi,
      failLaunchUi,
      syncStatus,
      prepareMicrosoftAccountForLaunch,
      abortLaunchUi,
    ],
  );

  const generateReport = useCallback<() => LaunchAnalysisReport>(
    () => {
      const finalStatus: LaunchAnalysisReport["finalStatus"] =
        status === "running"
          ? "running"
          : status === "stopped"
            ? "stopped"
            : status === "error"
              ? "error"
              : status === "launching" || status === "preparing"
                ? "in_progress"
                : "idle";
      const report = analyzeLaunchLogs(logs, {
        language,
        startedAt: launchStartedAt,
        endedAt: launchEndedAt,
        exitCode: lastExitCode,
        finalStatus,
        accountType: selectedProfile?.authType,
      });
      return {
        ...report,
        launchParameters: lastCommandArgs ?? undefined,
      };
    },
    [logs, language, launchStartedAt, launchEndedAt, lastExitCode, status, selectedProfile, lastCommandArgs],
  );

  const exportLaunchReport = useCallback(async () => {
    try {
      const report = generateReport();
      const reportJson = JSON.stringify(report, null, 2);
      const consoleLogs = logs
        .map((l) => `[${l.timestamp}] [${l.level.toUpperCase()}] ${l.message}`)
        .join("\n");
      return await invoke<string>("export_launch_report", {
        minecraftPath: config.minecraftPath,
        versionName: config.versionName,
        launchParameters: lastCommandArgs ?? "",
        accountType: selectedProfile?.authType ?? "offline",
        reportJson,
        consoleLogs,
      });
    } catch (err) {
      console.error("导出启动报告失败:", err);
      throw err;
    }
  }, [config, lastCommandArgs, selectedProfile, generateReport, logs]);

  return (
    <LaunchContext.Provider
      value={{
        config,
        updateConfig,
        status,
        logs,
        logsByPid,
        selectedLogPid,
        setSelectedLogPid,
        runningInstances,
        errorMessage,
        launchGame,
        cancelLaunch,
        clearLogs,
        lastCommandArgs,
        lastLaunchTime,
        configLoaded,
        progress,
        launchStartedAt,
        launchEndedAt,
        lastExitCode,
        generateReport,
        exportLaunchReport,
      }}
    >
      {children}
    </LaunchContext.Provider>
  );
}
