import { appLog } from "@/lib/runtime-log";

/** 用户点击启动 → 拼好参数并 spawn MC 的流程步骤（写入 launcher.log）。 */
export function launchTrace(
  step: string,
  message: string,
  data?: Record<string, unknown>,
) {
  appLog.info("launch", message, { step, ...data });
}

export function launchTraceWarn(
  step: string,
  message: string,
  data?: Record<string, unknown>,
) {
  appLog.warn("launch", message, { step, ...data });
}

export function launchTraceError(
  step: string,
  message: string,
  data?: Record<string, unknown>,
) {
  appLog.error("launch", message, { step, ...data });
}
