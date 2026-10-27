"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { motion } from "framer-motion";

import { fadeSlideUp } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** Enter animation for shared-layout sub-routes (settings tabs, game-settings tabs). */
export function SharedSectionEnter({
  children,
  className,
  debugSegment,
}: {
  children: ReactNode;
  className?: string;
  debugSegment?: string;
}) {
  const mountIdRef = useRef(Math.random().toString(36).slice(2, 9));

  useEffect(() => {
    // #region agent log
    fetch("http://127.0.0.1:7931/ingest/39fb5222-8319-46c5-a5ae-7bfa2ec61c80", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "966db3" },
      body: JSON.stringify({
        sessionId: "966db3",
        hypothesisId: "H1",
        location: "shared-section-enter.tsx:mount",
        message: "SharedSectionEnter mounted",
        data: {
          segment: debugSegment,
          mountId: mountIdRef.current,
          pathname: typeof window !== "undefined" ? window.location.pathname : "",
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    return () => {
      // #region agent log
      fetch("http://127.0.0.1:7931/ingest/39fb5222-8319-46c5-a5ae-7bfa2ec61c80", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "966db3" },
        body: JSON.stringify({
          sessionId: "966db3",
          hypothesisId: "H1",
          location: "shared-section-enter.tsx:unmount",
          message: "SharedSectionEnter unmounted",
          data: { segment: debugSegment, mountId: mountIdRef.current },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
    };
  }, [debugSegment]);

  return (
    <motion.div
      variants={fadeSlideUp}
      initial="initial"
      animate="animate"
      inherit={false}
      className={cn(className)}
      onAnimationStart={(definition) => {
        // #region agent log
        fetch("http://127.0.0.1:7931/ingest/39fb5222-8319-46c5-a5ae-7bfa2ec61c80", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "966db3" },
          body: JSON.stringify({
            sessionId: "966db3",
            hypothesisId: "H2",
            location: "shared-section-enter.tsx:onAnimationStart",
            message: "fadeSlideUp animation started",
            data: {
              segment: debugSegment,
              mountId: mountIdRef.current,
              definition: String(definition),
            },
            timestamp: Date.now(),
          }),
        }).catch(() => {});
        // #endregion
      }}
    >
      {children}
    </motion.div>
  );
}
