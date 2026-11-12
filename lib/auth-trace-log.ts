import { appLog } from "@/lib/runtime-log";

/** 登录鉴权子阶段 → launcher.log（category: auth） */
export function authTrace(
  flow: string,
  step: string,
  message: string,
  data?: Record<string, unknown>,
) {
  appLog.info("auth", message, { flow, step, ...data });
}

export function authTraceWarn(
  flow: string,
  step: string,
  message: string,
  data?: Record<string, unknown>,
) {
  appLog.warn("auth", message, { flow, step, ...data });
}

export function authTraceError(
  flow: string,
  step: string,
  message: string,
  data?: Record<string, unknown>,
) {
  appLog.error("auth", message, { flow, step, ...data });
}
