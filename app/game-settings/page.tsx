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
  Sparkles,
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
import { SELECT_VERSION_PATH } from "@/components/launch/version-selector-panel";
import { InstanceNameDialog } from "@/components/download/instance-name-dialog";
import {
  invalidateInstancesCache,
  useInstances,
} from "@/hooks/use-instances";
import { fadeSlideUp } from "@/lib/motion";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useI18n, type Translation } from "@/components/i18n/use-i18n";
import { GAME_SETTINGS_FEATURE_NAV } from "./feature-nav";
import {
  createInAppLinkHandler,
  navigateWithMainTransition,
  onInAppLinkPointerDown,
} from "@/lib/main-navigation-transition";
import { useDownloadManager } from "@/components/download/download-provider";
import {
  extractMcVersion,
  inferLoaderFamilyFromFolder,
} from "@/lib/instance-name";
import { setRetargetContext } from "@/lib/retarget-version";

const FEATURE_META: Record<
  (typeof GAME_SETTINGS_FEATURE_NAV)[number]["href"],
  { description: Translation; icon: LucideIcon }
> = {
  "/game-settings/export": {
    description: "gameSettings.exportInstanceHint",
    icon: Package,
  },
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
    icon: Sparkles,
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
  const { tasks } = useDownloadManager();
  const { t } = useI18n();
  const [deleteVersionOpen, setDeleteVersionOpen] = useState(false);
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

  const versionInstallBusy = tasks.some(
    (task) =>
      (task.status === "downloading" || task.status === "queued") &&
      (task.role === "download" || task.role === "install") &&
      Boolean(task.sessionId)
  );

  function handleStartRetarget() {
    if (!effectiveVersionDirName) return;
    const loaderHint =
      config.loadType !== "0" && config.loadName
        ? config.loadName
        : effectiveVersionDirName;
    const rawMc =
      config.minecraftVersion?.trim() ||
      config.versionName ||
      effectiveVersionDirName;
    setRetargetContext({
      sourceFolderName: effectiveVersionDirName,
      currentMcVersion: extractMcVersion(rawMc),
      currentLoaderFamily: inferLoaderFamilyFromFolder(loaderHint),
    });
    router.push("/game-settings/retarget");
  }

  function handleDeleteVersionClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (!config.minecraftPath || !effectiveVersionDirName) {
      alert(t("gameSettings.pleaseSelectAVersionToDeleteFirst"));
      return;
    }
    setDeleteVersionOpen(true);
  }

  async function handleConfirmDeleteVersion() {
    if (!config.minecraftPath || !effectiveVersionDirName) return;

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
      setDeleteVersionOpen(false);
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
            onClick={() => navigateWithMainTransition(router, SELECT_VERSION_PATH)}
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
                onClick={handleDeleteVersionClick}
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
                    <li className="flex items-center gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">
                          {t("gameSettings.retargetVersion")}
                        </span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {t("gameSettings.retargetVersionHint")}
                        </span>
                      </div>
                      <Button
                        size="sm"
                        className="shrink-0"
                        disabled={!isConfigured || versionInstallBusy}
                        onClick={handleStartRetarget}
                      >
                        {t("gameSettings.retargetVersionStart")}
                      </Button>
                    </li>
                    <li className="flex items-center gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">
                          {t("gameSettings.exportInstance")}
                        </span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {t("gameSettings.exportInstanceHint")}
                        </span>
                      </div>
                      <Button
                        size="sm"
                        className="shrink-0"
                        disabled={!isConfigured || !effectiveVersionDirName}
                        onClick={() => {
                          // #region agent log
                          fetch("http://127.0.0.1:7931/ingest/39fb5222-8319-46c5-a5ae-7bfa2ec61c80", {
                            method: "POST",
                            headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "966db3" },
                            body: JSON.stringify({
                              sessionId: "966db3",
                              hypothesisId: "H3",
                              location: "game-settings/page.tsx:exportStartButton",
                              message: "direct router.push export (no createInAppLinkHandler)",
                              data: {
                                from: window.location.pathname,
                                target: "/game-settings/export",
                              },
                              timestamp: Date.now(),
                            }),
                          }).catch(() => {});
                          // #endregion
                          router.push("/game-settings/export");
                        }}
                      >
                        {t("gameSettings.exportInstanceStart")}
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

      <AlertDialog
        open={deleteVersionOpen}
        onOpenChange={(open) => !deleting && setDeleteVersionOpen(open)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("resource.deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {effectiveVersionDirName
                ? t("gameSettings.confirmDeletionOfGameVersionDirectoryEffectiveVersionDir", {
                    effectiveVersionDirName,
                    minecraftPath: config.minecraftPath ?? "",
                    effectiveVersionDirName2: effectiveVersionDirName,
                  })
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t("common.cancel")}</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={() => void handleConfirmDeleteVersion()}
            >
              {deleting ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t("gameSettings.deleteVersion")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
