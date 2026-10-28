"use client";

import { usePathname } from "next/navigation";

import { PageEnter } from "@/components/layout/page-enter";
import {
  getPageTransitionKey,
  normalizeAppPathname,
  PAGE_TRANSITION_ROOT_SELECTOR,
} from "@/lib/main-navigation-transition";

interface PageTransitionProps {
  children: React.ReactNode;
}

export { PAGE_TRANSITION_ROOT_SELECTOR };

export function PageTransition({ children }: PageTransitionProps) {
  const pathname = usePathname();
  const pathnameNorm = normalizeAppPathname(pathname);
  const transitionKey = getPageTransitionKey(pathname);
  /** Shared layout: stable shell key — chrome/content animate inside layouts. */
  const sharedLayoutShell = transitionKey !== pathnameNorm;

  // absolute inset — do not use h-full here: ThemeRoute uses display:contents,
  // and % height through that box often collapses in Tauri WebView (static export).
  if (sharedLayoutShell) {
    return (
      <div data-page-transition-root className="absolute inset-0 min-h-0 overflow-hidden">
        {children}
      </div>
    );
  }

  return (
    <div data-page-transition-root className="absolute inset-0 min-h-0 overflow-hidden">
      <PageEnter
        enterKey={transitionKey}
        stagger={false}
        fill
        className="h-full w-full"
      >
        {children}
      </PageEnter>
    </div>
  );
}
