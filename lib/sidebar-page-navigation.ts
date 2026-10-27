/**
 * Left rail only. Does not use shared-layout / lightweight routing.
 * Fades the main pane, then hard-navigates so the next document can play an enter animation.
 */

import { animTrace } from "@/lib/animation-trace";
import {
  normalizeAppPathname,
  PAGE_TRANSITION_ROOT_SELECTOR,
  toAppHref,
} from "@/lib/main-navigation-transition";

const ENTER_FLAG = "oxl-sidebar-page-enter";
const FADE_OUT_MS = 140;

export function consumeSidebarPageEnter(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (sessionStorage.getItem(ENTER_FLAG) !== "1") return false;
    sessionStorage.removeItem(ENTER_FLAG);
    return true;
  } catch {
    return false;
  }
}

export function navigateFromSidebar(href: string) {
  if (typeof window === "undefined") return;

  const targetPathname = normalizeAppPathname(href);
  const currentPathname = normalizeAppPathname(window.location.pathname);
  if (currentPathname === targetPathname) return;

  const pushHref = toAppHref(href);
  try {
    sessionStorage.setItem(ENTER_FLAG, "1");
  } catch {
    /* ignore */
  }

  animTrace("SidebarNav", "navigate", { from: currentPathname, href, pushHref });

  const root = document.querySelector<HTMLElement>(PAGE_TRANSITION_ROOT_SELECTOR);
  const reduce =
    window.matchMedia("(prefers-reduced-motion: reduce)").matches || !root;

  if (reduce) {
    window.location.assign(pushHref);
    return;
  }

  root.style.transition = `opacity ${FADE_OUT_MS}ms ease-out`;
  root.style.opacity = "0";
  window.setTimeout(() => {
    window.location.assign(pushHref);
  }, FADE_OUT_MS);
}
