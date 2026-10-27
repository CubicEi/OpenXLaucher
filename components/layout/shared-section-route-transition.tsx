"use client";

import type { ReactNode } from "react";
import { useRef } from "react";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";

import { appLog } from "@/lib/runtime-log";
import { fadeSlideUp } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { normalizeAppPathname } from "@/lib/main-navigation-transition";

/** Tab/category switches inside a persistent layout — pathname-keyed enter/exit. */
export function SharedSectionRouteTransition({
  children,
  className,
  debugSegment,
}: {
  children: ReactNode;
  className?: string;
  debugSegment?: string;
}) {
  const routeKey = normalizeAppPathname(usePathname());
  const mountIdRef = useRef(Math.random().toString(36).slice(2, 9));

  const logAnim = (message: string, hypothesisId: string, extra?: Record<string, unknown>) => {
    const data = {
      segment: debugSegment,
      routeKey,
      mountId: mountIdRef.current,
      ...extra,
    };
    appLog.info("anim-debug", message, data);
    // #region agent log
    fetch("http://127.0.0.1:7931/ingest/39fb5222-8319-46c5-a5ae-7bfa2ec61c80", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "966db3" },
      body: JSON.stringify({
        sessionId: "966db3",
        hypothesisId,
        location: "shared-section-route-transition.tsx",
        message,
        data,
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
  };

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={routeKey}
        variants={fadeSlideUp}
        initial="initial"
        animate="animate"
        exit="exit"
        inherit={false}
        className={cn(className)}
        onAnimationStart={(definition) => {
          logAnim("route transition animation start", "H2", { definition: String(definition) });
        }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
