"use client";

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, Package } from "lucide-react";
import { cn } from "@/lib/utils";
import { isTauriRuntime } from "@/lib/tauri-runtime";
import type { ResourceKindWire } from "@/lib/resource-kind";

type ResourceCoverImageProps = {
  resourcePath: string;
  resourceKind: ResourceKindWire;
  className?: string;
  fallbackClassName?: string;
};

export function ResourceCoverImage({
  resourcePath,
  resourceKind,
  className,
  fallbackClassName,
}: ResourceCoverImageProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!resourcePath.trim()) {
      setLoading(false);
      return;
    }
    if (!isTauriRuntime()) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    void invoke<string | null>("get_resource_cover_data_url", {
      resourcePath: resourcePath.trim(),
      resourceKind,
    })
      .then((dataUrl) => {
        if (!cancelled) setSrc(dataUrl || null);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [resourcePath, resourceKind]);

  const shellClass = cn(
    "size-14 rounded-2xl bg-primary/10 flex items-center justify-center shrink-0 overflow-hidden",
    className,
  );

  if (loading) {
    return (
      <div className={shellClass} aria-hidden>
        <Loader2 className="size-6 animate-spin text-primary/70" />
      </div>
    );
  }

  if (src) {
    return (
      <div className={shellClass}>
        <img src={src} alt="" className="size-full object-cover" />
      </div>
    );
  }

  return (
    <div className={shellClass}>
      <Package className={cn("size-7 text-primary", fallbackClassName)} />
    </div>
  );
}
