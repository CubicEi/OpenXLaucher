/** Progress telemetry → `OpenX/logs/launcher.log` via `write_runtime_log`. */

import { rtlLog } from "@/lib/runtime-log";

const SESSION_ID = "ffb500";

export function progressTrace(
  hypothesisId: string,
  location: string,
  message: string,
  data: Record<string, unknown>
): void {
  // #region agent log
  rtlLog(
    "progress",
    message,
    {
      sessionId: SESSION_ID,
      hypothesisId,
      location,
      timestamp: Date.now(),
      data,
    },
    { level: "debug" }
  );
  // #endregion
}
