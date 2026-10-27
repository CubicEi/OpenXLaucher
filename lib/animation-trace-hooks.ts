"use client";

import { useEffect, useRef } from "react";

import { animTrace } from "@/lib/animation-trace";

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
