import type { InstanceData } from "@/types";

/** 解析后的版本信息（开箱向导 / 版本选择器共用） */
export interface ParsedVersion {
  name: string;
  mcVersion: string;
  majorVersion: string;
  loaderType: string;
  loaderVersion: string;
}

export function extractMinecraftVersion(name: string): string {
  const snapshotRe = /^\d{2}w\d{2}[a-z]$/;
  if (snapshotRe.test(name)) {
    return name;
  }

  const standardRe = /^(\d+\.\d+(?:\.\d+)?)/;
  const match = name.match(standardRe);
  if (match) {
    return match[1];
  }

  const candidates = name.match(/\d+\.\d+(?:\.\d+)?/g) ?? [];
  const legacyRelease = candidates.find((candidate) => candidate.startsWith("1."));
  if (legacyRelease) {
    return legacyRelease;
  }
  const calendarRelease = [...candidates].reverse().find((candidate) => {
    const major = Number.parseInt(candidate.split(".")[0], 10);
    return major >= 20;
  });
  if (calendarRelease) {
    return calendarRelease;
  }

  const snapshotVerRe = /^(\d+\.\d+)-snapshot/;
  const snapshotMatch = name.match(snapshotVerRe);
  if (snapshotMatch) {
    return snapshotMatch[1];
  }

  const singleVerRe = /^(\d+)(?:[-_.]|$)/;
  const singleMatch = name.match(singleVerRe);
  if (singleMatch) {
    const ver = singleMatch[1];
    const num = parseInt(ver, 10);
    if (num >= 20) {
      return ver;
    }
  }

  return name;
}

/** 从目录名解析版本信息 */
export function parseVersionDir(dirName: string): ParsedVersion {
  const lower = dirName.toLowerCase();

  let loaderType: string = "vanilla";
  let loaderVersion = "";
  let mcVersion = dirName;
  let majorVersion = dirName;

  if (lower.includes("neoforge")) {
    loaderType = "neoforge";
  } else if (lower.includes("liteloader")) {
    loaderType = "liteloader";
  } else if (lower.includes("optifine")) {
    loaderType = "optifine";
  } else if (lower.includes("fabric")) {
    loaderType = "fabric";
  } else if (lower.includes("forge")) {
    loaderType = "forge";
  } else if (lower.includes("quilt")) {
    loaderType = "quilt";
  }

  mcVersion = extractMinecraftVersion(dirName);

  const versionParts = mcVersion.split(".");
  if (versionParts.length >= 2) {
    majorVersion = `${versionParts[0]}.${versionParts[1]}`;
  } else if (versionParts.length === 1) {
    majorVersion = versionParts[0];
  }

  if (loaderType !== "vanilla") {
    const parts = dirName.split("-");
    const loaderTokens = ["neoforge", "liteloader", "optifine", "fabric", "forge", "quilt"];
    let loaderIndex = -1;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i].toLowerCase();
      if (loaderTokens.some((tok) => p.includes(tok))) {
        loaderIndex = i;
        break;
      }
    }
    if (loaderIndex !== -1) {
      const segs = parts.filter((p, idx) => {
        const isMcVersion =
          /^\d+\.\d+(?:\.\d+)?$/.test(p) ||
          /^\d{2}w\d{2}[a-z]$/.test(p) ||
          /^\d+(\.\d+)?$/.test(p);
        return idx !== loaderIndex && !isMcVersion;
      });
      if (segs.length > 0) loaderVersion = segs.join("-");
    }
    if (!loaderVersion) {
      const candidateLoaderParts = parts.filter((p) => {
        const isMcVersion =
          /^\d+\.\d+(?:\.\d+)?$/.test(p) ||
          /^\d{2}w\d{2}[a-z]$/.test(p) ||
          /^\d+(\.\d+)?$/.test(p);
        return !isMcVersion;
      });
      if (candidateLoaderParts.length > 0) loaderVersion = candidateLoaderParts.join("-");
    }
  }

  return {
    name: dirName,
    mcVersion,
    majorVersion,
    loaderType,
    loaderVersion: loaderVersion || dirName,
  };
}

const KNOWN_LOADERS = new Set([
  "vanilla",
  "forge",
  "fabric",
  "neoforge",
  "quilt",
  "optifine",
  "liteloader",
]);

export function parsedVersionFromInstance(instance: InstanceData): ParsedVersion {
  const fromName = parseVersionDir(instance.name);
  const detectedLoader = instance.loader.trim().toLowerCase();
  const loaderType = KNOWN_LOADERS.has(detectedLoader)
    ? detectedLoader
    : fromName.loaderType;

  const mcVersion =
    instance.minecraft_version && instance.minecraft_version !== "0.0.0"
      ? instance.minecraft_version
      : fromName.mcVersion;

  const versionParts = mcVersion.split(".");
  const majorVersion =
    versionParts.length >= 2 ? `${versionParts[0]}.${versionParts[1]}` : fromName.majorVersion;

  return {
    name: instance.name,
    mcVersion,
    majorVersion,
    loaderType,
    loaderVersion:
      fromName.loaderType === loaderType && fromName.loaderVersion !== instance.name
        ? fromName.loaderVersion
        : instance.name,
  };
}

export function versionToLaunchConfig(version: ParsedVersion) {
  const isVanilla = version.loaderType === "vanilla";
  return {
    versionName: version.name,
    minecraftVersion: version.mcVersion,
    loadType: isVanilla ? "0" : "1",
    loadName: isVanilla ? "" : version.name,
  } as const;
}
