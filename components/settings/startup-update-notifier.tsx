"use client";

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useRouter } from "next/navigation";
import { Check, Download, Sparkles } from "lucide-react";

import { useI18n } from "@/components/i18n/use-i18n";
import { setAppUpdateState } from "@/components/settings/app-updater";
import {
  markStartupUpdateCheckCompleted,
  markUpToDateAndSuppressAutoCheck,
  markUpdateCheckTimeout,
  shouldRunStartupUpdateCheck,
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

  useEffect(() => {
    if (!shouldRunStartupUpdateCheck()) return;

    let active = true;
    const timer = window.setTimeout(() => {
      const checkAtStartup = async () => {
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
            setUpdateOpen(true);
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

  const startUpdate = () => {
    setUpdateOpen(false);
    if (!availableUpdate) return;
    router.push(
      `/check-update?autoStart=1&preparedVersion=${encodeURIComponent(availableUpdate.version)}`,
    );
  };

  return (
    <>
      <Dialog open={updateOpen} onOpenChange={setUpdateOpen}>
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
            <Button variant="outline" onClick={() => setUpdateOpen(false)}>
              {t("settings.appUpdater.later")}
            </Button>
            <Button onClick={startUpdate}>
              <Download className="size-4" />
              {t("settings.appUpdater.updateNow")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={upToDateOpen} onOpenChange={setUpToDateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Check className="size-5 text-emerald-500" />
              {t("checkUpdate.upToDate")}
            </DialogTitle>
          </DialogHeader>
          <p className="px-5 pb-4 text-sm text-muted-foreground">
            {t("checkUpdate.upToDateMessage")}
          </p>
          <div className="flex justify-end border-t border-border px-5 py-3">
            <Button onClick={() => setUpToDateOpen(false)}>{t("settings.appUpdater.dismiss")}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
