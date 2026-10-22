import { invoke } from "@tauri-apps/api/core";

import { isTauriRuntime } from "@/lib/tauri-runtime";

export type RtlLogLevel = "debug" | "info" | "warn" | "error";

export type RtlLogOptions = {
  level?: RtlLogLevel;
};

const LEVEL_LABEL: Record<RtlLogLevel, string> = {
  debug: "INFO",
  info: "INFO",
  warn: "WARN",
  error: "ERROR",
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Local system time with second precision (`YYYY-MM-DD HH:MM:SS`). */
export function formatLocalTimestamp(date = new Date()): string {
  const y = date.getFullYear();
  const mo = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  const h = pad2(date.getHours());
  const mi = pad2(date.getMinutes());
  const s = pad2(date.getSeconds());
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}

export function buildLogBody(
  category: string,
  message: string,
  data?: Record<string, unknown>,
): string {
  const main = category ? `${category}/${message}` : message;
  if (!data || Object.keys(data).length === 0) return main;
  try {
    return `${main} ${JSON.stringify(data)}`;
  } catch {
    return main;
  }
}

/** `[系统时间 INFO/WARN/ERROR/PANIC] 用户操作/结果` */
export function formatRuntimeLogLine(
  level: RtlLogLevel,
  category: string,
  message: string,
  data?: Record<string, unknown>,
  now = new Date(),
): string {
  const body = buildLogBody(category, message, data);
  return `[${formatLocalTimestamp(now)} ${LEVEL_LABEL[level]}] ${body}`;
}

function mirrorToConsole(level: RtlLogLevel, line: string): void {
  switch (level) {
    case "warn":
      console.warn(line);
      break;
    case "error":
      console.error(line);
      break;
    default:
      console.log(line);
  }
}

/**
 * Persistent launcher log → `<exe_dir>/OpenX/logs/launcher.log` (one formatted line per entry).
 * No-op outside Tauri. Prefer `warn` / `error` for user-visible failures; use `info` sparingly.
 */
export function rtlLog(
  category: string,
  message: string,
  data?: Record<string, unknown>,
  options?: RtlLogOptions,
) {
  const level = options?.level ?? "info";
  const line = formatRuntimeLogLine(level, category, message, data);

  if (process.env.NODE_ENV === "development") {
    mirrorToConsole(level, line);
  }

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
