"use client";

import { cn } from "@/lib/utils";

interface ProgressProps {
  value?: number;
  className?: string;
  /** 轨道背景；默认 `bg-secondary` */
  trackClassName?: string;
}

export function Progress({ value, className, trackClassName }: ProgressProps) {
  const isIndeterminate = value === undefined || Number.isNaN(value);
  const clampedValue = isIndeterminate ? 0 : Math.min(100, Math.max(0, value));

  return (
    <div
      className={cn(
        "relative h-2 w-full overflow-hidden rounded-full",
        trackClassName ?? "bg-secondary",
        className
      )}
      role="progressbar"
      aria-valuenow={isIndeterminate ? undefined : clampedValue}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={isIndeterminate ? "indeterminate" : undefined}
    >
      {isIndeterminate ? (
        <div className="install-progress-indeterminate-bar" aria-hidden />
      ) : (
        <div
          className="h-full rounded-full bg-primary transition-all duration-300 ease-out"
          style={{ width: `${clampedValue}%` }}
        />
      )}
    </div>
  );
}
