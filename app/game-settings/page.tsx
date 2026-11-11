"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { invoke } from "@tauri-apps/api/core";
import {
  Gamepad2,
  Package,
  Trash2,
  Loader2,
} from "lucide-react";
import { useAccountContext } from "@/components/accounts/account-provider";
import { useLaunchContext } from "@/components/launch/launch-provider";
import { SELECT_VERSION_PATH } from "@/components/launch/version-selector-panel";
import { InstanceNameDialog } from "@/components/download/instance-name-dialog";
import {
  invalidateInstancesCache,
  useInstances,
} from "@/hooks/use-instances";
import { PageEnterItem } from "@/components/layout/page-enter";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useI18n, type TranslationKey } from "@/components/i18n/use-i18n";
import {
  createInAppLinkHandler,
  navigateWithMainTransition,
  onInAppLinkPointerDown,
} from "@/lib/main-navigation-transition";
import { useDownloadManager } from "@/components/download/download-provider";
import { useCornerNotice } from "@/components/global/corner-notice";
import {
  extractMcVersion,
  inferLoaderFamilyFromFolder,
} from "@/lib/instance-name";
import { setRetargetContext } from "@/lib/retarget-version";
import {
  VERSION_PROFILE_GLOBAL,
  clearVersionProfileOverride,
  getVersionProfileOverride,
  renameVersionProfileOverride,
  setVersionProfileOverride,
} from "@/lib/version-profile";
import type { AuthType } from "@/types";

type TranslateFn = (key: TranslationKey, values?: Record<string, string | number>) => string;

function authTypeShortLabel(authType: AuthType, t: TranslateFn): string {
  switch (authType) {
    case "offline":
      return t("gameSettings.authTypeOffline");
    case "microsoft":
      return t("gameSettings.authTypeMicrosoft");
    case "littleskin":
      return t("gameSettings.authTypeLittleSkin");
    case "third_party":
      return t("gameSettings.authTypeThirdParty");
  }
}

function ProfileOptionLabel({
  name,
  authType,
  t,
}: {
  name: string;
  authType: AuthType;
  t: TranslateFn;
}) {
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1.5">
      <span className="truncate">{name}</span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {authTypeShortLabel(authType, t)}
      </span>
    </span>
  );
}

/**
 * 游戏设置 · 核心设置页
 */
export default function GameSettings() {
  const router = useRouter();
  const { config, updateConfig } = useLaunchContext();
  const { profiles, selectedProfile } = useAccountContext();
  const { tasks } = useDownloadManager();
  const { pushNotice } = useCornerNotice();
  const { t } = useI18n();
  const [deleteVersionOpen, setDeleteVersionOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [versionProfileValue, setVersionProfileValue] =
    useState(VERSION_PROFILE_GLOBAL);

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

  useEffect(() => {
    if (!config.minecraftPath || !effectiveVersionDirName) {
      setVersionProfileValue(VERSION_PROFILE_GLOBAL);
      return;
    }
    const override = getVersionProfileOverride(
      config.minecraftPath,
      effectiveVersionDirName,
    );
    if (override && profiles.some((p) => p.id === override)) {
      setVersionProfileValue(override);
    } else {
      setVersionProfileValue(VERSION_PROFILE_GLOBAL);
    }
  }, [config.minecraftPath, effectiveVersionDirName, profiles]);

  const globalProfileLabel = useMemo(() => {
    if (!selectedProfile) {
      return t("gameSettings.launchProfileUseGlobal");
    }
    return (
      <ProfileOptionLabel
        name={t("gameSettings.launchProfileUseGlobalWithName", {
          name: selectedProfile.name,
        })}
        authType={selectedProfile.authType}
        t={t}
      />
    );
  }, [selectedProfile, t]);

  function handleVersionProfileChange(next: string) {
    if (!config.minecraftPath || !effectiveVersionDirName) return;
    setVersionProfileValue(next);
    setVersionProfileOverride(
      config.minecraftPath,
      effectiveVersionDirName,
      next === VERSION_PROFILE_GLOBAL ? null : next,
    );
  }

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
      clearVersionProfileOverride(config.minecraftPath, effectiveVersionDirName);
      updateConfig({
        versionName: "",
        loadType: "0",
        loadName: "",
      });
      setDeleteVersionOpen(false);
      const deletedName = effectiveVersionDirName;
      pushNotice({
        variant: "success",
        message: t("gameSettings.deletedVersionDirectoryEffectiveVersionDirName", {
          effectiveVersionDirName: deletedName,
        }),
      });
    } catch (err) {
      pushNotice({ variant: "error", message: String(err) });
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
      const oldFolder = effectiveVersionDirName;
      const newName = await invoke<string>("vm_rename_version_dir", {
        minecraftPath: config.minecraftPath,
        oldFolderName: oldFolder,
        newFolderName: resolvedName,
      });

      renameVersionProfileOverride(config.minecraftPath, oldFolder, newName);

      const configPatch: {
        versionName?: string;
        loadName?: string;
      } = {};
      if (config.loadType !== "0" && config.loadName === oldFolder) {
        configPatch.loadName = newName;
      }
      if (config.versionName === oldFolder) {
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
        <PageEnterItem className="flex shrink-0 items-center gap-2 rounded-2xl border border-border bg-card/80 p-3 shadow-sm backdrop-blur-sm">
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
        </PageEnterItem>

        <PageEnterItem
          aria-label={t("gameSettings.coreSettings")}
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm"
        >
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
                  <div className="min-w-0 flex-1 pr-3">
                    <span className="block text-sm font-medium">
                      {t("gameSettings.launchProfile")}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {t("gameSettings.launchProfileHint")}
                    </span>
                  </div>
                  <Select
                    value={versionProfileValue}
                    onValueChange={handleVersionProfileChange}
                  >
                    <SelectTrigger className="h-8 w-[min(100%,280px)] shrink-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={VERSION_PROFILE_GLOBAL}>
                        {globalProfileLabel}
                      </SelectItem>
                      {profiles.map((profile) => (
                        <SelectItem key={profile.id} value={profile.id}>
                          <ProfileOptionLabel
                            name={profile.name}
                            authType={profile.authType}
                            t={t}
                          />
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </li>
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
              </ul>
            )}
          </div>
        </PageEnterItem>
      </div>

      <InstanceNameDialog
        open={renameDialogOpen}
        onOpenChange={setRenameDialogOpen}
        defaultName={effectiveVersionDirName ?? ""}
        titleKey="gameSettings.renameVersionDialogTitle"
        hintKey="gameSettings.renameVersionDialogHint"
        confirmKey="gameSettings.renameVersionConfirm"
        confirming={renaming}
        instancesPath={instancesPath}
        excludeFolderName={effectiveVersionDirName ?? undefined}
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
