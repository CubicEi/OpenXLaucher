"use client";

import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";

import { fadeSlideUp } from "@/lib/motion";
import {
  getPageTransitionKey,
  PAGE_TRANSITION_ROOT_SELECTOR,
} from "@/lib/main-navigation-transition";

interface PageTransitionProps {
  children: React.ReactNode;
}

export { PAGE_TRANSITION_ROOT_SELECTOR };

export function PageTransition({ children }: PageTransitionProps) {
  const pathname = usePathname();
  const transitionKey = getPageTransitionKey(pathname);

  return (
    <div data-page-transition-root className="h-full w-full">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={transitionKey}
          variants={fadeSlideUp}
          initial="initial"
          animate="animate"
          exit="exit"
          className="h-full w-full"
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
