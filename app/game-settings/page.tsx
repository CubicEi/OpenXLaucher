"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { invoke } from "@tauri-apps/api/core";
import {
  Gamepad2,
  Puzzle,
  Image as ImageIcon,
  Box,
  Map,
  Layers,
  Database,
  Camera,
  Package,
  ChevronRight,
  Trash2,
  Loader2,
  type LucideIcon,
} from "lucide-react";
import { motion } from "framer-motion";
import { useLaunchContext } from "@/components/launch/launch-provider";
import { VersionSelectorDialog } from "@/components/launch/version-selector-dialog";
import { InstanceNameDialog } from "@/components/download/instance-name-dialog";
import {
  invalidateInstancesCache,
  useInstances,
} from "@/hooks/use-instances";
import { fadeSlideUp } from "@/lib/motion";
import { Button } from "@/components/ui/button";
import { useI18n, type Translation } from "@/components/i18n/use-i18n";
import { GAME_SETTINGS_FEATURE_NAV } from "./feature-nav";
import {
  createInAppLinkHandler,
  onInAppLinkPointerDown,
} from "@/lib/main-navigation-transition";

const FEATURE_META: Record<
  (typeof GAME_SETTINGS_FEATURE_NAV)[number]["href"],
  { description: Translation; icon: LucideIcon }
> = {
  "/game-settings/mods": {
    description: "gameSettings.addRemoveAndManageMods",
    icon: Puzzle,
  },
  "/game-settings/resources": {
    description: "gameSettings.switchAndManageTextureResourcePacks",
    icon: ImageIcon,
  },
  "/game-settings/worlds": {
    description: "gameSettings.manageYourWorldSaves",
    icon: Map,
  },
  "/game-settings/shaders": {
    description: "gameSettings.configureShaderEffectsAndShaders",
    icon: Layers,
  },
  "/game-settings/datapacks": {
    description: "gameSettings.manageMinecraftDatapacks",
    icon: Database,
  },
  "/game-settings/schematics": {
    description: "gameSettings.manageBuildingSchematicFiles",
    icon: Box,
  },
  "/game-settings/screenshots": {
    description: "gameSettings.viewScreenshotsSavedInGame",
    icon: Camera,
  },
};

const SETTING_ENTRIES = GAME_SETTINGS_FEATURE_NAV.map((item) => ({
  ...item,
  ...FEATURE_META[item.href],
}));

/**
 * 游戏设置 · 核心设置页
 * 布局：左侧约 2/3 预留核心设置区 · 右侧约 1/3 垂直词条列表
 */
export default function GameSettings() {
  const router = useRouter();
  const { config, updateConfig } = useLaunchContext();
  const { t } = useI18n();
  const [versionDialogOpen, setVersionDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);

  const instancesPath = config.minecraftPath
    ? `${config.minecraftPath}/versions`
    : undefined;
  const { refetch: refetchInstances } = useInstances(instancesPath);

  const versionName = config.versionName || t("gameSettings.clickToSelectVersion");
  const hasLoader = config.loadType !== "0" && config.loadName;
  const isConfigured = !!config.minecraftPath && !!config.versionName;

  const effectiveVersionDirName =
    config.loadType !== "0" && config.loadName
      ? config.loadName
      : config.versionName;

  async function handleDeleteVersion(e: React.MouseEvent) {
    e.stopPropagation();
    if (!config.minecraftPath || !effectiveVersionDirName) {
      alert(t("gameSettings.pleaseSelectAVersionToDeleteFirst"));
      return;
    }

    const confirmed = window.confirm(
      t("gameSettings.confirmDeletionOfGameVersionDirectoryEffectiveVersionDir", {
        effectiveVersionDirName: effectiveVersionDirName,
        minecraftPath: config.minecraftPath,
        effectiveVersionDirName2: effectiveVersionDirName,
      })
    );
    if (!confirmed) return;

    try {
      setDeleting(true);
      await invoke("delete_version_dir_cmd", {
        minecraftPath: config.minecraftPath,
        versionName: effectiveVersionDirName,
      });
      updateConfig({
        versionName: "",
        loadType: "0",
        loadName: "",
      });
      setVersionDialogOpen(false);
      alert(
        t("gameSettings.deletedVersionDirectoryEffectiveVersionDirName", {
          effectiveVersionDirName: effectiveVersionDirName,
        })
      );
    } catch (err) {
      alert(String(err));
    } finally {
      setDeleting(false);
    }
  }

  async function handleRenameVersionConfirm(resolvedName: string) {
    if (!config.minecraftPath || !effectiveVersionDirName) {
      return;
    }

    try {
      setRenaming(true);
      const newName = await invoke<string>("vm_rename_version_dir", {
        minecraftPath: config.minecraftPath,
        oldFolderName: effectiveVersionDirName,
        newFolderName: resolvedName,
      });

      const configPatch: {
        versionName?: string;
        loadName?: string;
      } = {};
      if (config.loadType !== "0" && config.loadName === effectiveVersionDirName) {
        configPatch.loadName = newName;
      }
      if (config.versionName === effectiveVersionDirName) {
        configPatch.versionName = newName;
      }
      if (Object.keys(configPatch).length > 0) {
        updateConfig(configPatch);
      }

      if (instancesPath) {
        invalidateInstancesCache(instancesPath);
        refetchInstances();
      }

      setRenameDialogOpen(false);
      alert(
        t("gameSettings.renameVersionSuccess", {
          newName,
        })
      );
    } catch (err) {
      alert(String(err));
    } finally {
      setRenaming(false);
    }
  }

  return (
    <div className="flex h-full w-full min-h-0 flex-col overflow-hidden bg-background">
      <div className="mx-auto flex h-full min-h-0 w-full max-w-[1600px] flex-1 flex-col gap-4 p-4 md:p-5">
        <motion.div
          variants={fadeSlideUp}
          initial="initial"
          animate="animate"
          className="flex shrink-0 items-center gap-2 rounded-2xl border border-border bg-card/80 p-3 shadow-sm backdrop-blur-sm"
        >
          <button
            type="button"
            onClick={() => setVersionDialogOpen(true)}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-accent/30 focus:outline-none"
            title={t("gameSettings.clickToSelectGameVersion")}
          >
            <div className="pointer-events-none flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10">
              <Gamepad2 className="size-5 text-primary" />
            </div>
            <div className="pointer-events-none min-w-0 flex-1 text-left">
              <h1 className="truncate text-lg font-semibold leading-none">{versionName}</h1>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {hasLoader
                  ? config.loadName
                  : t("gameSettings.vanillaNoModLoaderClickTitleToSelectVersion")}
              </p>
            </div>
          </button>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 gap-1.5"
              asChild
            >
              <Link
                href="/game-settings/modpacks"
                onPointerDown={onInAppLinkPointerDown}
                onClick={createInAppLinkHandler(router, "/game-settings/modpacks")}
                suppressHydrationWarning
              >
                <Package className="size-3.5" />
                <span className="text-xs">{t("gameSettings.goToModpackManagement")}</span>
              </Link>
            </Button>
            {isConfigured && (
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 gap-1.5 hover:border-red-500/50 hover:text-red-500"
                onClick={handleDeleteVersion}
                disabled={deleting}
                title={t("gameSettings.deleteCurrentlySelectedGameVersionDirectory")}
              >
                {deleting ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Trash2 className="size-3.5" />
                )}
                <span className="text-xs">{t("gameSettings.deleteVersion")}</span>
              </Button>
            )}
          </div>
        </motion.div>

        <div className="flex min-h-0 flex-1 flex-col gap-4">
          <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row md:items-stretch">
            <motion.section
              variants={fadeSlideUp}
              initial="initial"
              animate="animate"
              transition={{ delay: 0.05 }}
              aria-label={t("gameSettings.coreSettings")}
              className="flex min-h-[12rem] min-w-0 flex-[2] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm md:min-h-0"
            >
              <div className="border-b border-border bg-muted/20 px-4 py-2.5">
                <p className="text-xs font-medium text-muted-foreground">
                  {t("gameSettings.coreSettings")}
                </p>
              </div>
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
                {!isConfigured ? (
                  <div className="flex flex-1 flex-col items-center justify-center gap-3 p-5 text-center">
                    <div className="flex size-12 items-center justify-center rounded-full bg-muted">
                      <Gamepad2 className="size-6 text-muted-foreground" />
                    </div>
                    <p className="text-sm font-medium">
                      {t("gameSettings.pleaseClickTheTitleAboveToSelectAGame")}
                    </p>
                    <p className="max-w-sm text-xs text-muted-foreground">
                      {t("gameSettings.afterConfigurationYouCanManageModsResourcePacksAnd")}
                    </p>
                  </div>
                ) : (
                  <ul className="divide-y divide-border">
                    <li className="flex items-center gap-3 px-4 py-3">
                      <span className="min-w-0 flex-1 text-sm font-medium">
                        {t("gameSettings.renameVersionFolder")}
                      </span>
                      <Button
                        size="sm"
                        className="shrink-0"
                        disabled={renaming}
                        onClick={() => setRenameDialogOpen(true)}
                      >
                        {renaming ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : null}
                        {t("gameSettings.startRenameVersion")}
                      </Button>
                    </li>
                  </ul>
                )}
              </div>
            </motion.section>

            <motion.nav
              variants={fadeSlideUp}
              initial="initial"
              animate="animate"
              transition={{ delay: 0.1 }}
              aria-label={t("gameSettings.featureEntries")}
              className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm md:flex-[1]"
            >
              <div className="shrink-0 border-b border-border bg-muted/20 px-4 py-2.5">
                <p className="text-xs font-medium text-muted-foreground">
                  {t("gameSettings.featureEntries")}
                </p>
              </div>
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
                {SETTING_ENTRIES.map((entry) => {
                  const Icon = entry.icon;
                  return (
                    <Link
                      key={entry.href}
                      href={entry.href}
                      onPointerDown={onInAppLinkPointerDown}
                      onClick={createInAppLinkHandler(router, entry.href)}
                      suppressHydrationWarning
                      className="group flex items-center gap-3 border-b border-border px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-accent/40"
                    >
                      <Icon className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <span className="block text-sm font-medium leading-tight">
                          {t(entry.label)}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                          {t(entry.description)}
                        </span>
                      </div>
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                    </Link>
                  );
                })}
              </div>
            </motion.nav>
          </div>
        </div>
      </div>

      <VersionSelectorDialog open={versionDialogOpen} onOpenChange={setVersionDialogOpen} />

      <InstanceNameDialog
        open={renameDialogOpen}
        onOpenChange={setRenameDialogOpen}
        defaultName={effectiveVersionDirName ?? ""}
        titleKey="gameSettings.renameVersionDialogTitle"
        hintKey="gameSettings.renameVersionDialogHint"
        confirmKey="gameSettings.renameVersionConfirm"
        confirming={renaming}
        onConfirm={handleRenameVersionConfirm}
      />
    </div>
  );
}
