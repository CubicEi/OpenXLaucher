/** 检查到已是最新或超时失败后，暂停自动检查直到用户在更新页手动触发 */
let autoUpdateCheckSuppressed = false;
let startupUpdateCheckCompleted = false;
/** 超时后仅允许在「检查更新」页面点击检查按钮恢复 */
let blockAutoCheckUntilUpdatePage = false;
let pendingUpdateCheckError: string | null = null;

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

/** 用户主动点击「检查更新」时调用（设置页等；超时封锁时无效） */
export function resetUpdateCheckSuppression(): void {
  if (blockAutoCheckUntilUpdatePage) return;
  autoUpdateCheckSuppressed = false;
  pendingUpdateCheckError = null;
}

/** 用户在「检查更新」页面点击检查按钮 */
export function resetAutoCheckFromUpdatePage(): void {
  autoUpdateCheckSuppressed = false;
  blockAutoCheckUntilUpdatePage = false;
  pendingUpdateCheckError = null;
}

export function shouldResetSuppressionOnSettingsManualCheck(): boolean {
  return !blockAutoCheckUntilUpdatePage;
}

export function markUpdateCheckTimeout(message: string): void {
  pendingUpdateCheckError = message;
  autoUpdateCheckSuppressed = true;
  startupUpdateCheckCompleted = true;
  blockAutoCheckUntilUpdatePage = true;
}

export function getPendingUpdateCheckError(): string | null {
  return pendingUpdateCheckError;
}

export function shouldRunStartupUpdateCheck(): boolean {
  return !startupUpdateCheckCompleted && !autoUpdateCheckSuppressed;
}

/** 关于页等处的自动检查应跳过（启动已检查过或用户已确认最新） */
export function shouldSkipAutomaticUpdateCheck(): boolean {
  return autoUpdateCheckSuppressed || startupUpdateCheckCompleted;
}
