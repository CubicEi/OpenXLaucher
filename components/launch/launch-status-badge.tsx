"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { fadeIn } from "@/lib/motion";
import {
  Circle,
  Loader2,
  Play,
  AlertCircle,
  Square,
} from "lucide-react";
import type { LaunchStatus } from "@/types";
import { useI18n, type TranslationKey } from "@/components/i18n/use-i18n";

const statusConfig: Record<
  LaunchStatus,
  { label: TranslationKey; icon: React.ReactNode; color: string }
> = {
  idle: {
    label: "launch.status.ready",
    icon: <Circle className="size-3" />,
    color: "text-muted-foreground",
  },
  preparing: {
    label: "launch.status.preparing",
    icon: <Loader2 className="size-3 animate-spin" />,
    color: "text-blue-500",
  },
  launching: {
    label: "launch.status.launching",
    icon: <Loader2 className="size-3 animate-spin" />,
    color: "text-amber-500",
  },
  running: {
    label: "launch.status.running",
    icon: <Play className="size-3" />,
    color: "text-green-500",
  },
  stopped: {
    label: "launch.status.stopped",
    icon: <Square className="size-3" />,
    color: "text-muted-foreground",
  },
  error: {
    label: "launch.status.error",
    icon: <AlertCircle className="size-3" />,
    color: "text-destructive",
  },
};

interface LaunchStatusBadgeProps {
  status: LaunchStatus;
  className?: string;
}

export function LaunchStatusBadge({ status, className }: LaunchStatusBadgeProps) {
  const { t } = useI18n();
  const cfg = statusConfig[status];
  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5 overflow-hidden", cfg.color, className)}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={status}
          variants={fadeIn}
          initial="initial"
          animate="animate"
          exit="exit"
          className="flex items-center gap-1.5"
        >
          {cfg.icon}
          {t(cfg.label)}
        </motion.span>
      </AnimatePresence>
    </Badge>
  );
}
