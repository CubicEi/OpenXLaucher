"use client";

import { useEffect, useState, type ComponentType } from "react";

/**
 * 首屏完成后再挂载不影响页面操作的全局能力。
 *
 * 拖放监听和悬浮启动按钮会拉入各自的交互依赖；把它们移出关键渲染路径，
 * 能让标题栏、侧栏和当前页面更早变得可交互。超时兜底确保设备持续忙碌时
 * 这些能力也会在合理时间内加载。
 */
export function DeferredGlobalFeatures() {
  const [GlobalDragDrop, setGlobalDragDrop] =
    useState<ComponentType | null>(null);
  const [FloatingLaunchButton, setFloatingLaunchButton] =
    useState<ComponentType | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | undefined;
    let idleId: number | undefined;

    const load = () => {
      void Promise.all([
        import("./global-drag-drop"),
        import("../launch/floating-launch-button"),
      ]).then(([dragDropModule, launchButtonModule]) => {
        if (cancelled) return;
        setGlobalDragDrop(() => dragDropModule.GlobalDragDrop);
        setFloatingLaunchButton(() => launchButtonModule.FloatingLaunchButton);
      }).catch((err) => {
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

  return (
    <>
      {GlobalDragDrop && <GlobalDragDrop />}
      {FloatingLaunchButton && <FloatingLaunchButton />}
    </>
  );
}
