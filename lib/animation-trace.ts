import { appLog } from "@/lib/runtime-log";

const CATEGORY = "anim-trace";

/** Persistent log → OpenX/logs/launcher.log (Tauri); dev mirrors to console. */
export function animTrace(
  node: string,
  phase: string,
  data?: Record<string, unknown>,
) {
  appLog.info(CATEGORY, `${node}/${phase}`, data);
}

export function animMotionEvent(
  node: string,
  event: string,
  data?: Record<string, unknown>,
) {
  animTrace(node, `motion:${event}`, data);
}
