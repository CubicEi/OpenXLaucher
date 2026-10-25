/** Types + helpers for the dual-task version-install session API. */

export type JavaCheckResult = {
  ok: boolean;
  javaPath?: string;
  requiredMajor: number;
  errorCode?: "JAVA_MISSING" | "JAVA_TOO_OLD" | "JAVA_INVALID" | string;
  errorMessage?: string;
};

export type CombinedSelectionInput = {
  loaderType: string;
  version: string;
};

export type VersionInstallPlanInput =
  | {
      kind: "combined";
      mcVersion: string;
      selections: CombinedSelectionInput[];
      instanceName?: string | null;
    }
  | {
      kind: "vanillaOnly";
      mcVersion: string;
      instanceName?: string | null;
    }
  | {
      kind: "singleLoader";
      loaderType: string;
      mcVersion: string;
      loaderVersion: string;
      apiVersion?: string | null;
      instanceName?: string | null;
    }
  | {
      kind: "modpack";
      zipPath: string;
    };

export type VersionInstallSessionStart = {
  sessionId: string;
  downloadTaskId: number;
  installTaskId: number;
  downloadTaskIdCompat?: number;
  displayName: string;
  javaPath?: string;
};

export type VersionInstallProgressPayload = {
  session_id: string;
  task_id: number;
  role: "download" | "install";
  percent?: number | null;
  stage: string;
  stage_label?: string;
  message?: string | null;
  speed?: number | null;
  downloaded?: number | null;
  total?: number | null;
  progress_mode: "percent" | "indeterminate";
};

export type VersionInstallFinishedPayload = {
  session_id: string;
  task_id: number;
  role: "download" | "install";
  success: boolean;
  error?: string | null;
  instance_name?: string | null;
};

export type VersionInstallSessionStartedPayload = {
  session_id: string;
  download_task_id: number;
  install_task_id: number;
  display_name: string;
  plan_kind: string;
};

const MOD_LOADER_TYPES = new Set([
  "forge",
  "neoforge",
  "fabric",
  "quilt",
  "liteloader",
]);

/** Whether the plan needs a strict Java precheck before creating UI tasks. */
export function planNeedsJava(plan: VersionInstallPlanInput): boolean {
  switch (plan.kind) {
    case "vanillaOnly":
      return false;
    case "combined":
      return plan.selections.some(
        (s) => MOD_LOADER_TYPES.has(s.loaderType) || s.loaderType === "optifine"
      );
    case "singleLoader":
      return MOD_LOADER_TYPES.has(plan.loaderType) || plan.loaderType === "optifine";
    case "modpack":
      return true;
  }
}

/** Mc version used for Java check (modpack falls back to a modern baseline). */
export function planMcVersionForJava(plan: VersionInstallPlanInput): string {
  switch (plan.kind) {
    case "combined":
    case "vanillaOnly":
    case "singleLoader":
      return plan.mcVersion;
    case "modpack":
      return "1.20.1";
  }
}

/** Strip `CODE: ` prefix from invoke Err strings for display. */
export function formatJavaInvokeError(err: unknown): string {
  const raw = String(err ?? "");
  const match = raw.match(
    /^(?:JAVA_MISSING|JAVA_TOO_OLD|JAVA_INVALID):\s*([\s\S]+)$/
  );
  if (match?.[1]) return match[1].trim();
  // Tauri often wraps as `...message...` or includes JSON; try to find the Chinese message.
  const prefixed = raw.match(
    /(JAVA_MISSING|JAVA_TOO_OLD|JAVA_INVALID):\s*([^\n"\\]+)/
  );
  if (prefixed?.[2]) return prefixed[2].trim();
  return raw;
}

export function downloadTaskLabel(displayName: string): string {
  const name = displayName.trim() || "版本";
  return `下载 ${name} 文件`;
}

export function installTaskLabel(displayName: string): string {
  const name = displayName.trim() || "版本";
  return `安装 ${name}`;
}

/**
 * Vanilla queue unlock: download task ids that should release `isDownloadingRef`
 * when their download-role finishes (canonical session has no legacy finished event).
 */
const vanillaQueueUnlockTaskIds = new Set<number>();

export function registerVanillaQueueUnlock(downloadTaskId: number) {
  vanillaQueueUnlockTaskIds.add(downloadTaskId);
}

export function consumeVanillaQueueUnlock(downloadTaskId: number): boolean {
  if (!vanillaQueueUnlockTaskIds.has(downloadTaskId)) return false;
  vanillaQueueUnlockTaskIds.delete(downloadTaskId);
  return true;
}
