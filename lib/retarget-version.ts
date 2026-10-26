const CONTEXT_KEY = "openxlauncher.retarget.context";
const PENDING_KEY = "openxlauncher.retarget.pending";

/** 内存缓存，避免 Strict Mode / 路由切换时丢失 sessionStorage 上下文 */
let memoryContext: RetargetContext | null = null;

export type RetargetContext = {
  sourceFolderName: string;
  currentMcVersion: string;
  /** vanilla | fabric | forge | … */
  currentLoaderFamily: string;
};

export type PendingRetargetInstall = {
  sessionId: string;
  sourceFolderName: string;
  targetMcVersion: string;
  selections: { loader: string; version: string }[];
};

export function setRetargetContext(ctx: RetargetContext): void {
  memoryContext = ctx;
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.setItem(CONTEXT_KEY, JSON.stringify(ctx));
}

export function getRetargetContext(): RetargetContext | null {
  if (memoryContext) return memoryContext;
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(CONTEXT_KEY);
    if (!raw) return null;
    memoryContext = JSON.parse(raw) as RetargetContext;
    return memoryContext;
  } catch {
    return null;
  }
}

export function clearRetargetContext(): void {
  memoryContext = null;
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.removeItem(CONTEXT_KEY);
}

export function setPendingRetargetInstall(pending: PendingRetargetInstall): void {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
}

export function takePendingRetargetInstall(
  sessionId: string
): PendingRetargetInstall | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingRetargetInstall;
    if (parsed.sessionId !== sessionId) return null;
    sessionStorage.removeItem(PENDING_KEY);
    return parsed;
  } catch {
    return null;
  }
}

export function isRetargetQueryMode(search: string): boolean {
  try {
    return new URLSearchParams(search).get("mode") === "retarget";
  } catch {
    return false;
  }
}
