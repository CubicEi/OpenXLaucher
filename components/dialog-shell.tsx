"use client";

import type { ReactNode } from "react";

import { AppLogo } from "@/components/app-logo";
import { cn } from "@/lib/utils";

export function DialogShell({
  title,
  children,
  footer,
  className,
  bodyClassName,
}: {
  title: string;
  children: ReactNode;
  footer: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <div className={cn("flex flex-col", className)}>
      <div className="flex items-center gap-2.5 border-b border-border px-5 pb-4 pt-5">
        <AppLogo />
        <h2 className="text-sm font-semibold text-foreground leading-tight">{title}</h2>
      </div>
      <div
        className={cn(
          "px-5 pt-6 pb-2 text-sm text-muted-foreground",
          bodyClassName,
        )}
      >
        {children}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 px-5 pb-5 pt-5">
        {footer}
      </div>
    </div>
  );
}
