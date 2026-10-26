"use client";

import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertCircle,
  ArrowLeft,
  Ban,
  CheckCircle2,
  Clock,
  Loader2,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  useDownloadManager,
  type DownloadTask,
} from "@/components/download/download-provider";
import { useI18n, type TranslationKey } from "@/components/i18n/use-i18n";
import { fadeSlideUp, staggerContainer, staggerItem } from "@/lib/motion";
import {
  averageActiveProgress,
  formatSpeedBps,
  isInstallTask,
  isInstallTaskActive,
  resolveTaskStage,
  sumDownloadSpeeds,
  taskShowsDownloadSpeed,
} from "./task-utils";

function stageLabel(
  task: DownloadTask,
  t: (key: TranslationKey, values?: Record<string, string | number>) => string
): string {
  const stage = resolveTaskStage(task);
  switch (stage) {
    case "queued":
      return t("processList.stage.queued");
    case "cancelled":
      return t("processList.stage.cancelled");
    case "error":
      return task.error || t("processList.stage.error");
    case "warning":
      return task.failedCount
        ? t("processList.stage.warningFailed", { count: task.failedCount })
        : t("processList.stage.warning");
    case "success":
      return t("processList.stage.success");
    case "download":
      return t("processList.stage.download");
    case "replace":
      return t("processList.stage.replace");
    case "preparing":
      return t("processList.stage.preparing");
    case "processing":
      return t("processList.stage.processing");
    default:
      // Backend Chinese stage_label / stage text — show as-is.
      return stage;
  }
}

/**
 * Install-task indeterminate bar.
 * Pure CSS — do NOT use framer-motion here: parent TaskCard is a motion node with
 * staggerItem variants (`animate="animate"`), which inherits into child motion.div
 * and silently kills left/width keyframe animations.
 */
function IndeterminateProgressBar({ className }: { className?: string }) {
  return (
    <div
      className={`relative h-1.5 w-full overflow-hidden rounded-full bg-secondary ${className ?? ""}`}
      role="progressbar"
      aria-valuetext="indeterminate"
    >
      <div className="install-progress-indeterminate-bar" aria-hidden />
    </div>
  );
}

function StatusIcon({ status }: { status: DownloadTask["status"] }) {
  switch (status) {
    case "queued":
      return <Clock className="size-3.5 shrink-0 text-muted-foreground" />;
    case "downloading":
      return <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />;
    case "success":
      return <CheckCircle2 className="size-3.5 shrink-0 text-green-500" />;
    case "warning":
      return <AlertCircle className="size-3.5 shrink-0 text-amber-500" />;
    case "error":
      return <XCircle className="size-3.5 shrink-0 text-destructive" />;
    case "cancelled":
      return <Ban className="size-3.5 shrink-0 text-muted-foreground" />;
    default:
      return null;
  }
}

function TaskCard({
  task,
  onRemove,
  onCancel,
}: {
  task: DownloadTask;
  onRemove: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  // Progress branch (strict order):
  // 1) install waiting/running → sliding indeterminate bar (never Progress)
  // 2) install terminal → full (success/warning) or empty (error/cancelled)
  // 3) download / other → percent Progress
  const install = isInstallTask(task);
  const installActive = isInstallTaskActive(task);
  const showSpeed = !install && taskShowsDownloadSpeed(task);
  const speedText = showSpeed ? formatSpeedBps(task.speedBps) : null;
  const percentText = install
    ? null
    : task.progress !== undefined
      ? `${task.progress.toFixed(1)}%`
      : "—";
  const canCancel = task.status === "queued" || task.status === "downloading";
  const canRemove = !canCancel;

  let progressRow: ReactNode;
  if (install && installActive) {
    progressRow = <IndeterminateProgressBar />;
  } else if (install) {
    progressRow = (
      <Progress
        value={
          task.status === "success" || task.status === "warning" ? 100 : 0
        }
        className="h-1.5"
      />
    );
  } else {
    progressRow = (
      <Progress
        value={
          task.status === "success" || task.status === "warning"
            ? 100
            : task.progress
        }
        className="h-1.5"
      />
    );
  }

  return (
    <motion.div
      variants={staggerItem}
      initial="initial"
      animate="animate"
      exit={{ opacity: 0, y: -8, transition: { duration: 0.15 } }}
      className="rounded-xl border border-border bg-card/80 px-4 py-3 shadow-sm"
    >
      {/* Row 1: name · speed + percent */}
      <div className="flex min-w-0 items-center gap-2">
        <StatusIcon status={task.status} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{task.label}</span>
        <div className="flex shrink-0 items-center gap-2 text-xs tabular-nums text-muted-foreground">
          {speedText && <span>{speedText}</span>}
          {percentText != null && <span>{percentText}</span>}
          {canCancel && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-6"
              onClick={onCancel}
              title={t("processList.cancelTask")}
              aria-label={t("processList.cancelTask")}
            >
              <X className="size-3.5" />
            </Button>
          )}
          {canRemove && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-6"
              onClick={onRemove}
              title={t("processList.removeTask")}
              aria-label={t("processList.removeTask")}
            >
              <X className="size-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Row 2: stage — prefer backend stage text */}
      <p className="mt-1.5 truncate pl-5 text-xs text-muted-foreground/80">
        {stageLabel(task, t)}
      </p>

      {/* Row 3: progress */}
      <div className="mt-2 pl-5">{progressRow}</div>
    </motion.div>
  );
}

export function ProcessListView() {
  const router = useRouter();
  const { t } = useI18n();
  const { tasks, clearFinished, removeTask, cancelDownload } = useDownloadManager();

  const activeCount = tasks.filter(
    (task) => task.status === "downloading" || task.status === "queued"
  ).length;
  const finishedCount = tasks.length - activeCount;
  const overallProgress = averageActiveProgress(tasks);
  const overallSpeed = sumDownloadSpeeds(tasks);
  const overallSpeedText = formatSpeedBps(overallSpeed);

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      {/* Left ~1/4 summary — vertical total progress fill (bottom → top) */}
      <aside className="relative flex w-1/4 min-w-[200px] max-w-xs shrink-0 flex-col overflow-hidden border-r border-border">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 bg-[color-mix(in_oklab,var(--primary)_16%,white)] transition-[height] duration-500 ease-out dark:bg-[color-mix(in_oklab,var(--primary)_20%,black)]"
          style={{ height: `${overallProgress}%` }}
        />

        <div className="relative z-10 flex h-full flex-col gap-4 p-5">
          <div className="flex items-start gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="mt-0.5 shrink-0"
              onClick={() => router.back()}
              aria-label={t("common.back")}
              title={t("common.back")}
            >
              <ArrowLeft className="size-4" />
            </Button>
            <div className="min-w-0">
              <h1 className="text-lg font-semibold tracking-tight">
                {t("processList.title")}
              </h1>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("processList.subtitle")}
              </p>
            </div>
          </div>

          <div className="mt-auto space-y-4 rounded-xl border border-border bg-card/80 p-4 shadow-sm">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {t("processList.overallSpeed")}
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">
                {overallSpeedText ?? t("processList.speedIdle")}
              </p>
            </div>
            <div>
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  {t("processList.overallProgress")}
                </p>
                <p className="text-sm font-medium tabular-nums">
                  {overallProgress.toFixed(1)}%
                </p>
              </div>
              <Progress value={overallProgress} className="mt-2 h-2" />
            </div>
            <p className="text-xs text-muted-foreground">
              {activeCount > 0
                ? t("processList.activeCount", { count: activeCount })
                : t("processList.noActive")}
            </p>
          </div>
        </div>
      </aside>

      {/* Right ~3/4 task cards */}
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
          <p className="text-sm text-muted-foreground">
            {t("processList.taskCount", { count: tasks.length })}
          </p>
          <AnimatePresence>
            {finishedCount > 0 && (
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1.5 text-xs"
                  onClick={clearFinished}
                >
                  <Trash2 className="size-3.5" />
                  {t("processList.clearFinished")}
                </Button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {tasks.length === 0 ? (
            <motion.div
              variants={fadeSlideUp}
              initial="initial"
              animate="animate"
              className="flex h-full min-h-[240px] flex-col items-center justify-center gap-2 text-center"
            >
              <p className="text-sm font-medium text-foreground/80">
                {t("processList.emptyTitle")}
              </p>
              <p className="max-w-sm text-xs text-muted-foreground">
                {t("processList.emptyHint")}
              </p>
            </motion.div>
          ) : (
            <motion.div
              variants={staggerContainer}
              initial="initial"
              animate="animate"
              className="flex flex-col gap-3"
            >
              <AnimatePresence initial={false}>
                {tasks.map((task) => (
                  <TaskCard
                    key={task.clientId}
                    task={task}
                    onRemove={() => removeTask(task.taskId)}
                    onCancel={() => void cancelDownload(task.taskId)}
                  />
                ))}
              </AnimatePresence>
            </motion.div>
          )}
        </div>
      </section>
    </div>
  );
}
