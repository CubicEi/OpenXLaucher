/** 检查到已是最新后，暂停自动检查直到用户手动触发 */
let autoUpdateCheckSuppressed = false;
let startupUpdateCheckCompleted = false;

export function isAutoUpdateCheckSuppressed(): boolean {
  return autoUpdateCheckSuppressed;
}

export function hasCompletedStartupUpdateCheck(): boolean {
  return startupUpdateCheckCompleted;
}

export function markStartupUpdateCheckCompleted(): void {
  startupUpdateCheckCompleted = true;
}

export function markUpToDateAndSuppressAutoCheck(): void {
  autoUpdateCheckSuppressed = true;
  startupUpdateCheckCompleted = true;
}

/** 用户主动点击「检查更新」时调用 */
export function resetUpdateCheckSuppression(): void {
  autoUpdateCheckSuppressed = false;
}

export function shouldRunStartupUpdateCheck(): boolean {
  return !startupUpdateCheckCompleted && !autoUpdateCheckSuppressed;
}

/** 关于页等处的自动检查应跳过（启动已检查过或用户已确认最新） */
export function shouldSkipAutomaticUpdateCheck(): boolean {
  return autoUpdateCheckSuppressed || startupUpdateCheckCompleted;
}
