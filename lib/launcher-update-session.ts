const SESSION_STORAGE_KEY = "openx-launcher-update-session";

type PersistedUpdateSession = {
  autoUpdateCheckSuppressed?: boolean;
  startupUpdateCheckCompleted?: boolean;
  startupUpdatePromptDismissed?: boolean;
  dismissedPromptTargetVersions?: string[];
  blockAutoCheckUntilUpdatePage?: boolean;
  pendingUpdateCheckError?: string | null;
};

/** 检查到已是最新或超时失败后，暂停自动检查直到用户在更新页手动触发 */
let autoUpdateCheckSuppressed = false;
let startupUpdateCheckCompleted = false;
/** 启动更新弹窗点「稍后再说」或关闭后，本次浏览器会话内不再对同一目标版本自动弹出 */
let startupUpdatePromptDismissed = false;
const dismissedPromptTargetVersions = new Set<string>();
/** 超时后仅允许在「检查更新」页面点击检查按钮恢复 */
let blockAutoCheckUntilUpdatePage = false;
let pendingUpdateCheckError: string | null = null;

function readPersistedSession(): PersistedUpdateSession {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as PersistedUpdateSession;
  } catch {
    return {};
  }
}

function writePersistedSession(patch: Partial<PersistedUpdateSession>): void {
  if (typeof window === "undefined") return;
  const next: PersistedUpdateSession = { ...readPersistedSession(), ...patch };
  if (next.dismissedPromptTargetVersions) {
    next.dismissedPromptTargetVersions = [...new Set(next.dismissedPromptTargetVersions)];
  }
  try {
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 存储满或隐私模式 — 仅依赖内存
  }
}

function persistFromMemory(): void {
  writePersistedSession({
    autoUpdateCheckSuppressed,
    startupUpdateCheckCompleted,
    startupUpdatePromptDismissed,
    dismissedPromptTargetVersions: [...dismissedPromptTargetVersions],
    blockAutoCheckUntilUpdatePage,
    pendingUpdateCheckError,
  });
}

function hydrateFromSessionStorage(): void {
  const stored = readPersistedSession();
  if (stored.autoUpdateCheckSuppressed) autoUpdateCheckSuppressed = true;
  if (stored.startupUpdateCheckCompleted) startupUpdateCheckCompleted = true;
  if (stored.startupUpdatePromptDismissed) startupUpdatePromptDismissed = true;
  if (stored.blockAutoCheckUntilUpdatePage) blockAutoCheckUntilUpdatePage = true;
  if (typeof stored.pendingUpdateCheckError === "string") {
    pendingUpdateCheckError = stored.pendingUpdateCheckError;
  }
  for (const v of stored.dismissedPromptTargetVersions ?? []) {
    if (v.trim()) dismissedPromptTargetVersions.add(v.trim());
  }
}

if (typeof window !== "undefined") {
  hydrateFromSessionStorage();
}

export function isAutoUpdateCheckSuppressed(): boolean {
  return autoUpdateCheckSuppressed;
}

export function hasCompletedStartupUpdateCheck(): boolean {
  return startupUpdateCheckCompleted;
}

export function markStartupUpdateCheckCompleted(): void {
  startupUpdateCheckCompleted = true;
  persistFromMemory();
}

export function markUpToDateAndSuppressAutoCheck(): void {
  autoUpdateCheckSuppressed = true;
  startupUpdateCheckCompleted = true;
  persistFromMemory();
}

/** 用户主动点击「检查更新」时调用（设置页等；超时封锁时无效） */
export function resetUpdateCheckSuppression(): void {
  if (blockAutoCheckUntilUpdatePage) return;
  autoUpdateCheckSuppressed = false;
  pendingUpdateCheckError = null;
  persistFromMemory();
}

/** 用户在「检查更新」页面点击检查按钮 */
export function resetAutoCheckFromUpdatePage(): void {
  autoUpdateCheckSuppressed = false;
  blockAutoCheckUntilUpdatePage = false;
  pendingUpdateCheckError = null;
  persistFromMemory();
}

export function shouldResetSuppressionOnSettingsManualCheck(): boolean {
  return !blockAutoCheckUntilUpdatePage;
}

export function markUpdateCheckTimeout(message: string): void {
  pendingUpdateCheckError = message;
  autoUpdateCheckSuppressed = true;
  startupUpdateCheckCompleted = true;
  blockAutoCheckUntilUpdatePage = true;
  persistFromMemory();
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

/** 是否仍可展示启动时的「有新版本」弹窗（关闭启动器后 sessionStorage 会清空） */
export function shouldShowStartupUpdatePrompt(targetVersion?: string | null): boolean {
  const version = targetVersion?.trim();
  if (version && dismissedPromptTargetVersions.has(version)) {
    return false;
  }
  if (startupUpdatePromptDismissed && !version) {
    return false;
  }
  return true;
}

/** 用户选择稍后再说或关闭启动更新弹窗 */
export function markStartupUpdatePromptDismissed(targetVersion?: string | null): void {
  startupUpdatePromptDismissed = true;
  const version = targetVersion?.trim();
  if (version) {
    dismissedPromptTargetVersions.add(version);
  }
  persistFromMemory();
}

function resetInMemorySessionState(): void {
  autoUpdateCheckSuppressed = false;
  startupUpdateCheckCompleted = false;
  startupUpdatePromptDismissed = false;
  dismissedPromptTargetVersions.clear();
  blockAutoCheckUntilUpdatePage = false;
  pendingUpdateCheckError = null;
}

/** @internal 单测用 */
export function __resetLauncherUpdateSessionForTests(): void {
  resetInMemorySessionState();
  if (typeof window !== "undefined") {
    window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
  }
}

/** @internal 模拟整页刷新后从 sessionStorage 恢复 */
export function __hydrateLauncherUpdateSessionForTests(): void {
  resetInMemorySessionState();
  hydrateFromSessionStorage();
}
