import { invoke } from "@tauri-apps/api/core";

import { isTauriRuntime } from "@/lib/tauri-runtime";

export type RtlLogLevel = "debug" | "info" | "warn" | "error";

export type RtlLogOptions = {
  level?: RtlLogLevel;
};

/**
 * Persistent launcher log → `<exe_dir>/OpenX/logs/launcher.log` (NDJSON, one object per line).
 * No-op outside Tauri. Prefer `warn` / `error` for user-visible failures; use `info` sparingly.
 */
export function rtlLog(
  category: string,
  message: string,
  data?: Record<string, unknown>,
  options?: RtlLogOptions,
) {
  const level = options?.level ?? "info";

  if (!isTauriRuntime()) return;

  void invoke("write_runtime_log", {
    level,
    category,
    message,
    data: data ?? null,
  }).catch(() => {});
}

export const appLog = {
  debug: (category: string, message: string, data?: Record<string, unknown>) =>
    rtlLog(category, message, data, { level: "debug" }),
  info: (category: string, message: string, data?: Record<string, unknown>) =>
    rtlLog(category, message, data, { level: "info" }),
  warn: (category: string, message: string, data?: Record<string, unknown>) =>
    rtlLog(category, message, data, { level: "warn" }),
  error: (category: string, message: string, data?: Record<string, unknown>) =>
    rtlLog(category, message, data, { level: "error" }),
};
