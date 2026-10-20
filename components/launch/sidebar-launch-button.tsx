"use client";

import { useState } from "react";
import { ChevronDown, Loader2, Play, Square } from "lucide-react";

import { useLaunchContext } from "@/components/launch/launch-provider";
import { VersionSelectorDialog } from "@/components/launch/version-selector-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useI18n } from "@/components/i18n/use-i18n";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";

export function SidebarLaunchButton() {
  const { t } = useI18n();
  const { status, launchGame, cancelLaunch } = useLaunchContext();
  const [versionOpen, setVersionOpen] = useState(false);

  const isLaunching = status === "preparing" || status === "launching";
  const isRunning = status === "running";

  const handlePrimaryClick = () => {
    if (isLaunching || isRunning) {
      void cancelLaunch();
      return;
    }
    void launchGame();
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
            className={cn(
              buttonVariants({ variant: "ghost", size: "icon" }),
              "size-7 touch-manipulation text-muted-foreground"
            )}
            onClick={() => setVersionOpen(true)}
          >
            <ChevronDown className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">
          <p>{t("launch.versionSelector.selectAGameVersion")}</p>
        </TooltipContent>
      </Tooltip>

      <VersionSelectorDialog
        open={versionOpen}
        onOpenChange={setVersionOpen}
        compact
      />
    </div>
  );
}
