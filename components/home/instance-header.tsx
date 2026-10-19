"use client";

import { motion } from "framer-motion";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Settings } from "lucide-react";
import { fadeSlideUp } from "@/lib/motion";

interface InstanceHeaderProps {
  instanceName: string;
  minecraftVersion: string;
  loader: string;
  onOpenVersionSelector?: () => void;
  className?: string;
}

export function InstanceHeader({
  instanceName,
  minecraftVersion,
  loader,
  onOpenVersionSelector,
  className,
}: InstanceHeaderProps) {
  return (
    <motion.div
      variants={fadeSlideUp}
      initial="initial"
      animate="animate"
      transition={{ delay: 0.05 }}
    >
      <Card
        className={cn(
          "flex flex-row items-center justify-between gap-4",
          className
        )}
      >
      <div className="flex items-center gap-4 px-4">
        {/* 实例图标和信息 - 可点击区域 */}
        <button
          type="button"
          className={cn(
            "flex items-center gap-4 rounded-xl transition-colors",
            onOpenVersionSelector && "hover:bg-accent p-2 -m-2"
          )}
          onClick={onOpenVersionSelector}
          disabled={!onOpenVersionSelector}
        >
          {/* 实例图标 */}
          <div className="w-12 h-12 rounded-xl bg-gradient-to-r from-blue-500 to-cyan-500 flex items-center justify-center">
            <span className="text-white font-bold text-lg">
              {instanceName.charAt(0)}
            </span>
          </div>
          {/* 实例信息 */}
          <div className="text-left">
            <h2 className="font-bold text-base">{instanceName}</h2>
            <div className="flex items-center gap-2 mt-0.5">
              <Badge variant="secondary" className="text-xs">
                {minecraftVersion}
              </Badge>
              <Badge variant="outline" className="text-xs">
                {loader}
              </Badge>
            </div>
          </div>
        </button>
      </div>

      <div className="flex items-center gap-4 px-4">
        {/* 版本选择 */}
        {onOpenVersionSelector && (
          <Button variant="ghost" size="sm" onClick={onOpenVersionSelector}>
            <Settings className="size-4" />
            选择版本
          </Button>
        )}
      </div>
      </Card>
    </motion.div>
  );
}