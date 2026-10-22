import { Package } from "lucide-react";

/** Cache library header icon (matches mod management). */
export const CACHE_LIBRARY_ICON_BG = "bg-sky-500/10";

export function CacheLibraryIcon({ className = "size-5 text-sky-500" }: { className?: string }) {
  return <Package className={className} />;
}
