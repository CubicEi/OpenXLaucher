/** Per-instance launch profile override (localStorage). Missing/null = use global selected profile. */

import type { Account, LaunchConfig } from "@/types";

export const VERSION_PROFILE_STORAGE_KEY = "openx-version-profiles";
/** Sentinel used by UI selects for “use global setting”. */
export const VERSION_PROFILE_GLOBAL = "__global__";

export function effectiveVersionFolder(
  cfg: Pick<LaunchConfig, "loadType" | "loadName" | "versionName">,
): string {
  return cfg.loadType !== "0" && cfg.loadName ? cfg.loadName : cfg.versionName;
}

/** Resolve the profile that will actually launch for the current version. */
export function resolveLaunchProfile(
  profiles: Account[],
  selectedProfile: Account | null,
  minecraftPath: string,
  versionFolder: string,
): Account | null {
  const overrideId = getVersionProfileOverride(minecraftPath, versionFolder);
  if (!overrideId) return selectedProfile;
  return profiles.find((p) => p.id === overrideId) ?? selectedProfile;
}

export function resolveLaunchProfileForConfig(
  profiles: Account[],
  selectedProfile: Account | null,
  config: Pick<LaunchConfig, "minecraftPath" | "loadType" | "loadName" | "versionName">,
): Account | null {
  return resolveLaunchProfile(
    profiles,
    selectedProfile,
    config.minecraftPath,
    effectiveVersionFolder(config),
  );
}

function normalizeMinecraftPath(minecraftPath: string): string {
  return minecraftPath
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

export function makeVersionProfileKey(
  minecraftPath: string,
  versionFolder: string,
): string {
  return `${normalizeMinecraftPath(minecraftPath)}::${versionFolder.trim()}`;
}

function readMap(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(VERSION_PROFILE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) out[k] = v.trim();
    }
    return out;
  } catch {
    return {};
  }
}

function writeMap(map: Record<string, string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(VERSION_PROFILE_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* ignore quota / private mode */
  }
}

/** Returns overridden account id, or null to use the global selection. */
export function getVersionProfileOverride(
  minecraftPath: string,
  versionFolder: string,
): string | null {
  if (!minecraftPath.trim() || !versionFolder.trim()) return null;
  const id = readMap()[makeVersionProfileKey(minecraftPath, versionFolder)];
  if (!id || id === VERSION_PROFILE_GLOBAL) return null;
  return id;
}

/** Pass null / empty / VERSION_PROFILE_GLOBAL to clear and use global. */
export function setVersionProfileOverride(
  minecraftPath: string,
  versionFolder: string,
  accountId: string | null,
): void {
  if (!minecraftPath.trim() || !versionFolder.trim()) return;
  const key = makeVersionProfileKey(minecraftPath, versionFolder);
  const map = readMap();
  const next =
    !accountId || accountId === VERSION_PROFILE_GLOBAL ? null : accountId.trim();
  if (!next) {
    if (!(key in map)) return;
    delete map[key];
  } else {
    map[key] = next;
  }
  writeMap(map);
}

export function renameVersionProfileOverride(
  minecraftPath: string,
  oldFolder: string,
  newFolder: string,
): void {
  if (!minecraftPath.trim() || !oldFolder.trim() || !newFolder.trim()) return;
  if (oldFolder.trim() === newFolder.trim()) return;
  const map = readMap();
  const oldKey = makeVersionProfileKey(minecraftPath, oldFolder);
  const newKey = makeVersionProfileKey(minecraftPath, newFolder);
  if (!(oldKey in map)) return;
  map[newKey] = map[oldKey];
  delete map[oldKey];
  writeMap(map);
}

export function clearVersionProfileOverride(
  minecraftPath: string,
  versionFolder: string,
): void {
  setVersionProfileOverride(minecraftPath, versionFolder, null);
}

export function resolveLaunchProfileId(
  minecraftPath: string,
  versionFolder: string,
  globalProfileId: string | null | undefined,
): string | null {
  return (
    getVersionProfileOverride(minecraftPath, versionFolder) ??
    globalProfileId ??
    null
  );
}
