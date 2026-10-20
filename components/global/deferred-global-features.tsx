"use client";

import { useEffect, useState, type ComponentType } from "react";

/**
 * 首屏完成后再挂载不影响页面操作的全局能力（如整合包拖放）。
 */
export function DeferredGlobalFeatures() {
  const [GlobalDragDrop, setGlobalDragDrop] = useState<ComponentType | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | undefined;
    let idleId: number | undefined;

    const load = () => {
      void import("./global-drag-drop")
        .then((dragDropModule) => {
          if (cancelled) return;
          setGlobalDragDrop(() => dragDropModule.GlobalDragDrop);
        })
        .catch((err) => {
          if (!cancelled) {
            console.error("Failed to load deferred global features", err);
          }
        });
    };

    if (window.requestIdleCallback) {
      idleId = window.requestIdleCallback(load, { timeout: 800 });
    } else {
      timeoutId = window.setTimeout(load, 0);
    }

    return () => {
      cancelled = true;
      if (idleId !== undefined) window.cancelIdleCallback?.(idleId);
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, []);

  return GlobalDragDrop ? <GlobalDragDrop /> : null;
}
