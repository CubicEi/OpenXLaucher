"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";

import { animMotionEvent } from "@/lib/animation-trace";
import { useAnimMountTrace, useAnimRenderTrace } from "@/lib/animation-trace-hooks";
import { fadeSlideUp } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { normalizeAppPathname } from "@/lib/main-navigation-transition";

/** Main column enter animation (tabs); chrome/nav stays static. Works with lightweight assign reloads. */
export function SectionContentMotion({
  segment,
  children,
  className,
}: {
  segment: string;
  children: ReactNode;
  className?: string;
}) {
  const pathname = usePathname();
  const routeKey = normalizeAppPathname(pathname);
  const node = `SectionContentMotion:${segment}`;

  useAnimRenderTrace(node, { routeKey, pathname });
  useAnimMountTrace(node, [routeKey], { routeKey });

  return (
    <motion.div
      key={routeKey}
      variants={fadeSlideUp}
      initial="initial"
      animate="animate"
      inherit={false}
      className={cn(className)}
      onAnimationStart={(definition) => {
        animMotionEvent(node, "start", { routeKey, definition: String(definition) });
      }}
      onAnimationComplete={(definition) => {
        animMotionEvent(node, "complete", { routeKey, definition: String(definition) });
      }}
    >
      {children}
    </motion.div>
  );
}
