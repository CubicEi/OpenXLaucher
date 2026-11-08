"use client";

import type { ReactNode } from "react";
import { CheckCircle2, ChevronDown, Circle } from "lucide-react";
import { cn } from "@/lib/utils";

/** 与启动配置 Java 路径列表相同的圆形选中样式（多选） */
export function ExportIncludeItem({
  checked,
  label,
  disabled,
  onToggle,
  indent = false,
}: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onToggle: (next: boolean) => void;
  /** 子项缩进 */
  indent?: boolean;
}) {
  return (
    <div
      role="checkbox"
      aria-checked={checked}
      tabIndex={disabled ? -1 : 0}
      className={cn(
        "flex items-center gap-2 rounded-md px-3 py-2.5 text-sm transition-colors",
        indent && "pl-9",
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
      <span className="min-w-0 flex-1 truncate leading-snug">{label}</span>
    </div>
  );
}

/** 可展开的包含项：父级复选 + 展开区 */
export function ExportIncludeExpandable({
  checked,
  label,
  disabled,
  expanded,
  onExpandedChange,
  onToggle,
  children,
}: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  expanded: boolean;
  onExpandedChange: (next: boolean) => void;
  onToggle: (next: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div
        className={cn(
          "flex items-center gap-1 rounded-md px-1 py-0.5 text-sm transition-colors",
          checked
            ? "bg-primary/10 text-primary"
            : "text-muted-foreground hover:bg-muted",
        )}
      >
        <button
          type="button"
          aria-expanded={expanded}
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
            disabled && "pointer-events-none opacity-50",
          )}
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            onExpandedChange(!expanded);
          }}
        >
          <ChevronDown
            className={cn(
              "size-3.5 transition-transform duration-200",
              expanded ? "rotate-0" : "-rotate-90",
            )}
          />
        </button>
        <div
          role="checkbox"
          aria-checked={checked}
          tabIndex={disabled ? -1 : 0}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded-md py-2 pr-2",
            disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
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
          <span className="min-w-0 flex-1 truncate leading-snug">{label}</span>
        </div>
      </div>
      {expanded ? children : null}
    </div>
  );
}
