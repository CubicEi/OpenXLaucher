"use client";

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, Package } from "lucide-react";
import { cn } from "@/lib/utils";
import { isTauriRuntime } from "@/lib/tauri-runtime";

type ModCoverImageProps = {
  modPath: string;
  modIdHint?: string;
  className?: string;
  fallbackClassName?: string;
};

export function ModCoverImage({
  modPath,
  modIdHint,
  className,
  fallbackClassName,
}: ModCoverImageProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!modPath.trim()) {
      setLoading(false);
      return;
    }
    if (!isTauriRuntime()) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    void invoke<string | null>("get_mod_cover_data_url", {
      modPath: modPath.trim(),
      modIdHint: modIdHint?.trim() || null,
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
  }, [modPath, modIdHint]);

  const shellClass = cn(
    "size-14 rounded-2xl bg-emerald-500/10 flex items-center justify-center shrink-0 overflow-hidden",
    className
  );

  if (loading) {
    return (
      <div className={shellClass} aria-hidden>
        <Loader2 className="size-6 animate-spin text-emerald-500/70" />
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
      <Package className={cn("size-7 text-emerald-500", fallbackClassName)} />
    </div>
  );
}
