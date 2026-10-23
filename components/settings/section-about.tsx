"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, Download, Check, RefreshCcw, Package, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/components/i18n/use-i18n";
import { invoke } from "@tauri-apps/api/core";
import { listenLauncherUpdateProgress } from "@/lib/launcher-update-progress";
import { LauncherUpdateProgressBar } from "@/components/settings/launcher-update-progress-bar";
import {
  markUpToDateAndSuppressAutoCheck,
  markUpdateCheckTimeout,
  resetUpdateCheckSuppression,
  shouldResetSuppressionOnSettingsManualCheck,
  shouldSkipAutomaticUpdateCheck,
} from "@/lib/launcher-update-session";
import { isUpdateCheckTimeoutError } from "@/lib/update-check";

type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; version: string; notes: string }
  | { kind: "up-to-date" }
  | { kind: "error"; message: string };

export function AboutSection() {
  const { t } = useI18n();
  const [state, setState] = useState<UpdateState>({ kind: "idle" });
  const [installing, setInstalling] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        const v = await getVersion();
        // 0.2.0-beta → display "beta 0.2"
        const m = /^(\d+)\.(\d+)\.\d+-beta$/i.exec(v.trim());
        setVersion(m ? `beta ${m[1]}.${m[2]}` : v);
      } catch {
        setVersion("dev");
      }
    })();
  }, []);

  const check = async (userInitiated = false) => {
    if (userInitiated && shouldResetSuppressionOnSettingsManualCheck()) {
      resetUpdateCheckSuppression();
    }
    setState({ kind: "checking" });
    try {
      const result = await invoke<{
        update_available: boolean;
        target_version: string | null;
        changelog: string | null;
      }>("check_for_updates", { force: true });
      if (result.update_available && result.target_version) {
        setState({
          kind: "available",
          version: result.target_version,
          notes: result.changelog ?? "",
        });
      } else {
        setState({ kind: "up-to-date" });
        markUpToDateAndSuppressAutoCheck();
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (isUpdateCheckTimeoutError(message)) {
        markUpdateCheckTimeout(message);
      }
      setState({ kind: "error", message });
    }
  };

  const install = async () => {
    setInstalling(true);
    setDownloadProgress(0);
    try {
      const unlisten = await listenLauncherUpdateProgress(setDownloadProgress);
      try {
        await invoke("download_update");
      } finally {
        unlisten();
      }
      await invoke("install_update");
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setInstalling(false);
      setDownloadProgress(null);
    }
  };

  // 首次进入自动检查一次（启动时已检查或已确认最新则跳过）
  useEffect(() => {
    const t = setTimeout(() => {
      if (state.kind === "idle" && !shouldSkipAutomaticUpdateCheck()) check();
    }, 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Card id="section-about" className="scroll-mt-4">
      <CardHeader className="pb-4">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Package className="size-4 text-primary" />
            {t("settings.about.updates")}
          </CardTitle>
          <CardDescription className="text-xs mt-1">
            {t("settings.about.currentVersionAndLauncherUpdates")}
          </CardDescription>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-3">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary shrink-0">
            <Sparkles className="size-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium">OpenXLauncher</div>
            <div className="text-xs text-muted-foreground">
              {t("settings.about.version")} <span className="font-mono">{version ?? "—"}</span>
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm">
              <RefreshCcw className={cn("size-3.5 text-muted-foreground", state.kind === "checking" && "animate-spin")} />
              {state.kind === "idle" && t("settings.about.updatesHaveNotBeenChecked")}
              {state.kind === "checking" && t("settings.appUpdater.checkingForUpdates")}
              {state.kind === "up-to-date" && <span className="text-emerald-600 dark:text-emerald-400">{t("settings.about.youReUpToDate")}</span>}
              {state.kind === "available" && (
                <span className="text-amber-600 dark:text-amber-400">{t("settings.about.newVersionAvailable")} v{state.version}</span>
              )}
              {state.kind === "error" && <span className="text-destructive">{t("settings.about.updateCheckFailed")}</span>}
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => check(true)} disabled={state.kind === "checking"} className="gap-1.5 h-8">
                <RefreshCcw className={cn("size-3.5", state.kind === "checking" && "animate-spin")} />
                {t("settings.appUpdater.checkForUpdates")}
              </Button>
              {state.kind === "available" && (
                <Button size="sm" onClick={install} disabled={installing} className="gap-1.5 h-8">
                  {installing ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                  {installing
                    ? t("settings.about.installing")
                    : t("settings.appUpdater.installNow")}
                </Button>
              )}
            </div>
          </div>

          {installing && (
            <LauncherUpdateProgressBar
              percent={downloadProgress}
              label={t("settings.about.installing")}
            />
          )}

          {state.kind === "available" && state.notes && (
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/30 p-3 text-xs leading-relaxed text-foreground/80">
              {state.notes}
            </pre>
          )}

          {state.kind === "error" && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
              {state.message}
            </div>
          )}

          {state.kind === "up-to-date" && (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs text-emerald-600 dark:text-emerald-400">
              <Check className="size-3.5" />
              {t("settings.about.theLauncherIsUpToDate")}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
