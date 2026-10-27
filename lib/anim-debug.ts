/** Debug-session probe for page enter animations (settings / game-settings tabs). */

type AnimProbe = {
  sessionId: string;
  hypothesisId: string;
  location: string;
  message: string;
  data?: Record<string, unknown>;
  timestamp: number;
};

const SESSION = "966db3";
const INGEST =
  "http://127.0.0.1:7931/ingest/39fb5222-8319-46c5-a5ae-7bfa2ec61c80";

declare global {
  interface Window {
    __OXL_ANIM_PROBES__?: AnimProbe[];
  }
}

export function animProbe(
  hypothesisId: string,
  location: string,
  message: string,
  data?: Record<string, unknown>,
) {
  const entry: AnimProbe = {
    sessionId: SESSION,
    hypothesisId,
    location,
    message,
    data,
    timestamp: Date.now(),
  };

  if (typeof window !== "undefined") {
    window.__OXL_ANIM_PROBES__ = window.__OXL_ANIM_PROBES__ ?? [];
    window.__OXL_ANIM_PROBES__.push(entry);
    // Keep last 80 entries
    if (window.__OXL_ANIM_PROBES__.length > 80) {
      window.__OXL_ANIM_PROBES__.splice(0, window.__OXL_ANIM_PROBES__.length - 80);
    }
    try {
      console.info(`[anim-probe][${hypothesisId}] ${message}`, data ?? {});
    } catch {
      /* ignore */
    }
  }

  // #region agent log
  fetch(INGEST, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": SESSION,
    },
    body: JSON.stringify(entry),
  }).catch(() => {});
  // #endregion
}
