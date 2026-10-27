"use client";

import { Layers, Loader2, Play, Square } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { motion } from "framer-motion";

import { useLaunchContext } from "@/components/launch/launch-provider";
import { SELECT_VERSION_PATH } from "@/components/launch/version-selector-panel";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useI18n } from "@/components/i18n/use-i18n";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import {
  navigateWithMainTransition,
  normalizeAppPathname,
} from "@/lib/main-navigation-transition";

export function SidebarLaunchButton() {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const { status, launchGame, cancelLaunch } = useLaunchContext();

  const isLaunching = status === "preparing" || status === "launching";
  const isRunning = status === "running";
  const isSelectVersionActive =
    normalizeAppPathname(pathname) === normalizeAppPathname(SELECT_VERSION_PATH);

  const handlePrimaryClick = () => {
    if (isLaunching || isRunning) {
      void cancelLaunch();
      return;
    }
    void launchGame();
  };

  const handleSelectVersionClick = () => {
    if (isSelectVersionActive) return;
    navigateWithMainTransition(router, SELECT_VERSION_PATH);
  };

  return (
    <div className="relative flex flex-col items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={t("launch.launchGame")}
            className={cn(
              buttonVariants({ variant: "ghost", size: "icon" }),
              "relative size-9 touch-manipulation"
            )}
            onClick={handlePrimaryClick}
          >
            {isLaunching ? (
              <Loader2 className="size-4 animate-spin text-primary" />
            ) : isRunning ? (
              <Square className="size-4 text-green-600" />
            ) : (
              <Play className="size-4 text-primary" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">
          <p>{isRunning ? t("launch.stopGame") : t("launch.launchGame")}</p>
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={t("launch.versionSelector.selectAGameVersion")}
            aria-current={isSelectVersionActive ? "page" : undefined}
            className={cn(
              buttonVariants({ variant: "ghost", size: "icon" }),
              "relative size-7 touch-manipulation overflow-hidden",
              isSelectVersionActive
                ? "text-accent-foreground"
                : "text-muted-foreground"
            )}
            onClick={handleSelectVersionClick}
          >
            {isSelectVersionActive && (
              <motion.span
                layoutId="active-nav-indicator"
                className="absolute inset-0 rounded-md bg-accent"
                transition={{ type: "spring", stiffness: 380, damping: 30 }}
              />
            )}
            <span className="relative z-10">
              <Layers className="size-3.5" />
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">
          <p>{t("launch.versionSelector.selectAGameVersion")}</p>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
