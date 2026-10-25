import type { DownloadTask } from "@/components/download/download-provider";

const DOWNLOAD_STAGE_RE =
  /下载|download|拉取|fetch|获取文件|下载mod加载器|下载附加组件/i;
const REPLACE_STAGE_RE = /替换|replace|安装|install|合并|解压|extract|写入|校验|verify/i;

/** Active download-role tasks that contribute to overall % / speed. */
export function isDownloadMeterTask(task: DownloadTask): boolean {
  if (task.role === "install" || task.progressMode === "indeterminate") return false;
  return true;
}

/** Whether the current stage looks like an active network download. */
export function taskShowsDownloadSpeed(task: DownloadTask): boolean {
  if (task.status !== "downloading" && task.status !== "queued") return false;
  if (!isDownloadMeterTask(task)) return false;
  // Any positive measured speed counts, even during transitional stage labels.
  if (task.speedBps != null && task.speedBps > 0) return true;
  const stageText = task.stage?.trim() || task.detail?.trim();
  if (!stageText) {
    // No stage yet — assume download phase for in-flight tasks
    return task.status === "downloading";
  }
  if (REPLACE_STAGE_RE.test(stageText) && !DOWNLOAD_STAGE_RE.test(stageText)) {
    return false;
  }
  // Download-stage tasks contribute to the overall meter (0 until samples arrive).
  return DOWNLOAD_STAGE_RE.test(stageText) || task.speedBps != null;
}

/** Derive a human-readable processing stage for row 2. */
export function resolveTaskStage(task: DownloadTask): string {
  if (task.status === "queued") return "queued";
  if (task.status === "cancelled") return "cancelled";
  if (task.status === "error") return "error";
  if (task.status === "warning") return "warning";
  if (task.status === "success") return "success";

  // Prefer backend stage / stage_label (already Chinese when from version-install).
  if (task.stage?.trim()) return task.stage.trim();
  if (task.detail?.trim()) return task.detail.trim();

  // Heuristics when backend has not sent a stage yet
  const label = task.label || "";
  if (/更新/.test(label) || /update/i.test(label)) {
    const p = task.progress ?? 0;
    if (p < 80) return "download";
    return "replace";
  }
  if (task.progressMode === "indeterminate" || task.role === "install") {
    return "preparing";
  }
  if (task.progress === undefined) return "preparing";
  return "processing";
}

/** Format bytes/sec from backend `speed` / samples as B/s, KB/s, or MB/s (not Mbps). */
export function formatSpeedBps(bps: number | undefined | null): string | null {
  if (bps == null || !Number.isFinite(bps) || bps <= 0) return null;
  if (bps < 1024) return `${Math.round(bps)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(2)} MB/s`;
}

export function averageActiveProgress(tasks: DownloadTask[]): number {
  const activeDownloads = tasks.filter(
    (t) =>
      (t.status === "downloading" || t.status === "queued") && isDownloadMeterTask(t)
  );
  if (activeDownloads.length > 0) {
    const sum = activeDownloads.reduce((acc, t) => acc + (t.progress ?? 0), 0);
    return Math.min(100, Math.max(0, sum / activeDownloads.length));
  }

  // Download finished but install still running → overall meter stays at 100.
  const hasActiveInstall = tasks.some(
    (t) =>
      (t.status === "downloading" || t.status === "queued") &&
      (t.role === "install" || t.progressMode === "indeterminate")
  );
  const downloadTasks = tasks.filter((t) => isDownloadMeterTask(t));
  if (
    hasActiveInstall &&
    downloadTasks.some((t) => t.status === "success" || t.status === "warning")
  ) {
    return 100;
  }

  const finished = tasks.filter((t) => t.status === "success" || t.status === "warning");
  return finished.length > 0 && finished.length === tasks.length ? 100 : 0;
}

export function sumDownloadSpeeds(tasks: DownloadTask[]): number {
  return tasks.reduce((acc, t) => {
    if (!taskShowsDownloadSpeed(t)) return acc;
    return acc + (t.speedBps ?? 0);
  }, 0);
}
