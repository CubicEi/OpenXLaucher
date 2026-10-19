"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useLaunchContext } from "@/components/launch/launch-provider";
import { Check, Loader2, Circle } from "lucide-react";
import { fadeSlideUp } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { useI18n } from "@/components/i18n/use-i18n";

/**
 * 启动阶段进度组件
 * 显示详细的启动阶段和各阶段完成状态
 */
export function LaunchProgressStages() {
  const { t } = useI18n();
  const { progress, status } = useLaunchContext();
  const isLaunching = status === "preparing" || status === "launching";

  const stages = [
    { id: "jvm_start", name: t("launch.startingJvm"), icon: Loader2 },
    { id: "loading_libraries", name: t("launch.loadingLibraries"), icon: Circle },
    { id: "loading_assets", name: t("launch.loadingAssets"), icon: Circle },
    { id: "initializing_game", name: t("launch.initializingGame"), icon: Circle },
    { id: "loading_mods", name: t("launch.loadingMods"), icon: Circle },
    { id: "loading_world", name: t("launch.loadingWorld"), icon: Circle },
    { id: "ready", name: t("launch.ready"), icon: Check },
  ];

  // 根据当前进度确定各阶段状态
  const getStageStatus = (index: number) => {
    if (!progress) return "pending";
    if (index < progress.currentStep - 1) return "completed";
    if (index === progress.currentStep - 1) return "active";
    return "pending";
  };

  return (
    <AnimatePresence>
      {isLaunching && (
        <motion.div
          variants={fadeSlideUp}
          initial="initial"
          animate="animate"
          exit="exit"
          className="space-y-3"
        >
          <div className="text-xs font-medium text-foreground">
            {t("launch.launchProgress")}
          </div>
          <div className="space-y-2">
            {stages.map((stage, index) => {
              const stageStatus = getStageStatus(index);
              return (
                <motion.div
                  key={stage.id}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: index * 0.05 }}
                  className={cn(
                    "flex items-center gap-2 text-xs",
                    stageStatus === "completed" && "text-muted-foreground",
                    stageStatus === "active" && "text-foreground font-medium",
                    stageStatus === "pending" && "text-muted-foreground/50"
                  )}
                >
                  <div className="flex items-center justify-center w-4 h-4">
                    {stageStatus === "completed" ? (
                      <Check className="size-3 text-green-500" />
                    ) : stageStatus === "active" ? (
                      <Loader2 className="size-3 animate-spin text-primary" />
                    ) : (
                      <Circle className="size-2" />
                    )}
                  </div>
                  <span>{stage.name}</span>
                </motion.div>
              );
            })}
          </div>
          {progress && (
            <div className="text-right text-[10px] text-muted-foreground">
              {Math.round(progress.percentage)}%
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
