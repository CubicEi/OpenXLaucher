"use client";

import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { useRouter } from "next/navigation";
import { Download, Sparkles } from "lucide-react";

import { useI18n } from "@/components/i18n/use-i18n";
import { setAppUpdateState } from "@/components/settings/app-updater";
import { LauncherUpdateNoticeAlert } from "@/components/settings/launcher-update-notice-alert";
import {
  markStartupUpdateCheckCompleted,
  markStartupUpdatePromptDismissed,
  markUpToDateAndSuppressAutoCheck,
  markUpdateCheckTimeout,
  shouldRunStartupUpdateCheck,
  shouldShowStartupUpdatePrompt,
} from "@/lib/launcher-update-session";
import { isUpdateCheckTimeoutError } from "@/lib/update-check";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface UpdateCheckResult {
  needs_check: boolean;
  update_available: boolean;
  current_version: string;
  target_version: string | null;
  message: string;
  changelog: string | null;
}

interface AvailableUpdate {
  version: string;
  changelog: string;
}

export function StartupUpdateNotifier({ delayMs = 1500 }: { delayMs?: number }) {
  const router = useRouter();
  const { t } = useI18n();
  const [availableUpdate, setAvailableUpdate] = useState<AvailableUpdate | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [upToDateOpen, setUpToDateOpen] = useState(false);
  const [updateSuccessOpen, setUpdateSuccessOpen] = useState(false);
  const [updateFailedOpen, setUpdateFailedOpen] = useState(false);
  const [installedVersion, setInstalledVersion] = useState<string>("");
  const [updateFailureMessage, setUpdateFailureMessage] = useState<string>("");

  useEffect(() => {
    let active = true;
    const showPostUpdateNotices = async () => {
      try {
        const failure = await invoke<string | null>("take_post_update_failure");
        if (!active) return;
        if (failure) {
          setUpdateFailureMessage(failure);
          setUpdateFailedOpen(true);
          return;
        }

        const pending = await invoke<boolean>("take_post_update_success");
        if (!active || !pending) return;
        const version = await getVersion();
        if (!active) return;
        markUpToDateAndSuppressAutoCheck();
        setAppUpdateState({ kind: "up-to-date" });
        setInstalledVersion(version);
        setUpdateSuccessOpen(true);
      } catch {
        // 非 Tauri 环境或命令不可用时忽略
      }
    };
    void showPostUpdateNotices();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!shouldRunStartupUpdateCheck()) return;

    let active = true;
    const timer = window.setTimeout(() => {
      const checkAtStartup = async () => {
        if (!shouldRunStartupUpdateCheck()) return;
        setAppUpdateState({ kind: "checking" });
        try {
          const result = await invoke<UpdateCheckResult>("check_for_updates", { force: true });
          if (!active) return;

          if (result.update_available && result.target_version) {
            const changelog = result.changelog ?? "";
            setAppUpdateState({
              kind: "available",
              version: result.target_version,
              notes: changelog,
              prepared: true,
            });
            setAvailableUpdate({ version: result.target_version, changelog });
            if (shouldShowStartupUpdatePrompt(result.target_version)) {
              setUpdateOpen(true);
            }
            return;
          }

          setAppUpdateState({ kind: "up-to-date" });
          markUpToDateAndSuppressAutoCheck();
          setUpToDateOpen(true);
        } catch (error) {
          if (!active) return;
          const message = error instanceof Error ? error.message : String(error);
          if (isUpdateCheckTimeoutError(message)) {
            markUpdateCheckTimeout(message);
          }
          setAppUpdateState({
            kind: "error",
            message,
          });
        } finally {
          if (active) {
            markStartupUpdateCheckCompleted();
          }
        }
      };

      void checkAtStartup();
    }, delayMs);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [delayMs]);

  const dismissUpdatePrompt = () => {
    markStartupUpdatePromptDismissed(availableUpdate?.version);
    setUpdateOpen(false);
  };

  const startUpdate = () => {
    setUpdateOpen(false);
    if (!availableUpdate) return;
    router.push(
      `/check-update?autoStart=1&preparedVersion=${encodeURIComponent(availableUpdate.version)}`,
    );
  };

  const handleUpdateOpenChange = (open: boolean) => {
    if (!open) {
      markStartupUpdatePromptDismissed(availableUpdate?.version);
    }
    setUpdateOpen(open);
  };

  return (
    <>
      <Dialog open={updateOpen} onOpenChange={handleUpdateOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              <Sparkles className="size-5 text-amber-500" />
              {t("settings.appUpdater.newVersionVVersion", {
                version: availableUpdate?.version ?? "",
              })}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-3 px-5 py-4">
            {availableUpdate?.changelog ? (
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs leading-relaxed text-foreground/80">
                {availableUpdate.changelog}
              </pre>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("settings.appUpdater.noReleaseNotesAvailable")}
              </p>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
            <Button variant="outline" onClick={dismissUpdatePrompt}>
              {t("settings.appUpdater.later")}
            </Button>
            <Button onClick={startUpdate}>
              <Download className="size-4" />
              {t("settings.appUpdater.updateNow")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <LauncherUpdateNoticeAlert
        open={updateSuccessOpen}
        onOpenChange={setUpdateSuccessOpen}
        title={t("checkUpdate.updateSuccessTitle")}
        description={t("checkUpdate.updateSuccessMessage", { version: installedVersion })}
      />

      <LauncherUpdateNoticeAlert
        open={updateFailedOpen}
        onOpenChange={setUpdateFailedOpen}
        title={t("checkUpdate.updateFailedTitle")}
        description={updateFailureMessage}
      />

      <LauncherUpdateNoticeAlert
        open={upToDateOpen}
        onOpenChange={setUpToDateOpen}
        title={t("checkUpdate.upToDate")}
        description={t("checkUpdate.upToDateMessage")}
      />
    </>
  );
}
