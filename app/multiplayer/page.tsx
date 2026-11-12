"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  AlertCircle,
  Globe,
  Loader2,
  RefreshCw,
  Settings,
  ShieldAlert,
} from "lucide-react";
import { useRouter } from "next/navigation";

import { useI18n } from "@/components/i18n/use-i18n";
import { MultiplayerRunningPanel } from "@/components/multiplayer/multiplayer-running-panel";
import { MultiplayerSetupPanel } from "@/components/multiplayer/multiplayer-setup-panel";
import { useMultiplayerContext } from "@/components/multiplayer/multiplayer-provider";
import type { MultiplayerStatus } from "@/components/multiplayer/multiplayer-state";
import { useMultiplayerLogPolling } from "@/components/multiplayer/use-multiplayer-log-polling";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  createInAppLinkHandler,
  onInAppLinkPointerDown,
  toAppHref,
} from "@/lib/main-navigation-transition";
import { cn } from "@/lib/utils";

const SETTINGS_MULTIPLAYER_HREF = "/settings/multiplayer";

export default function MultiplayerPage() {
  const { t } = useI18n();
  const router = useRouter();
  const {
    status,
    errorMsg,
    privilegeRequired,
    runMode,
    roomInfo,
    decodedInvite,
    logText,
    downloadProgress,
    toolDirectory,
    checkStatus,
    ensureInstalled,
    startAsHost,
    startAsJoin,
    stopSession,
    preparePrivileges,
    pollLog,
    clearLog,
  } = useMultiplayerContext();

  const ensureAttemptedRef = useRef(false);

  // Re-sync with backend on enter; provider keeps session across route changes.
  // Do NOT stop EasyTier on unmount — leaving /multiplayer must leave the process running.
  useEffect(() => {
    void checkStatus();
  }, [checkStatus]);

  useEffect(() => {
    if (status !== "not_installed") {
      if (status === "installed" || status === "running") {
        ensureAttemptedRef.current = false;
      }
      return;
    }
    if (ensureAttemptedRef.current) return;
    ensureAttemptedRef.current = true;
    void ensureInstalled().catch(() => {
      // Error state is handled in the provider.
    });
  }, [ensureInstalled, status]);

  useMultiplayerLogPolling(status === "running" || status === "starting", pollLog);

  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden p-4">
      <header className="flex shrink-0 items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10">
            <Globe className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-semibold leading-none">
              {t("multiplayer.page.title")}
            </h1>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("multiplayer.page.subtitle")}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={() => void checkStatus()}
            title={t("common.refresh")}
            aria-label={t("common.refresh")}
          >
            <RefreshCw className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            asChild
            title={t("multiplayer.page.openSettings")}
            aria-label={t("multiplayer.page.openSettings")}
          >
            <a
              href={toAppHref(SETTINGS_MULTIPLAYER_HREF)}
              onPointerDown={onInAppLinkPointerDown}
              onClick={createInAppLinkHandler(router, SETTINGS_MULTIPLAYER_HREF)}
            >
              <Settings className="size-4" />
            </a>
          </Button>
          <StatusBadge status={status} />
        </div>
      </header>

      {status === "error" && errorMsg && !privilegeRequired ? (
        <div className="flex shrink-0 items-start gap-2 rounded-xl bg-destructive/10 p-3 text-xs text-destructive">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          <span className="break-all">{errorMsg}</span>
        </div>
      ) : null}

      <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto">
        {status === "running" ? (
          <MultiplayerRunningPanel
            runMode={runMode}
            roomInfo={roomInfo}
            decodedInvite={decodedInvite}
            logText={logText}
            toolDirectory={toolDirectory ?? ""}
            onStop={stopSession}
            onClearLog={clearLog}
          />
        ) : status === "installing" || status === "not_installed" ? (
          <InstallPanel
            progress={downloadProgress}
            failed={status === "not_installed" && Boolean(errorMsg)}
            errorMsg={errorMsg}
            onRetry={() => {
              ensureAttemptedRef.current = false;
              void ensureInstalled().catch(() => undefined);
            }}
          />
        ) : status === "starting" || status === "stopping" ? (
          <PendingPanel status={status} />
        ) : status === "error" && privilegeRequired ? (
          <PrivilegePanel
            message={errorMsg}
            onPrepare={() => void preparePrivileges().catch(() => undefined)}
            onRetry={() => void checkStatus()}
          />
        ) : status === "installed" || status === "error" ? (
          <MultiplayerSetupPanel onStartHost={startAsHost} onStartJoin={startAsJoin} />
        ) : (
          <CheckingPanel />
        )}
      </main>
    </div>
  );
}

function PrivilegePanel({
  message,
  onPrepare,
  onRetry,
}: {
  message: string | null;
  onPrepare: () => void;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-xl border border-border bg-card p-6">
      <div className="flex size-16 items-center justify-center rounded-2xl bg-amber-500/10">
        <ShieldAlert className="size-8 text-amber-600 dark:text-amber-400" />
      </div>
      <div className="max-w-md space-y-1 text-center">
        <h2 className="text-base font-semibold text-foreground">
          {t("multiplayer.privilege.title")}
        </h2>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {message || t("multiplayer.privilege.message")}
        </p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("multiplayer.privilege.manualHint")}
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button onClick={onPrepare}>{t("multiplayer.privilege.prepare")}</Button>
        <Button variant="outline" onClick={onRetry}>
          {t("common.refresh")}
        </Button>
      </div>
    </div>
  );
}

function InstallPanel({
  progress,
  failed,
  errorMsg,
  onRetry,
}: {
  progress: { downloaded: number; total: number } | null;
  failed?: boolean;
  errorMsg?: string | null;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const percent = useMemo(() => {
    if (!progress || progress.total <= 0) return undefined;
    return Math.min(100, Math.round((progress.downloaded / progress.total) * 100));
  }, [progress]);

  const progressLabel = useMemo(() => {
    if (failed) return errorMsg || t("multiplayer.install.failedHint");
    if (!progress || progress.total <= 0) return t("multiplayer.install.preparing");
    return t("multiplayer.install.progress", {
      percent: percent ?? 0,
      downloaded: formatBytes(progress.downloaded),
      total: formatBytes(progress.total),
    });
  }, [errorMsg, failed, percent, progress, t]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-xl border border-border bg-card p-6">
      <div
        className={cn(
          "flex size-16 items-center justify-center rounded-2xl",
          failed ? "bg-destructive/10" : "bg-primary/10"
        )}
      >
        {failed ? (
          <AlertCircle className="size-8 text-destructive" />
        ) : (
          <Loader2 className="size-8 animate-spin text-primary" />
        )}
      </div>
      <div className="w-full max-w-md space-y-3 text-center">
        <h2 className="text-base font-semibold text-foreground">
          {failed ? t("multiplayer.install.failedTitle") : t("multiplayer.install.title")}
        </h2>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("multiplayer.install.description")}
        </p>
        {!failed ? <Progress value={percent} className="h-2" /> : null}
        <p className={cn("text-xs", failed ? "break-all text-destructive" : "text-muted-foreground")}>
          {progressLabel}
        </p>
      </div>
      <Button variant={failed ? "default" : "outline"} size="sm" onClick={onRetry}>
        {t("multiplayer.install.retry")}
      </Button>
    </div>
  );
}

function PendingPanel({ status }: { status: "starting" | "stopping" }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-border bg-card text-muted-foreground">
      <Loader2 className="size-8 animate-spin text-primary" />
      <p className="text-sm font-medium text-foreground">
        {status === "starting"
          ? t("multiplayer.page.starting")
          : t("multiplayer.page.stopping")}
      </p>
      <p className="text-xs text-muted-foreground">{t("multiplayer.page.pleaseWait")}</p>
    </div>
  );
}

function CheckingPanel() {
  const { t } = useI18n();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-border bg-card text-muted-foreground">
      <Loader2 className="size-6 animate-spin text-primary" />
      <p className="text-sm">{t("multiplayer.page.checking")}</p>
    </div>
  );
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

const STATUS_CONFIG: Record<
  MultiplayerStatus,
  { labelKey: `multiplayer.status.${MultiplayerStatus}`; dot: string; background: string; text: string }
> = {
  idle: {
    labelKey: "multiplayer.status.idle",
    dot: "bg-muted-foreground/40",
    background: "bg-muted",
    text: "text-muted-foreground",
  },
  not_installed: {
    labelKey: "multiplayer.status.not_installed",
    dot: "bg-destructive",
    background: "bg-destructive/10",
    text: "text-destructive",
  },
  installing: {
    labelKey: "multiplayer.status.installing",
    dot: "bg-primary",
    background: "bg-primary/10",
    text: "text-primary",
  },
  installed: {
    labelKey: "multiplayer.status.installed",
    dot: "bg-emerald-500",
    background: "bg-emerald-500/10",
    text: "text-emerald-700 dark:text-emerald-400",
  },
  starting: {
    labelKey: "multiplayer.status.starting",
    dot: "bg-primary",
    background: "bg-primary/10",
    text: "text-primary",
  },
  running: {
    labelKey: "multiplayer.status.running",
    dot: "bg-green-500 animate-pulse",
    background: "bg-green-500/10",
    text: "text-green-700 dark:text-green-400",
  },
  stopping: {
    labelKey: "multiplayer.status.stopping",
    dot: "bg-orange-500",
    background: "bg-orange-500/10",
    text: "text-orange-700 dark:text-orange-400",
  },
  error: {
    labelKey: "multiplayer.status.error",
    dot: "bg-destructive",
    background: "bg-destructive/10",
    text: "text-destructive",
  },
};

function StatusBadge({ status }: { status: MultiplayerStatus }) {
  const { t } = useI18n();
  const config = STATUS_CONFIG[status];
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
        config.background,
        config.text
      )}
    >
      <span className={cn("size-1.5 rounded-full", config.dot)} />
      {t(config.labelKey)}
    </div>
  );
}
