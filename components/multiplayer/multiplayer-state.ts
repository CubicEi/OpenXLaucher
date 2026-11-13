import type { DecodedInvite } from "@/components/multiplayer/multiplayer-invite";
import {
  clearPersistedMultiplayerSession,
  loadPersistedMultiplayerSession,
  persistMultiplayerSession,
  restoreDecodedInvite,
} from "@/components/multiplayer/multiplayer-session-storage";

export type MultiplayerStatus =
  | "idle"
  | "not_installed"
  | "installing"
  | "installed"
  | "starting"
  | "running"
  | "stopping"
  | "error";

export type RunMode = "host" | "join";

export type DownloadProgress = {
  downloaded: number;
  total: number;
};

export type MultiplayerState = {
  status: MultiplayerStatus;
  errorMsg: string | null;
  privilegeRequired: boolean;
  runMode: RunMode | null;
  roomInfo: string | null;
  decodedInvite: DecodedInvite | null;
  logText: string;
  downloadProgress: DownloadProgress | null;
  toolVersion: string | null;
  toolPath: string | null;
  toolDirectory: string | null;
};

export const initialMultiplayerState: MultiplayerState = {
  status: "idle",
  errorMsg: null,
  privilegeRequired: false,
  runMode: null,
  roomInfo: null,
  decodedInvite: null,
  logText: "",
  downloadProgress: null,
  toolVersion: null,
  toolPath: null,
  toolDirectory: null,
};

export type MultiplayerAction =
  | {
      type: "statusResolved";
      installed: boolean;
      running: boolean;
      version?: string | null;
      path?: string | null;
      directory?: string | null;
      runMode?: RunMode | null;
      roomInfo?: string | null;
      decodedInvite?: DecodedInvite | null;
    }
  | { type: "installStarted" }
  | { type: "installCancelled" }
  | { type: "downloadProgress"; downloaded: number; total: number }
  | { type: "operationStarted"; operation: "start" | "stop" }
  | {
      type: "started";
      mode: RunMode;
      roomInfo: string;
      decodedInvite: DecodedInvite | null;
    }
  | { type: "stopped" }
  | { type: "failed"; message: string; privilegeRequired?: boolean }
  | { type: "logReceived"; text: string }
  | { type: "logCleared" }
  | { type: "privilegeCleared" };

export function multiplayerReducer(
  state: MultiplayerState,
  action: MultiplayerAction
): MultiplayerState {
  switch (action.type) {
    case "statusResolved": {
      const toolMeta = {
        toolVersion: action.version ?? state.toolVersion,
        toolPath: action.path ?? state.toolPath,
        toolDirectory: action.directory ?? state.toolDirectory,
      };

      if (!action.installed) {
        clearPersistedMultiplayerSession();
        // Keep in-flight manual install UI while the download task runs.
        if (state.status === "installing") {
          return {
            ...state,
            ...toolMeta,
            privilegeRequired: false,
            runMode: null,
            roomInfo: null,
            decodedInvite: null,
          };
        }
        return {
          ...state,
          ...toolMeta,
          status: "not_installed",
          errorMsg: null,
          privilegeRequired: false,
          runMode: null,
          roomInfo: null,
          decodedInvite: null,
          downloadProgress: null,
        };
      }

      if (action.running) {
        const persisted = loadPersistedMultiplayerSession();
        const runMode =
          action.runMode ?? state.runMode ?? persisted?.mode ?? null;
        const roomInfo =
          action.roomInfo ?? state.roomInfo ?? persisted?.roomInfo ?? null;
        const decodedInvite =
          action.decodedInvite !== undefined
            ? action.decodedInvite
            : state.decodedInvite ?? restoreDecodedInvite(roomInfo);
        if (runMode && roomInfo) {
          persistMultiplayerSession({ mode: runMode, roomInfo });
        }
        return {
          ...state,
          ...toolMeta,
          status: "running",
          errorMsg: null,
          privilegeRequired: false,
          downloadProgress: null,
          runMode,
          roomInfo,
          decodedInvite,
        };
      }

      // Keep in-flight start/stop UI; do not treat a transient false as a stop.
      if (state.status === "starting" || state.status === "stopping") {
        return {
          ...state,
          ...toolMeta,
          errorMsg: null,
          privilegeRequired: false,
          downloadProgress: null,
        };
      }

      clearPersistedMultiplayerSession();
      return {
        ...state,
        ...toolMeta,
        status: "installed",
        errorMsg: null,
        privilegeRequired: false,
        runMode: null,
        roomInfo: null,
        decodedInvite: null,
        downloadProgress: null,
      };
    }
    case "installStarted":
      return {
        ...state,
        status: "installing",
        errorMsg: null,
        privilegeRequired: false,
        downloadProgress: null,
      };
    case "installCancelled":
      return {
        ...state,
        status: "not_installed",
        errorMsg: null,
        privilegeRequired: false,
        downloadProgress: null,
      };
    case "downloadProgress":
      return {
        ...state,
        downloadProgress: {
          downloaded: action.downloaded,
          total: action.total,
        },
      };
    case "operationStarted":
      return {
        ...state,
        status: action.operation === "start" ? "starting" : "stopping",
        errorMsg: null,
        privilegeRequired: false,
        ...(action.operation === "start" ? { logText: "" } : {}),
      };
    case "started":
      persistMultiplayerSession({ mode: action.mode, roomInfo: action.roomInfo });
      return {
        ...state,
        status: "running",
        errorMsg: null,
        privilegeRequired: false,
        runMode: action.mode,
        roomInfo: action.roomInfo,
        decodedInvite: action.decodedInvite,
      };
    case "stopped":
      clearPersistedMultiplayerSession();
      return {
        ...state,
        status: "installed",
        errorMsg: null,
        privilegeRequired: false,
        runMode: null,
        roomInfo: null,
        decodedInvite: null,
      };
    case "failed":
      return {
        ...state,
        status: state.status === "installing" ? "not_installed" : "error",
        errorMsg: action.message,
        privilegeRequired: Boolean(action.privilegeRequired),
        downloadProgress: null,
      };
    case "logReceived":
      if (!action.text) return state;
      return {
        ...state,
        logText:
          state.logText && !state.logText.endsWith("\n")
            ? `${state.logText}\n${action.text}`
            : state.logText + action.text,
      };
    case "logCleared":
      return { ...state, logText: "" };
    case "privilegeCleared":
      return { ...state, privilegeRequired: false };
  }
}
