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
      <div className="flex items-center gap-2.5 border-b border-border px-5 py-4">
        <AppLogo />
        <h2 className="text-sm font-semibold text-foreground leading-tight">{title}</h2>
      </div>
      <div className={cn("px-5 py-4 text-sm text-muted-foreground", bodyClassName)}>
        {children}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">
        {footer}
      </div>
    </div>
  );
}
