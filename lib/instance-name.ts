import { LOADER_OPTIONS } from "@/constants/data";

const LOADER_DISPLAY_NAME: Record<string, string> = Object.fromEntries(
  LOADER_OPTIONS.map((o) => [o.id, o.name]),
);

/** 加载器 ID → 展示名（如 fabric → Fabric，neoforge → NeoForge） */
export function loaderDisplayName(loaderId: string): string {
  const known = LOADER_DISPLAY_NAME[loaderId];
  if (known) return known;
  const trimmed = loaderId.trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

/** 单段：`Fabric 0.20.1` */
export function formatLoaderInstanceSegment(loaderId: string, version: string): string {
  const name = loaderDisplayName(loaderId);
  const ver = version.trim();
  return ver ? `${name} ${ver}` : name;
}

function sanitizeInstanceFolderName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_");
}

/** 默认实例名：`{MC}-{Loader} {ver}`，多加载器用 `-` 连接各段，如 `26.3-Fabric 0.20.1` */
export function buildDefaultInstanceName(
  mcVersion: string,
  selections: { loader: string; version: string }[],
): string {
  const segments: string[] = [];
  for (const s of selections) {
    if (s.loader === "vanilla" || s.loader === "fabric_api") continue;
    segments.push(formatLoaderInstanceSegment(s.loader, s.version));
  }
  if (segments.length === 0) return sanitizeInstanceFolderName(mcVersion);
  return sanitizeInstanceFolderName(`${mcVersion}-${segments.join("-")}`);
}

export function buildSingleLoaderInstanceName(
  mcVersion: string,
  loaderId: string,
  loaderVersion: string,
): string {
  return buildDefaultInstanceName(mcVersion, [{ loader: loaderId, version: loaderVersion }]);
}

/** 从版本号或文件夹名中提取可比较的 MC 版本（如 1.20.1 / 26.3） */
export function extractMcVersion(versionOrFolder: string): string {
  const match = versionOrFolder.trim().match(/(\d+(?:\.\d+)+)/);
  return match ? match[1] : versionOrFolder.trim();
}

function parseMcVersionParts(version: string): number[] | null {
  const extracted = extractMcVersion(version);
  const match = extracted.match(/^(\d+(?:\.\d+)+)/);
  return match ? match[1].split(".").map(Number) : null;
}

/** 正数表示 a 高于 b */
export function compareMcVersions(a: string, b: string): number {
  const aParts = parseMcVersionParts(a);
  const bParts = parseMcVersionParts(b);
  if (!aParts || !bParts) return 0;
  const length = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function isMcDowngrade(fromMc: string, toMc: string): boolean {
  return compareMcVersions(toMc, fromMc) < 0;
}

export type LoaderFamily =
  | "vanilla"
  | "fabric"
  | "quilt"
  | "forge"
  | "neoforge"
  | "optifine"
  | "liteloader"
  | "unknown";

export function normalizeLoaderFamily(hint: string): LoaderFamily {
  const lower = hint.trim().toLowerCase();
  if (!lower || lower === "vanilla" || lower === "0") return "vanilla";
  if (lower === "neoforge" || lower.includes("neoforge")) return "neoforge";
  if (lower === "liteloader" || lower.includes("liteloader")) return "liteloader";
  if (lower === "optifine" || lower.includes("optifine")) return "optifine";
  if (lower === "fabric" || lower.includes("fabric")) return "fabric";
  if (lower === "quilt" || lower.includes("quilt")) return "quilt";
  if (lower === "forge" || lower.includes("forge")) return "forge";
  return "vanilla";
}

export function inferLoaderFamilyFromFolder(folderOrHint: string): LoaderFamily {
  return normalizeLoaderFamily(folderOrHint);
}

export function loaderFamilyFromSelections(
  selections: { loader: string; version: string }[]
): LoaderFamily {
  const primary = selections.find(
    (s) =>
      s.loader !== "fabric_api" &&
      s.loader !== "vanilla" &&
      ["forge", "neoforge", "fabric", "quilt", "liteloader", "optifine"].includes(
        s.loader
      )
  );
  if (!primary) return "vanilla";
  return inferLoaderFamilyFromFolder(primary.loader);
}

export function isLoaderFamilyChange(
  currentFamily: LoaderFamily,
  selections: { loader: string; version: string }[]
): boolean {
  const next = loaderFamilyFromSelections(selections);
  if (currentFamily === "unknown") return false;
  return currentFamily !== next;
}

export function resolveInstanceFolderName(
  rawInput: string,
  defaultName: string,
): string {
  const trimmed = rawInput.trim();
  return trimmed.length > 0 ? trimmed : defaultName;
}

/** 版本文件夹名以小数点结尾（Windows 等系统可能无法正确创建） */
export function instanceNameEndsWithDot(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.endsWith(".");
}

export function instanceNameConflictsExisting(
  name: string,
  existingFolderNames: readonly string[],
  excludeFolderName?: string,
): boolean {
  const target = name.trim().toLowerCase();
  if (!target) return false;
  const exclude = excludeFolderName?.trim().toLowerCase();
  if (exclude && target === exclude) return false;
  return existingFolderNames.some(
    (folder) => folder.trim().toLowerCase() === target,
  );
}

export type InstanceFolderNameWarning = "trailingDot" | "duplicate";

export function getInstanceFolderNameWarnings(
  rawInput: string,
  defaultName: string,
  existingFolderNames: readonly string[],
  excludeFolderName?: string,
): InstanceFolderNameWarning[] {
  const resolved = resolveInstanceFolderName(rawInput, defaultName);
  const warnings: InstanceFolderNameWarning[] = [];
  if (instanceNameEndsWithDot(resolved)) {
    warnings.push("trailingDot");
  }
  if (instanceNameConflictsExisting(resolved, existingFolderNames, excludeFolderName)) {
    warnings.push("duplicate");
  }
  return warnings;
}

/** 目标文件夹已存在且不是当前源实例时阻止安装 */
export async function assertTargetInstanceFolderAvailable(
  instancesPath: string,
  targetName: string,
  sourceFolderName: string
): Promise<void> {
  if (targetName === sourceFolderName) return;
  const { invoke } = await import("@tauri-apps/api/core");
  const instances = await invoke<{ name: string }[]>("vm_scan_instances", {
    instancesPath,
  });
  if (instances.some((i) => i.name === targetName)) {
    throw new Error(`目标版本目录已存在: ${targetName}`);
  }
}
