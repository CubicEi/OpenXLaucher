/** 组合安装默认实例文件夹名（与 CombinedInstall 逻辑一致） */
export function buildDefaultInstanceName(
  mcVersion: string,
  selections: { loader: string; version: string }[],
  options?: { fabricApiVersionLabel?: string; includeFabricApi?: boolean }
): string {
  const includeFabricApi = options?.includeFabricApi ?? false;
  const parts = [mcVersion];
  for (const s of selections) {
    if (s.loader === "vanilla" || s.loader === "fabric_api") continue;
    parts.push(s.version ? `${s.loader}-${s.version}` : s.loader);
  }
  if (includeFabricApi) {
    const label = options?.fabricApiVersionLabel?.trim();
    parts.push(label ? `API-${label}` : "API");
  }
  return parts.join("-").replace(/[\\/:*?"<>|]/g, "_");
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
