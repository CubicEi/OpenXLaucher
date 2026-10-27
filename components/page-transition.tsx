"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";

import { animTrace } from "@/lib/animation-trace";
import { useAnimRenderTrace } from "@/lib/animation-trace-hooks";
import { fadeSlideUp } from "@/lib/motion";
import {
  getPageTransitionKey,
  normalizeAppPathname,
  PAGE_TRANSITION_ROOT_SELECTOR,
} from "@/lib/main-navigation-transition";

interface PageTransitionProps {
  children: React.ReactNode;
}

export { PAGE_TRANSITION_ROOT_SELECTOR };

export function PageTransition({ children }: PageTransitionProps) {
  const pathname = usePathname();
  const pathnameNorm = normalizeAppPathname(pathname);
  const transitionKey = getPageTransitionKey(pathname);
  /** Shared layout (/settings/*, /game-settings/*): shell key stable — skip outer motion to avoid nested AnimatePresence conflicts. */
  const sharedLayoutShell = transitionKey !== pathnameNorm;

  useAnimRenderTrace("PageTransition", {
    pathname: pathnameNorm,
    transitionKey,
    sharedLayoutShell,
    renderMode: sharedLayoutShell ? "static-shell" : "full-fade",
  });

  useEffect(() => {
    animTrace("PageTransition", "decision", {
      pathname: pathnameNorm,
      transitionKey,
      sharedLayoutShell,
      renderMode: sharedLayoutShell ? "static-shell" : "full-fade",
    });
  }, [pathnameNorm, transitionKey, sharedLayoutShell]);

  if (sharedLayoutShell) {
    return (
      <div data-page-transition-root className="h-full w-full">
        {children}
      </div>
    );
  }

  return (
    <div data-page-transition-root className="h-full w-full">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={transitionKey}
          variants={fadeSlideUp}
          initial="initial"
          animate="animate"
          exit="exit"
          inherit={false}
          className="h-full w-full"
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
