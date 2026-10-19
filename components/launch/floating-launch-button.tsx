"use client";

import { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { ChevronUp, Loader2, Play, Square } from "lucide-react";
import { useLaunchContext } from "@/components/launch/launch-provider";
import { VersionSelectorDialog } from "@/components/launch/version-selector-dialog";
import { LaunchProgress } from "@/components/launch/launch-progress";
import { LaunchProgressStages } from "@/components/launch/launch-progress-stages";
import { useI18n } from "@/components/i18n/use-i18n";

/**
 * 全局悬浮启动按钮组件
 * 特点：
 * - 超小尺寸，仅保留核心功能
 * - 区分长按(移动)和点击(缩放)
 * - 全局显示，所有页面可见
 * - 实时显示游戏状态
 */
const LONG_PRESS_MS = 300;      // 长按阈值
const DRAG_THRESHOLD_PX = 6;    // 鼠标移动多少像素视为拖动

export function FloatingLaunchButton() {
  const { t } = useI18n();
  const { config, status, launchGame, cancelLaunch } = useLaunchContext();
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [isMinimized, setIsMinimized] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  // 长按 / 点击 区分
  const pressStartPos = useRef<{ x: number; y: number } | null>(null);
  const pressStartTime = useRef<number>(0);
  const longPressFired = useRef<boolean>(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isLaunching = status === "preparing" || status === "launching";
  const isRunning = status === "running";
  const canLaunch = !isLaunching && !isRunning;

  const displayName = (
    config.loadName ||
    config.versionName ||
    t("launch.noVersionSelected")
  );

  // 初始化位置：横轴 1/2、纵轴 1/3（按钮初始为收起态 60×60，居中放置）
  useEffect(() => {
    const BTN_SIZE = 60;
    setPosition({
      x: window.innerWidth / 2 - BTN_SIZE / 2,
      y: window.innerHeight / 3 - BTN_SIZE / 2,
    });
  }, []);

  // 清理计时器
  useEffect(() => {
    return () => {
      if (longPressTimer.current) {
        clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
      }
    };
  }, []);

  // 拖动期间禁用全局文本选择，避免鼠标扫过页面文字时产生选中
  useEffect(() => {
    if (!isDragging) return;
    const prevUserSelect = document.body.style.userSelect;
    const prevWebkitUserSelect = document.body.style.webkitUserSelect;
    document.body.style.userSelect = "none";
    document.body.style.webkitUserSelect = "none";
    return () => {
      document.body.style.userSelect = prevUserSelect;
      document.body.style.webkitUserSelect = prevWebkitUserSelect;
    };
  }, [isDragging]);

  const handleLaunch = () => {
    if (isLaunching || isRunning) {
      cancelLaunch();
    } else {
      launchGame();
    }
  };

  // 鼠标按下 — 开始区分长按 vs 点击
  // 只在点击容器空白区域（不是按钮/选择器等子元素）时启用
  const handleMouseDown = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;

    // 如果点击的是按钮、输入框、选择器等有交互功能的子元素 → 不启用长按/点击切换
    const isInteractiveChild = (
      target.closest("button") ||
      target.closest("input") ||
      target.closest("[role='button']") ||
      target.closest("[data-no-drag='true']")
    );
    if (isInteractiveChild) {
      return;
    }

    // 阻止默认行为，避免鼠标按下后浏览器启动文本选择（拖动时会扫过页面文字）
    e.preventDefault();

    pressStartPos.current = { x: e.clientX, y: e.clientY };
    pressStartTime.current = Date.now();
    longPressFired.current = false;

    setDragOffset({
      x: e.clientX - position.x,
      y: e.clientY - position.y,
    });

    // 启动长按计时器
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      setIsDragging(true);
    }, LONG_PRESS_MS);
  };

  // 鼠标移动 — 如果长按已触发则更新位置；否则检查是否超过移动阈值
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      // 长按已触发 → 执行拖动
      if (longPressFired.current) {
        setPosition({
          x: Math.max(0, Math.min(e.clientX - dragOffset.x, window.innerWidth - (isMinimized ? 60 : 150))),
          y: Math.max(0, Math.min(e.clientY - dragOffset.y, window.innerHeight - (isMinimized ? 60 : 110))),
        });
        return;
      }

      // 长按还没触发 → 检查鼠标是否移动了很多
      if (pressStartPos.current) {
        const dx = Math.abs(e.clientX - pressStartPos.current.x);
        const dy = Math.abs(e.clientY - pressStartPos.current.y);
        if (dx > DRAG_THRESHOLD_PX || dy > DRAG_THRESHOLD_PX) {
          // 用户明显在拖动 → 提前进入拖动模式
          if (longPressTimer.current) {
            clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
          }
          longPressFired.current = true;
          setIsDragging(true);
          setPosition({
            x: Math.max(0, Math.min(e.clientX - dragOffset.x, window.innerWidth - (isMinimized ? 60 : 150))),
            y: Math.max(0, Math.min(e.clientY - dragOffset.y, window.innerHeight - (isMinimized ? 60 : 110))),
          });
        }
      }
    };

    const handleMouseUp = () => {
      // 清理长按计时器
      if (longPressTimer.current) {
        clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
      }

      // 如果长按没触发 → 视为点击 → 切换 minimized
      if (!longPressFired.current && pressStartPos.current) {
        const duration = Date.now() - pressStartTime.current;
        if (duration < LONG_PRESS_MS) {
          // 短按点击 → 切换状态
          setIsMinimized((prev) => !prev);
        }
      }

      setIsDragging(false);
      pressStartPos.current = null;
      longPressFired.current = false;
    };

    // 无论是否 isDragging，都挂 listener（因为长按时是在 mouseup 前动态进入拖动）
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragOffset, isMinimized, position.x, position.y]);

  return (
    <motion.div
      ref={containerRef}
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ 
        opacity: 1, 
        scale: 1,
        borderRadius: isMinimized ? '50%' : '0',
        width: isMinimized ? '60px' : '144px',
        height: isMinimized ? '60px' : 'auto'
      }}
      transition={{ 
        delay: 0.2, 
        duration: 0.3,
        type: "spring",
        stiffness: 300,
        damping: 30
      }}
      className="fixed z-50 cursor-move select-none"
      style={{
        left: position.x,
        top: position.y,
      }}
      onMouseDown={handleMouseDown}
    >
      {isMinimized ? (
        <motion.div
           className="w-14 h-14 bg-card border shadow-lg rounded-full flex items-center justify-center"
           whileHover={{ scale: 1.1 }}
           whileTap={{ scale: 0.9 }}
         >
           <Play className="size-6 text-primary pointer-events-none" />
         </motion.div>
      ) : (
        <div className="w-36 bg-card border shadow-lg rounded-lg overflow-hidden flex flex-col">
                {/* 标题栏 - 点击收起（作为交互子元素，不触发长按/拖动） */}
                <div
                  className="bg-muted px-2 py-1 text-xs font-medium truncate cursor-pointer select-none"
                  data-no-drag="true"
                  onClick={() => setIsMinimized(true)}
                >
                  {displayName}
                </div>

                {/* 启动进度 */}
                <div className="p-2 pt-1">
                  <LaunchProgress />
                </div>

                {/* 详细启动阶段 (仅在展开时显示) */}
                <div className="px-2 pb-1">
                  <LaunchProgressStages />
                </div>

                {/* 启动按钮 */}
                <div className="p-2">
                  <Button
                    size="sm"
                    className="w-full gap-1 text-xs font-semibold h-8"
                    onClick={handleLaunch}
                    disabled={!canLaunch && !isLaunching && !isRunning}
                  >
                    {isLaunching ? (
                      <>
                        <Loader2 className="size-3 animate-spin" />
                        {status === "preparing" ? t("launch.status.preparing") : "Launching"}
                      </>
                    ) : isRunning ? (
                      <>
                        <Square className="size-3" />
                        {t("launch.stopGame")}
                      </>
                    ) : (
                      <>
                        <Play className="size-3" />
                        {t("launch.launchGame")}
                      </>
                    )}
                  </Button>
                </div>

                {/* 版本选择按钮 */}
                <div className="p-1 pb-2 px-2">
                  <VersionSelectorDialog compact />
                </div>
              </div>
      )}
    </motion.div>
  );
}
