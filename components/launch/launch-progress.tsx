"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Progress } from "@/components/ui/progress";
import { useLaunchContext } from "@/components/launch/launch-provider";
import { Loader2 } from "lucide-react";
import { fadeSlideUp } from "@/lib/motion";
import { useI18n, type TranslationKey } from "@/components/i18n/use-i18n";

const STAGE_KEYS: Record<string, TranslationKey> = {
  "JVM 启动": "launch.startingJvm",
  "加载库文件": "launch.loadingLibraries",
  "加载资源": "launch.loadingAssets",
  "初始化游戏": "launch.initializingGame",
  "加载模组": "launch.loadingMods",
  "加载世界": "launch.loadingWorld",
  "准备完成": "launch.ready",
};

/**
 * 启动进度条组件
 * 显示游戏启动过程中的实时进度
 */
export function LaunchProgress() {
  const { t } = useI18n();
  const { progress, status } = useLaunchContext();
  const isLaunching = status === "preparing" || status === "launching";
  const stageKey = progress ? STAGE_KEYS[progress.currentStage] : undefined;

  return (
    <AnimatePresence>
      {isLaunching && (
        <motion.div
          variants={fadeSlideUp}
          initial="initial"
          animate="animate"
          exit="exit"
          className="space-y-2"
        >
          {progress ? (
            <>
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <Loader2 className="size-3.5 animate-spin text-primary" />
                  <span className="font-medium text-foreground">
                    {stageKey ? t(stageKey) : progress.currentStage}
                  </span>
                </div>
                <span className="text-muted-foreground">
                  {progress.currentStep} / {progress.totalSteps}
                </span>
              </div>
              <Progress value={progress.percentage} className="h-2" />
              <div className="text-right text-[10px] text-muted-foreground">
                {Math.round(progress.percentage)}%
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2 text-xs">
              <Loader2 className="size-3.5 animate-spin text-primary" />
              <span className="font-medium text-foreground">
                {status === "preparing" ? t("launch.progress.preparing") : t("launch.progress.analyzingLaunchLogs")}
              </span>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
