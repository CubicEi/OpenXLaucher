"use client";

import { CheckCircle2, Circle } from "lucide-react";
import { cn } from "@/lib/utils";

/** 与启动配置 Java 路径列表相同的圆形选中样式（多选） */
export function ExportIncludeItem({
  checked,
  label,
  disabled,
  onToggle,
}: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <div
      role="checkbox"
      aria-checked={checked}
      tabIndex={disabled ? -1 : 0}
      className={cn(
        "flex items-center gap-2 rounded-md px-3 py-2.5 text-sm transition-colors",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
        checked
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-muted",
      )}
      onClick={() => {
        if (!disabled) onToggle(!checked);
      }}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          onToggle(!checked);
        }
      }}
    >
      {checked ? (
        <CheckCircle2 className="size-3.5 shrink-0 text-primary" />
      ) : (
        <Circle className="size-3.5 shrink-0 opacity-40" />
      )}
      <span className="leading-snug">{label}</span>
    </div>
  );
}
