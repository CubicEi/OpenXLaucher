import { useEffect, useRef } from "react";

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

export function useAnimRenderTrace(
  node: string,
  data?: Record<string, unknown>,
) {
  const countRef = useRef(0);
  countRef.current += 1;
  animTrace(node, "render", { ...data, renderCount: countRef.current });
}

export function useAnimMountTrace(
  node: string,
  deps: unknown[],
  data?: Record<string, unknown>,
) {
  const depsKey = JSON.stringify(deps);
  useEffect(() => {
    animTrace(node, "mount", { ...data, depsKey });
    return () => {
      animTrace(node, "unmount", { ...data, depsKey });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- trace keyed by serialized deps
  }, [node, depsKey]);
}

export function animMotionEvent(
  node: string,
  event: string,
  data?: Record<string, unknown>,
) {
  animTrace(node, `motion:${event}`, data);
}
