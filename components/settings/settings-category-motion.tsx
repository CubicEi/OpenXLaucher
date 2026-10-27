"use client";

import type { ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { fadeSlideUp } from "@/lib/motion";

/** Settings tab enter/exit; always mounts children with the keyed motion layer (safe in Tauri static export). */
export function SettingsCategoryMotion({
  routeKey,
  children,
}: {
  routeKey: string;
  children: ReactNode;
}) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={routeKey}
        variants={fadeSlideUp}
        initial="initial"
        animate="animate"
        exit="exit"
        inherit={false}
        className="space-y-4"
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
