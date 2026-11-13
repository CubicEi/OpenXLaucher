"use client";

import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import type { DownloadTask } from "@/components/download/download-provider";
import {
  AlertCircle,
  Download,
  Globe,
  Loader2,
  RefreshCw,
  Settings,
  ShieldAlert,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useRouter } from "next/navigation";

import { useDownloadManager } from "@/components/download/download-provider";
import { useI18n } from "@/components/i18n/use-i18n";
import { MultiplayerRunningPanel } from "@/components/multiplayer/multiplayer-running-panel";
import { MultiplayerSetupPanel } from "@/components/multiplayer/multiplayer-setup-panel";
import { useMultiplayerContext } from "@/components/multiplayer/multiplayer-provider";
import type { MultiplayerStatus } from "@/components/multiplayer/multiplayer-state";
import { useMultiplayerLogPolling } from "@/components/multiplayer/use-multiplayer-log-polling";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createInAppLinkHandler,
  onInAppLinkPointerDown,
  toAppHref,
} from "@/lib/main-navigation-transition";
import type { FlyCoords } from "@/components/process-list/fly-to-process-list";
import { cn } from "@/lib/utils";

const SETTINGS_MULTIPLAYER_HREF = "/settings/multiplayer";

type DownloadSource = {
  id: string;
  label: string;
};

function isEasyTierInstallTask(task: DownloadTask): boolean {
  return (task.label?.trim() ?? "").startsWith("下载Easytier联机模块");
}

export default function MultiplayerPage() {
  const { t } = useI18n();
  const router = useRouter();
  const { tasks, startEasyTierInstall } = useDownloadManager();
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
    beginInstall,
    cancelInstall,
    failInstall,
    startAsHost,
    startAsJoin,
    stopSession,
    preparePrivileges,
    pollLog,
    clearLog,
  } = useMultiplayerContext();

  // Re-sync with backend on enter; provider keeps session across route changes.
  // Do NOT stop EasyTier on unmount — leaving /multiplayer must leave the process running.
  useEffect(() => {
    void checkStatus();
  }, [checkStatus]);

  // 进程列表取消联机下载后，勿再走 checkStatus（会保留 installing），直接复位选源页。
  useEffect(() => {
    if (status !== "installing") return;
    const easyTierTasks = tasks.filter(isEasyTierInstallTask);
    if (easyTierTasks.length === 0) return;
    const hasActive = easyTierTasks.some(
      (task) => task.status === "downloading" || task.status === "queued"
    );
    if (hasActive) return;
    if (easyTierTasks.every((task) => task.status === "cancelled")) {
      cancelInstall();
    }
  }, [cancelInstall, status, tasks]);

  useMultiplayerLogPolling(status === "running" || status === "starting", pollLog);

  const handleStartInstall = useCallback(
    async (sourceId: string, flyFrom?: FlyCoords) => {
      beginInstall();
      try {
        await startEasyTierInstall({ sourceId, flyFrom });
        await checkStatus();
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : t("multiplayer.install.failedHint");
        if (message === "已取消" || /已取消|cancelled/i.test(message)) {
          cancelInstall();
          return;
        }
        failInstall(message);
      }
    },
    [beginInstall, cancelInstall, checkStatus, failInstall, startEasyTierInstall, t]
  );

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
            installing={status === "installing"}
            onStartDownload={handleStartInstall}
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
  installing,
  onStartDownload,
}: {
  progress: { downloaded: number; total: number } | null;
  failed?: boolean;
  errorMsg?: string | null;
  installing: boolean;
  onStartDownload: (sourceId: string, flyFrom?: FlyCoords) => Promise<void>;
}) {
  const { t } = useI18n();
  const [sources, setSources] = useState<DownloadSource[]>([]);
  const [sourceId, setSourceId] = useState<string>("");
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void invoke<DownloadSource[]>("mp_list_download_sources")
      .then((list) => {
        if (cancelled) return;
        const normalized = Array.isArray(list)
          ? list
              .map((item) => ({
                id: String(item.id ?? "").trim(),
                label: String(item.label ?? item.id ?? "").trim(),
              }))
              .filter((item) => item.id)
          : [];
        setSources(normalized);
        setSourceId((prev) => prev || normalized[0]?.id || "");
        setSourcesError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setSourcesError(
          error instanceof Error ? error.message : t("multiplayer.install.sourceLoadFailed")
        );
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

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

  const busy = installing || starting;
  const canStart = Boolean(sourceId) && !busy && sources.length > 0;

  const handleClick = async (event: MouseEvent<HTMLButtonElement>) => {
    if (!canStart) return;
    const flyFrom: FlyCoords = { x: event.clientX, y: event.clientY };
    setStarting(true);
    try {
      await onStartDownload(sourceId, flyFrom);
    } finally {
      setStarting(false);
    }
  };

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
        ) : busy ? (
          <Loader2 className="size-8 animate-spin text-primary" />
        ) : (
          <Download className="size-8 text-primary" />
        )}
      </div>
      <div className="w-full max-w-md space-y-3 text-center">
        <h2 className="text-base font-semibold text-foreground">
          {failed
            ? t("multiplayer.install.failedTitle")
            : busy
              ? t("multiplayer.install.title")
              : t("multiplayer.install.readyTitle")}
        </h2>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("multiplayer.install.description")}
        </p>

        {!busy ? (
          <div className="space-y-2 text-left">
            <label className="text-xs font-medium text-foreground">
              {t("multiplayer.install.source")}
            </label>
            <Select
              value={sourceId || undefined}
              onValueChange={setSourceId}
              disabled={sources.length === 0}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t("multiplayer.install.sourcePlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {sources.map((source) => (
                  <SelectItem key={source.id} value={source.id}>
                    {source.id === "github"
                      ? t("multiplayer.install.sourceGithub")
                      : source.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {sourcesError ? (
              <p className="text-xs text-destructive">{sourcesError}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t("multiplayer.install.sourceHint")}
              </p>
            )}
          </div>
        ) : (
          <>
            <Progress value={percent} className="h-2" />
            <p className="text-xs text-muted-foreground">{progressLabel}</p>
            <p className="text-xs text-muted-foreground">
              {t("multiplayer.install.taskHint")}
            </p>
          </>
        )}

        {failed && errorMsg ? (
          <p className="break-all text-xs text-destructive">{errorMsg}</p>
        ) : null}
      </div>
      {!busy ? (
        <Button
          size="sm"
          disabled={!canStart}
          onClick={(event) => void handleClick(event)}
        >
          {failed ? t("multiplayer.install.retry") : t("multiplayer.install.startDownload")}
        </Button>
      ) : null}
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
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function StatusBadge({ status }: { status: MultiplayerStatus }) {
  const { t } = useI18n();
  const meta: Record<
    MultiplayerStatus,
    { labelKey: Parameters<typeof t>[0]; className: string }
  > = {
    idle: {
      labelKey: "multiplayer.status.idle",
      className: "bg-muted text-muted-foreground",
    },
    not_installed: {
      labelKey: "multiplayer.status.not_installed",
      className: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    },
    installing: {
      labelKey: "multiplayer.status.installing",
      className: "bg-primary/15 text-primary",
    },
    installed: {
      labelKey: "multiplayer.status.installed",
      className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    },
    starting: {
      labelKey: "multiplayer.status.starting",
      className: "bg-primary/15 text-primary",
    },
    running: {
      labelKey: "multiplayer.status.running",
      className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    },
    stopping: {
      labelKey: "multiplayer.status.stopping",
      className: "bg-muted text-muted-foreground",
    },
    error: {
      labelKey: "multiplayer.status.error",
      className: "bg-destructive/15 text-destructive",
    },
  };
  const item = meta[status];
  return (
    <span
      className={cn(
        "inline-flex h-7 items-center rounded-full px-2.5 text-xs font-medium",
        item.className
      )}
    >
      {t(item.labelKey)}
    </span>
  );
}
