"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  tauriMultiplayerApi,
  type MultiplayerApi,
  type MultiplayerPaths,
  type MultiplayerToolStatus,
} from "@/components/multiplayer/multiplayer-api";
import { decodeInvite } from "@/components/multiplayer/multiplayer-invite";
import {
  initialMultiplayerState,
  multiplayerReducer,
  type MultiplayerState,
} from "@/components/multiplayer/multiplayer-state";

type MultiplayerContextValue = MultiplayerState & {
  checkStatus: () => Promise<void>;
  ensureInstalled: () => Promise<void>;
  startAsHost: (roomName: string, port: string) => Promise<string>;
  startAsJoin: (encodedInvite: string, playerName: string) => Promise<string>;
  stopSession: () => Promise<void>;
  preparePrivileges: () => Promise<void>;
  isRunning: () => Promise<boolean>;
  pollLog: () => Promise<string>;
  clearLog: () => void;
  getPaths: () => Promise<MultiplayerPaths>;
  uninstallTool: () => Promise<void>;
};

const MultiplayerContext = createContext<MultiplayerContextValue | null>(null);

export function useMultiplayerContext() {
  const context = useContext(MultiplayerContext);
  if (!context) {
    throw new Error("useMultiplayerContext must be used within MultiplayerProvider");
  }
  return context;
}

function errorMessage(error: unknown, fallback: string) {
  if (typeof error === "string") return error;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function isPrivilegeError(error: unknown) {
  const message = errorMessage(error, "").toLowerCase();
  return /privileg|admin|uac|tun|firewall|权限|管理员|防火墙|提权/.test(message);
}

function normalizeDownloadProgress(payload: unknown): {
  downloaded: number;
  total: number;
} | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const downloadedRaw =
    record.downloaded ?? record.downloadedBytes ?? record.current ?? record.bytesDownloaded;
  const totalRaw =
    record.total ?? record.totalBytes ?? record.size ?? record.bytesTotal;
  const downloaded = typeof downloadedRaw === "number" ? downloadedRaw : Number(downloadedRaw);
  const total = typeof totalRaw === "number" ? totalRaw : Number(totalRaw);
  if (!Number.isFinite(downloaded) || !Number.isFinite(total)) return null;
  return { downloaded, total };
}

type MultiplayerProviderProps = {
  children: ReactNode;
  api?: MultiplayerApi;
};

export function MultiplayerProvider({
  children,
  api = tauriMultiplayerApi,
}: MultiplayerProviderProps) {
  const [state, dispatch] = useReducer(multiplayerReducer, initialMultiplayerState);
  const logRequestRef = useRef<Promise<string> | null>(null);
  const ensurePromiseRef = useRef<Promise<void> | null>(null);
  const pollLogRef = useRef<() => Promise<string>>(async () => "");

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;

    void listen("mp-download-progress", (event) => {
      const progress = normalizeDownloadProgress(event.payload);
      if (!progress) return;
      dispatch({
        type: "downloadProgress",
        downloaded: progress.downloaded,
        total: progress.total,
      });
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // Browser / non-Tauri builds ignore progress events.
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const checkStatus = useCallback(async () => {
    try {
      const snapshot: MultiplayerToolStatus = await api.getToolStatus();
      const roomInfo = snapshot.roomInfo ?? null;
      dispatch({
        type: "statusResolved",
        installed: Boolean(snapshot.installed),
        running: Boolean(snapshot.running),
        version: snapshot.version ?? null,
        path: snapshot.path ?? null,
        directory: snapshot.directory ?? null,
        runMode: snapshot.runMode ?? null,
        roomInfo,
        decodedInvite: roomInfo ? decodeInvite(roomInfo) : null,
      });
      // Re-sync buffered logs when a background session is still alive.
      if (snapshot.running) {
        void pollLogRef.current();
      }
    } catch (error) {
      dispatch({
        type: "failed",
        message: errorMessage(error, "状态检查失败"),
        privilegeRequired: isPrivilegeError(error),
      });
    }
  }, [api]);

  // Provider lives in root layout: never stop EasyTier here on unmount.
  // Bootstrap so remounted pages / exit guard see accurate running state.
  useEffect(() => {
    void checkStatus();
  }, [checkStatus]);

  const ensureInstalled = useCallback(async () => {
    if (ensurePromiseRef.current) return ensurePromiseRef.current;

    dispatch({ type: "installStarted" });
    const request = api
      .ensureInstalled()
      .then(async () => {
        await checkStatus();
      })
      .catch((error) => {
        dispatch({
          type: "failed",
          message: errorMessage(error, "联机工具安装失败"),
          privilegeRequired: isPrivilegeError(error),
        });
        throw error;
      })
      .finally(() => {
        if (ensurePromiseRef.current === request) ensurePromiseRef.current = null;
      });

    ensurePromiseRef.current = request;
    return request;
  }, [api, checkStatus]);

  const startAsHost = useCallback(
    async (roomName: string, port: string) => {
      dispatch({ type: "operationStarted", operation: "start" });
      try {
        const invite = await api.startHost({ roomName, port });
        dispatch({
          type: "started",
          mode: "host",
          roomInfo: invite,
          decodedInvite: decodeInvite(invite),
        });
        return invite;
      } catch (error) {
        dispatch({
          type: "failed",
          message: errorMessage(error, "启动失败"),
          privilegeRequired: isPrivilegeError(error),
        });
        throw error;
      }
    },
    [api]
  );

  const startAsJoin = useCallback(
    async (encodedInvite: string, playerName: string) => {
      dispatch({ type: "operationStarted", operation: "start" });
      try {
        await api.startJoin({ encodedInvite, playerName });
        dispatch({
          type: "started",
          mode: "join",
          roomInfo: encodedInvite,
          decodedInvite: decodeInvite(encodedInvite),
        });
        return encodedInvite;
      } catch (error) {
        dispatch({
          type: "failed",
          message: errorMessage(error, "加入失败"),
          privilegeRequired: isPrivilegeError(error),
        });
        throw error;
      }
    },
    [api]
  );

  const stopSession = useCallback(async () => {
    dispatch({ type: "operationStarted", operation: "stop" });
    try {
      await api.stopSession();
      dispatch({ type: "stopped" });
    } catch (error) {
      dispatch({
        type: "failed",
        message: errorMessage(error, "停止失败"),
        privilegeRequired: isPrivilegeError(error),
      });
    }
  }, [api]);

  const preparePrivileges = useCallback(async () => {
    try {
      const result = await api.preparePrivileges();
      if (result.ok === false) {
        const detail = [result.message, ...(result.manualSteps ?? [])]
          .filter(Boolean)
          .join("\n");
        throw new Error(detail || "权限准备未完成");
      }
      dispatch({ type: "privilegeCleared" });
      await checkStatus();
    } catch (error) {
      dispatch({
        type: "failed",
        message: errorMessage(error, "权限准备失败"),
        privilegeRequired: true,
      });
      throw error;
    }
  }, [api, checkStatus]);

  const isRunning = useCallback(async () => {
    try {
      return await api.isRunning();
    } catch (error) {
      console.error("检查联机会话运行状态失败:", error);
      return false;
    }
  }, [api]);

  const pollLog = useCallback(() => {
    if (logRequestRef.current) return logRequestRef.current;

    const request = api
      .pollLog()
      .then((text) => {
        dispatch({ type: "logReceived", text });
        return text;
      })
      .catch((error) => {
        console.error("轮询联机日志失败:", error);
        return "";
      })
      .finally(() => {
        if (logRequestRef.current === request) logRequestRef.current = null;
      });
    logRequestRef.current = request;
    return request;
  }, [api]);

  pollLogRef.current = pollLog;

  const clearLog = useCallback(() => dispatch({ type: "logCleared" }), []);

  const getPaths = useCallback(async () => {
    try {
      return await api.getPaths();
    } catch (error) {
      console.error("获取联机工具路径失败:", error);
      return { directory: "", executable: "" };
    }
  }, [api]);

  const uninstallTool = useCallback(async () => {
    await api.uninstallTool();
    await checkStatus();
  }, [api, checkStatus]);

  const value = useMemo<MultiplayerContextValue>(
    () => ({
      ...state,
      checkStatus,
      ensureInstalled,
      startAsHost,
      startAsJoin,
      stopSession,
      preparePrivileges,
      isRunning,
      pollLog,
      clearLog,
      getPaths,
      uninstallTool,
    }),
    [
      state,
      checkStatus,
      ensureInstalled,
      startAsHost,
      startAsJoin,
      stopSession,
      preparePrivileges,
      isRunning,
      pollLog,
      clearLog,
      getPaths,
      uninstallTool,
    ]
  );

  return <MultiplayerContext.Provider value={value}>{children}</MultiplayerContext.Provider>;
}
