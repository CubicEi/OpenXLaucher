"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  PackageOpen,
  Search,
  Loader2,
  CheckCircle2,
  Settings,
  RefreshCw,
  ArrowLeft,
} from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { useI18n, type TranslationKey } from "@/components/i18n/use-i18n";
import { useLaunchContext } from "./launch-provider";
import { useDownloadManager } from "@/components/download/download-provider";
import { shouldHideVersionDuringInstall } from "@/lib/installing-version-filter";
import { LoaderIcon, inferLoaderKind, type LoaderKind } from "@/components/launch/loader-icon";
import { fadeSlideUp } from "@/lib/motion";
import { navigateWithMainTransition } from "@/lib/main-navigation-transition";
import type { InstanceData } from "@/types";

type ScannedInstance = InstanceData;

/** 解析后的版本信息 */
export interface ParsedVersion {
  name: string;
  mcVersion: string;
  majorVersion: string;
  loaderType: string;
  loaderVersion: string;
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

export const LOADER_DISPLAY: Record<string, { label: TranslationKey; color: string; order: number }> = {
  vanilla: { label: "launch.versionSelector.vanilla", color: "bg-green-500/10 text-green-600 dark:text-green-400", order: 0 },
  forge: { label: "launch.versionSelector.forge", color: "bg-orange-500/10 text-orange-600 dark:text-orange-400", order: 1 },
  fabric: { label: "launch.versionSelector.fabric", color: "bg-purple-500/10 text-purple-600 dark:text-purple-400", order: 2 },
  neoforge: { label: "launch.versionSelector.neoForge", color: "bg-blue-500/10 text-blue-600 dark:text-blue-400", order: 3 },
  quilt: { label: "launch.versionSelector.quilt", color: "bg-pink-500/10 text-pink-600 dark:text-pink-400", order: 4 },
  optifine: { label: "launch.versionSelector.optiFine", color: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400", order: 5 },
  liteloader: { label: "launch.versionSelector.liteLoader", color: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400", order: 6 },
};

export function parsedVersionFromInstance(instance: ScannedInstance): ParsedVersion {
  const fromName = parseVersionDir(instance.name);
  const detectedLoader = instance.loader.trim().toLowerCase();
  const loaderType = Object.prototype.hasOwnProperty.call(LOADER_DISPLAY, detectedLoader)
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

function compareMcVersionDesc(a: string, b: string): number {
  const parseNum = (s: string) => {
    const parts = s.split(".").map((p) => {
      const n = parseInt(p, 10);
      return isNaN(n) ? 0 : n;
    });
    while (parts.length < 3) parts.push(0);
    return parts.slice(0, 3);
  };
  const pa = parseNum(a);
  const pb = parseNum(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pb[i] - pa[i];
  }
  return 0;
}

export const SELECT_VERSION_PATH = "/select-version";

type VersionSelectorPanelProps = {
  /** After selecting a version (default: router.back) */
  onAfterSelect?: () => void;
};

/**
 * Full-page game version selector (replaces dialog-only flow).
 */
export function VersionSelectorPanel({ onAfterSelect }: VersionSelectorPanelProps = {}) {
  const { t } = useI18n();
  const router = useRouter();
  const { config, updateConfig } = useLaunchContext();
  const { tasks } = useDownloadManager();
  const [versions, setVersions] = useState<ParsedVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const loadVersions = useCallback(async () => {
    if (!config.minecraftPath) {
      setVersions([]);
      return;
    }

    try {
      setLoading(true);
      const versionsPath = `${config.minecraftPath}/versions`;
      const instances = await invoke<ScannedInstance[]>("vm_scan_instances", {
        instancesPath: versionsPath,
      });
      setVersions(instances.map(parsedVersionFromInstance));
    } catch (error) {
      console.error("Failed to load versions:", error);
      setVersions([]);
    } finally {
      setLoading(false);
    }
  }, [config.minecraftPath]);

  useEffect(() => {
    void loadVersions();
    setSearchQuery("");
  }, [loadVersions, tasks]);

  const filteredVersions = useMemo(() => {
    const visible = versions.filter((v) => !shouldHideVersionDuringInstall(v.name, tasks));
    const sorted = [...visible].sort((a, b) => {
      const byMc = compareMcVersionDesc(a.mcVersion, b.mcVersion);
      if (byMc !== 0) return byMc;
      return a.name.localeCompare(b.name);
    });

    const q = searchQuery.trim().toLowerCase();
    if (!q) return sorted;

    return sorted.filter(
      (v) =>
        v.name.toLowerCase().includes(q) ||
        v.mcVersion.toLowerCase().includes(q) ||
        v.loaderVersion.toLowerCase().includes(q) ||
        v.loaderType.toLowerCase().includes(q),
    );
  }, [versions, searchQuery, tasks]);

  const finish = () => {
    if (onAfterSelect) {
      onAfterSelect();
      return;
    }
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
    } else {
      navigateWithMainTransition(router, "/");
    }
  };

  const handleSelectVersion = (version: ParsedVersion) => {
    updateConfig(versionToLaunchConfig(version));
    finish();
  };

  const handleOpenGameSettings = (e: React.MouseEvent, version: ParsedVersion) => {
    e.stopPropagation();
    updateConfig(versionToLaunchConfig(version));
    navigateWithMainTransition(router, "/game-settings");
  };

  const handleBack = () => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
    } else {
      navigateWithMainTransition(router, "/");
    }
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden p-4">
      <motion.div
        variants={fadeSlideUp}
        initial="initial"
        animate="animate"
        className="flex shrink-0 items-center gap-3"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          onClick={handleBack}
          aria-label={t("common.back")}
          title={t("common.back")}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10">
          <PackageOpen className="size-5 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold leading-none">
            {t("launch.versionSelector.selectAGameVersion")}
          </h1>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {config.versionName || t("launch.versionSidebar.noInstalledVersions")}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          onClick={() => void loadVersions()}
          disabled={loading}
          title={t("common.refresh")}
          aria-label={t("common.refresh")}
        >
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
        </Button>
      </motion.div>

      <motion.div
        variants={fadeSlideUp}
        initial="initial"
        animate="animate"
        transition={{ delay: 0.05 }}
        className="relative shrink-0"
      >
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder={t("launch.versionSelector.searchVersions")}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9 text-xs"
        />
      </motion.div>

      <motion.div
        variants={fadeSlideUp}
        initial="initial"
        animate="animate"
        transition={{ delay: 0.08 }}
        className="min-h-0 flex-1 space-y-1 overflow-y-auto overflow-x-hidden"
      >
        {loading && versions.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : filteredVersions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <PackageOpen className="mb-3 size-10 text-muted-foreground/40" />
            <p className="mb-1 text-sm text-muted-foreground">
              {searchQuery
                ? t("launch.versionSelector.noMatchingVersionsFound")
                : t("launch.versionSidebar.noInstalledVersions")}
            </p>
            {!searchQuery && (
              <p className="text-xs text-muted-foreground/60">
                {t("launch.versionSidebar.installAGameVersionFromDownloads")}
              </p>
            )}
          </div>
        ) : (
          filteredVersions.map((version) => {
            const isSelected =
              config.versionName === version.name &&
              (version.loaderType === "vanilla"
                ? config.loadType === "0"
                : config.loadName === version.name);
            const display = LOADER_DISPLAY[version.loaderType];

            return (
              <motion.div
                key={version.name}
                className={cn(
                  "group flex w-full items-center gap-2 rounded-lg p-3 transition-colors",
                  "hover:bg-accent/50",
                  isSelected && "bg-accent text-accent-foreground",
                )}
                whileHover={{ scale: 1.005 }}
              >
                <button
                  type="button"
                  onClick={() => handleSelectVersion(version)}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  {isSelected ? (
                    <div className="flex shrink-0 items-center">
                      <CheckCircle2 className="size-4 shrink-0 text-primary" />
                    </div>
                  ) : (
                    <LoaderIcon
                      kind={inferLoaderKind(version.loaderType) as LoaderKind}
                      className="size-6 shrink-0"
                    />
                  )}

                  <div className="min-w-0 flex-1 overflow-hidden">
                    <div className="truncate text-sm font-medium">{version.name}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span className="text-[11px] text-muted-foreground/80">
                        MC {version.mcVersion}
                      </span>
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[10px] font-medium",
                          display?.color || "bg-gray-500/10 text-gray-600 dark:text-gray-400",
                        )}
                      >
                        {display ? t(display.label) : version.loaderType}
                      </span>
                    </div>
                  </div>
                </button>

                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                  aria-label={t("sidebar.gameSettings")}
                  title={t("sidebar.gameSettings")}
                  onClick={(e) => handleOpenGameSettings(e, version)}
                >
                  <Settings className="size-4" />
                </Button>
              </motion.div>
            );
          })
        )}
      </motion.div>
    </div>
  );
}
