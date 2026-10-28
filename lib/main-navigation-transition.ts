/** Sidebar / in-app page transition state — shared so links can cancel a stuck lock. */

import type { MouseEvent as ReactMouseEvent } from "react";
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { appLog } from "@/lib/runtime-log";
import {
  clearSkipSectionChrome,
  markSkipSectionChrome,
} from "@/lib/section-chrome-enter";
import { isTauriRuntime } from "@/lib/tauri-runtime";

export type ActiveMainNavigation = {
  controller: AbortController;
  previousTransition: string;
  previousPointerEvents: string;
  previousOpacity: string;
  targetElement: HTMLElement;
};

export const PAGE_TRANSITION_ROOT_SELECTOR = "[data-page-transition-root]";
export const SECTION_CONTENT_SELECTOR = "[data-section-content]";

const FADE_OUT_MS = 100;
const FIRST_MUTATION_SETTLE_MS = 80;
const TIMEOUT_MS = 1200;
const APP_ROUTE_PUSH_POLL_MS = 32;
const APP_ROUTE_PUSH_FALLBACK_MS = 800;

let activeNavigation: ActiveMainNavigation | null = null;
let pushAppRoutePollTimer: number | undefined;

export function getActiveMainNavigation() {
  return activeNavigation;
}

export function setActiveMainNavigation(nav: ActiveMainNavigation | null) {
  activeNavigation = nav;
}

export function normalizeAppPathname(path: string) {
  let normalized = path;
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export function pathnameMatchesNavigationTarget(current: string, target: string) {
  const normalizedCurrent = normalizeAppPathname(current);
  const normalizedTarget = normalizeAppPathname(target);
  if (normalizedCurrent === normalizedTarget) return true;
  if (normalizedTarget !== "/" && normalizedCurrent.startsWith(`${normalizedTarget}/`)) {
    return true;
  }
  return false;
}

export function toAppHref(href: string) {
  if (href === "/" || href.endsWith("/")) return href;
  return `${href}/`;
}

const SHARED_LAYOUT_PREFIXES = ["/game-settings", "/instance-settings", "/settings"];

export function isSharedLayoutRoute(path: string) {
  const normalized = normalizeAppPathname(path);
  return SHARED_LAYOUT_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  );
}

export function getPageTransitionKey(pathname: string) {
  const normalized = normalizeAppPathname(pathname);
  for (const prefix of SHARED_LAYOUT_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
      return prefix;
    }
  }
  return normalized;
}

export function isWithinSameLayoutSection(current: string, target: string) {
  const normalizedCurrent = normalizeAppPathname(current);
  const normalizedTarget = normalizeAppPathname(target);
  if (normalizedCurrent === normalizedTarget) return true;
  for (const prefix of SHARED_LAYOUT_PREFIXES) {
    const currentIn = normalizedCurrent === prefix || normalizedCurrent.startsWith(`${prefix}/`);
    const targetIn = normalizedTarget === prefix || normalizedTarget.startsWith(`${prefix}/`);
    if (currentIn && targetIn) return true;
  }
  return false;
}

/** Same shared-layout section tab switch (e.g. settings/general → settings/download). */
export function shouldUseLightweightAppNavigation(current: string, target: string) {
  const normalizedCurrent = normalizeAppPathname(current);
  const normalizedTarget = normalizeAppPathname(target);
  if (normalizedCurrent === normalizedTarget) return false;
  return isWithinSameLayoutSection(normalizedCurrent, normalizedTarget);
}

/**
 * Soft-navigate only: remount page UI (PageEnter) but keep root providers.
 * `/process-list` must not `location.assign` or DownloadProvider tasks reset.
 */
export function preservesAppShellState(path: string) {
  return normalizeAppPathname(path) === "/process-list";
}

export function navigationMustPreserveAppShell(current: string, target: string) {
  return preservesAppShellState(current) || preservesAppShellState(target);
}

export function pushAppRoute(
  router: AppRouterInstance,
  href: string,
  options?: { allowAssignFallback?: boolean },
) {
  const pushHref = toAppHref(href);
  const targetPathname = normalizeAppPathname(href);
  const allowAssignFallback = options?.allowAssignFallback !== false;
  router.push(pushHref);

  if (typeof window === "undefined") return;

  if (pushAppRoutePollTimer !== undefined) {
    window.clearInterval(pushAppRoutePollTimer);
    pushAppRoutePollTimer = undefined;
  }

  const startedAt = Date.now();
  pushAppRoutePollTimer = window.setInterval(() => {
    if (pathnameMatchesNavigationTarget(window.location.pathname, targetPathname)) {
      if (pushAppRoutePollTimer !== undefined) {
        window.clearInterval(pushAppRoutePollTimer);
        pushAppRoutePollTimer = undefined;
      }
      return;
    }
    if (Date.now() - startedAt < APP_ROUTE_PUSH_FALLBACK_MS) return;
    if (pushAppRoutePollTimer !== undefined) {
      window.clearInterval(pushAppRoutePollTimer);
      pushAppRoutePollTimer = undefined;
    }
    // Never hard-reload shell-preserving routes — that wipes DownloadProvider tasks.
    if (
      !allowAssignFallback ||
      navigationMustPreserveAppShell(window.location.pathname, targetPathname)
    ) {
      appLog.warn("nav", "pushAppRoute stalled; skip assign (preserve app shell)", {
        pushHref,
        pathname: window.location.pathname,
        targetPathname,
      });
      return;
    }
    appLog.warn("nav", "pushAppRoute assign fallback", {
      pushHref,
      pathname: window.location.pathname,
      targetPathname,
    });
    if (
      isWithinSameLayoutSection(window.location.pathname, targetPathname)
    ) {
      markSkipSectionChrome(getPageTransitionKey(targetPathname));
    } else {
      clearSkipSectionChrome();
    }
    window.location.assign(pushHref);
  }, APP_ROUTE_PUSH_POLL_MS);
}

export function isDescendantAppPath(ancestor: string, descendant: string) {
  const from = normalizeAppPathname(ancestor);
  const to = normalizeAppPathname(descendant);
  return to.startsWith(`${from}/`);
}

export function getPageTransitionElement(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return (
    document.querySelector<HTMLElement>(PAGE_TRANSITION_ROOT_SELECTOR) ??
    document.querySelector<HTMLElement>("main")
  );
}

export function getSectionContentElement(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLElement>(SECTION_CONTENT_SELECTOR);
}

export function resetPageTransitionStyles() {
  for (const el of [
    document.querySelector<HTMLElement>("main"),
    document.querySelector<HTMLElement>(PAGE_TRANSITION_ROOT_SELECTOR),
    document.querySelector<HTMLElement>(SECTION_CONTENT_SELECTOR),
  ]) {
    if (el?.isConnected) {
      el.style.removeProperty("pointer-events");
      el.style.removeProperty("opacity");
      el.style.removeProperty("transition");
    }
  }
}

export function abortActiveMainNavigation() {
  const nav = activeNavigation;
  if (!nav) {
    resetPageTransitionStyles();
    return;
  }
  nav.controller.abort();
  if (nav.targetElement.isConnected) {
    nav.targetElement.style.pointerEvents = nav.previousPointerEvents;
    nav.targetElement.style.transition = nav.previousTransition;
    nav.targetElement.style.opacity = nav.previousOpacity;
  }
  activeNavigation = null;
  resetPageTransitionStyles();
}

function waitForPageContent(
  root: HTMLElement,
  targetPathname: string,
  signal: AbortSignal,
  fromPathname?: string,
) {
  return new Promise<void>((resolve) => {
    let settled = false;
    let settleTimer: number | undefined;
    const allowMutationWithoutPathMatch =
      !!fromPathname && isDescendantAppPath(fromPathname, targetPathname);

    const pathnameReady = () =>
      pathnameMatchesNavigationTarget(window.location.pathname, targetPathname);

    const finish = (_reason: string) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      window.clearTimeout(timeoutTimer);
      window.clearInterval(pathPollTimer);
      if (settleTimer !== undefined) window.clearTimeout(settleTimer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };

    const onAbort = () => finish("abort");

    const scheduleMutationSettle = (reason: string) => {
      if (!settleTimer) {
        settleTimer = window.setTimeout(() => {
          settleTimer = undefined;
          finish(reason);
        }, FIRST_MUTATION_SETTLE_MS);
      }
    };

    const observer = new MutationObserver(() => {
      if (settled) return;
      if (!pathnameReady() && !allowMutationWithoutPathMatch) return;
      scheduleMutationSettle(pathnameReady() ? "mutation" : "mutation-descendant");
    });

    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    const timeoutTimer = window.setTimeout(() => finish("timeout"), TIMEOUT_MS);
    const pathPollTimer = window.setInterval(() => {
      if (settled || !pathnameReady()) return;
      scheduleMutationSettle("pathname-poll");
    }, 32);

    if (pathnameReady()) scheduleMutationSettle("pathname-already-matched");
    if (signal.aborted) {
      finish("abort-initial");
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function shouldHandlePrimaryLink(event: ReactMouseEvent<HTMLAnchorElement>) {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

function runStaticFadeThenNavigate(
  root: HTMLElement,
  navigate: () => void,
  options?: {
    waitRoot?: HTMLElement;
    targetPathname?: string;
    fromPathname?: string;
    hardAssign?: boolean;
    assignHref?: string;
  },
) {
  const controller = new AbortController();
  const previousTransition = root.style.transition;
  const previousPointerEvents = root.style.pointerEvents;
  const previousOpacity = root.style.opacity;

  const restoreTargetStyles = () => {
    if (!root.isConnected) {
      setActiveMainNavigation(null);
      return;
    }
    root.style.transition = previousTransition;
    root.style.pointerEvents = previousPointerEvents;
    root.style.opacity = previousOpacity;
    setActiveMainNavigation(null);
  };

  const navigation: ActiveMainNavigation = {
    controller,
    previousTransition,
    previousPointerEvents,
    previousOpacity,
    targetElement: root,
  };
  setActiveMainNavigation(navigation);

  root.style.pointerEvents = "none";
  root.style.transition = `opacity ${FADE_OUT_MS}ms ease-out`;
  root.style.opacity = "0";

  if (options?.hardAssign && options.assignHref) {
    window.setTimeout(() => {
      window.location.assign(options.assignHref!);
    }, FADE_OUT_MS);
    return;
  }

  window.setTimeout(async () => {
    if (controller.signal.aborted) return;
    navigate();
    const waitRoot = options?.waitRoot ?? root;
    const targetPathname = options?.targetPathname;
    try {
      if (targetPathname) {
        await waitForPageContent(
          waitRoot,
          targetPathname,
          controller.signal,
          options?.fromPathname,
        );
      } else {
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
      }
      if (getActiveMainNavigation() !== navigation) return;
      // Instant restore — enter animation is owned by PageEnter CSS gate.
      if (root.isConnected) {
        root.style.transition = "none";
        root.style.opacity = "1";
      }
    } finally {
      if (getActiveMainNavigation() === navigation) {
        restoreTargetStyles();
      }
    }
  }, FADE_OUT_MS);
}

/**
 * Full-shell or section-content static opacity fade, then navigate.
 * Enter animation is handled by PageEnter on the destination.
 */
export function navigateWithMainTransition(
  router: AppRouterInstance,
  href: string,
  options?: { skipIfSamePath?: boolean },
) {
  const targetPathname = normalizeAppPathname(href);
  const currentPathname = normalizeAppPathname(window.location.pathname);
  const pushHref = toAppHref(href);

  abortActiveMainNavigation();

  if (options?.skipIfSamePath && currentPathname === targetPathname) {
    return;
  }

  const preserveShell = navigationMustPreserveAppShell(currentPathname, targetPathname);
  const softPush = () =>
    pushAppRoute(router, href, { allowAssignFallback: !preserveShell });

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    softPush();
    return;
  }

  const sameSection = shouldUseLightweightAppNavigation(currentPathname, targetPathname);
  const sectionContent = getSectionContentElement();
  const root =
    (sameSection ? sectionContent : null) ??
    getPageTransitionElement() ??
    document.querySelector<HTMLElement>("main");

  if (!root) {
    softPush();
    return;
  }
  // Selective remount: soft-push keeps DownloadProvider; only page UI re-enters.
  const hardAssign = isTauriRuntime() && !sameSection && !preserveShell;

  // Chrome float is section-enter only. Mark skip only when same-section will
  // remount (Tauri assign); clear when leaving so a later enter can animate.
  if (sameSection && isTauriRuntime() && isSharedLayoutRoute(currentPathname)) {
    markSkipSectionChrome(getPageTransitionKey(currentPathname));
  } else if (!sameSection) {
    clearSkipSectionChrome();
  }

  runStaticFadeThenNavigate(
    root,
    () => {
      if (sameSection && isTauriRuntime()) {
        window.location.assign(pushHref);
        return;
      }
      softPush();
    },
    {
      waitRoot: document.querySelector<HTMLElement>("main") ?? root,
      targetPathname,
      fromPathname: currentPathname,
      hardAssign,
      assignHref: pushHref,
    },
  );
}

export function onInAppLinkPointerDown() {
  abortActiveMainNavigation();
}

export function onInAppLinkClick() {
  abortActiveMainNavigation();
}

export function createInAppLinkHandler(
  router: AppRouterInstance,
  href: string,
  options?: { skipIfSamePath?: boolean },
) {
  return (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (!shouldHandlePrimaryLink(event)) return;
    event.preventDefault();
    navigateWithMainTransition(router, href, options);
  };
}

export const mainNavigationTiming = {
  FADE_OUT_MS,
  FIRST_MUTATION_SETTLE_MS,
  TIMEOUT_MS,
} as const;

export { waitForPageContent };
