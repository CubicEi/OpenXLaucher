import { decodeInvite, type DecodedInvite } from "@/components/multiplayer/multiplayer-invite";
import type { RunMode } from "@/components/multiplayer/multiplayer-state";

const SESSION_STORAGE_KEY = "openxlauncher:multiplayer:activeSession";

export type PersistedMultiplayerSession = {
  mode: RunMode;
  roomInfo: string;
};

export function loadPersistedMultiplayerSession(): PersistedMultiplayerSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedMultiplayerSession>;
    if (parsed.mode !== "host" && parsed.mode !== "join") return null;
    if (typeof parsed.roomInfo !== "string" || !parsed.roomInfo.trim()) return null;
    return { mode: parsed.mode, roomInfo: parsed.roomInfo.trim() };
  } catch {
    return null;
  }
}

export function persistMultiplayerSession(session: PersistedMultiplayerSession) {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // ignore quota / private-mode failures
  }
}

export function clearPersistedMultiplayerSession() {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function restoreDecodedInvite(roomInfo: string | null): DecodedInvite | null {
  if (!roomInfo) return null;
  return decodeInvite(roomInfo);
}
