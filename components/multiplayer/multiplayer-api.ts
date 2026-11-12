import { invoke } from "@tauri-apps/api/core";

export type MultiplayerToolStatus = {
  installed: boolean;
  version?: string | null;
  path?: string | null;
  directory?: string | null;
  running?: boolean;
  peer?: string | null;
  runMode?: "host" | "join" | null;
  roomInfo?: string | null;
};

export type MultiplayerPaths = {
  directory: string;
  executable: string;
  peer?: string;
  defaultPeer?: string;
  hostVip?: string;
};

type StartHostResult = {
  invite: string;
  networkName?: string;
  hostIpv4?: string;
  port?: number;
  peer?: string;
  path?: string;
};

type StartJoinResult = {
  path?: string;
  networkName?: string;
  hostIpv4?: string;
  port?: number;
  connectHint?: string;
  peer?: string;
};

type EncodeRoomResult = {
  invite: string;
  networkName?: string;
  hostIpv4?: string;
  port?: number;
  peer?: string;
};

type RawPaths = {
  directory?: string;
  executable?: string;
  bridgeDir?: string;
  toolPath?: string;
  toolName?: string;
  peer?: string;
  defaultPeer?: string;
  hostVip?: string;
};

type RawToolStatus = {
  installed?: boolean;
  version?: string | null;
  path?: string | null;
  directory?: string | null;
  bridgeDir?: string | null;
  running?: boolean;
  peer?: string | null;
  runMode?: string | null;
  roomInfo?: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function readString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function normalizeRunMode(value: unknown): "host" | "join" | null {
  if (value === "host" || value === "join") return value;
  return null;
}

function normalizeToolStatus(raw: unknown): MultiplayerToolStatus {
  const obj = asRecord(raw) as RawToolStatus | null;
  return {
    installed: Boolean(obj?.installed),
    version: obj?.version ?? null,
    path: readString(obj?.path) ?? null,
    directory: readString(obj?.directory, obj?.bridgeDir) ?? null,
    running: Boolean(obj?.running),
    peer: readString(obj?.peer) ?? null,
    runMode: normalizeRunMode(obj?.runMode),
    roomInfo: readString(obj?.roomInfo) ?? null,
  };
}

function normalizePaths(raw: unknown): MultiplayerPaths {
  const obj = asRecord(raw) as RawPaths | null;
  return {
    directory: readString(obj?.directory, obj?.bridgeDir) ?? "",
    executable: readString(obj?.executable, obj?.toolPath) ?? "",
    peer: readString(obj?.peer),
    defaultPeer: readString(obj?.defaultPeer),
    hostVip: readString(obj?.hostVip),
  };
}

function extractInvite(raw: unknown): string {
  if (typeof raw === "string") return raw;
  const obj = asRecord(raw);
  const invite = readString(obj?.invite);
  if (!invite) {
    throw new Error("联机邀请码返回格式无效");
  }
  return invite;
}

export type PrivilegePrepareResult = {
  ok: boolean;
  platform?: string;
  firewallOk?: boolean | null;
  tunOk?: boolean | null;
  needsAdmin?: boolean;
  message: string;
  manualSteps?: string[];
};

export type MultiplayerApi = {
  ensureInstalled: () => Promise<void>;
  getToolStatus: () => Promise<MultiplayerToolStatus>;
  startHost: (params: { roomName: string; port: string }) => Promise<string>;
  startJoin: (params: {
    encodedInvite: string;
    playerName: string;
  }) => Promise<string>;
  stopSession: () => Promise<void>;
  isRunning: () => Promise<boolean>;
  pollLog: () => Promise<string>;
  getPaths: () => Promise<MultiplayerPaths>;
  uninstallTool: () => Promise<void>;
  preparePrivileges: () => Promise<PrivilegePrepareResult>;
  encodeRoomInfo?: (roomName: string, port: string) => Promise<string>;
  setPeer?: (peer: string) => Promise<string>;
};

export const tauriMultiplayerApi: MultiplayerApi = {
  async ensureInstalled() {
    await invoke("mp_ensure_installed");
  },
  async getToolStatus() {
    const raw = await invoke<unknown>("mp_get_tool_status");
    return normalizeToolStatus(raw);
  },
  async startHost({ roomName, port }) {
    const raw = await invoke<StartHostResult | string>("mp_start_host", {
      roomName,
      port,
    });
    return extractInvite(raw);
  },
  async startJoin({ encodedInvite, playerName }) {
    await invoke<StartJoinResult>("mp_start_join", {
      encodedInvite,
      playerName,
    });
    return encodedInvite;
  },
  stopSession() {
    return invoke<void>("mp_stop_session");
  },
  isRunning() {
    return invoke<boolean>("mp_is_running");
  },
  pollLog() {
    return invoke<string>("mp_poll_log");
  },
  async getPaths() {
    const raw = await invoke<unknown>("mp_get_paths");
    return normalizePaths(raw);
  },
  uninstallTool() {
    return invoke<void>("mp_uninstall_tool");
  },
  preparePrivileges() {
    return invoke<PrivilegePrepareResult>("mp_prepare_privileges");
  },
  async encodeRoomInfo(roomName, port) {
    const raw = await invoke<EncodeRoomResult | string>("mp_encode_room_info", {
      roomName,
      port,
    });
    return extractInvite(raw);
  },
  setPeer(peer) {
    return invoke<string>("mp_set_peer", { peer });
  },
};
