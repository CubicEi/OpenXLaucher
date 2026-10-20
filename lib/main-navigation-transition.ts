/** Sidebar / in-app page transition state — shared so links can cancel a stuck lock. */

import type { MouseEvent as ReactMouseEvent } from "react";
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";

export type ActiveMainNavigation = {
  controller: AbortController;
  previousTransition: string;
  previousPointerEvents: string;
  previousOpacity: string;
  targetElement: HTMLElement;
};

export const PAGE_TRANSITION_ROOT_SELECTOR = "[data-page-transition-root]";

const FADE_OUT_MS = 80;
const FADE_IN_MS = 150;
const FIRST_MUTATION_SETTLE_MS = 80;
const TIMEOUT_MS = 1200;

let activeNavigation: ActiveMainNavigation | null = null;

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

/** True when navigation reached `target` or a nested child route (e.g. /game-settings/mods). */
export function pathnameMatchesNavigationTarget(current: string, target: string) {
  const normalizedCurrent = normalizeAppPathname(current);
  const normalizedTarget = normalizeAppPathname(target);
  if (normalizedCurrent === normalizedTarget) return true;
  if (normalizedTarget !== "/" && normalizedCurrent.startsWith(`${normalizedTarget}/`)) {
    return true;
  }
  return false;
}

export function getPageTransitionElement(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return (
    document.querySelector<HTMLElement>(PAGE_TRANSITION_ROOT_SELECTOR) ??
    document.querySelector<HTMLElement>("main")
  );
}

/** Clear inline fade styles even when no navigation lock is held (stuck opacity after races). */
export function resetPageTransitionStyles() {
  const main = document.querySelector<HTMLElement>("main");
  if (main?.isConnected) {
    main.style.removeProperty("pointer-events");
    main.style.removeProperty("opacity");
    main.style.removeProperty("transition");
  }

  const root = document.querySelector<HTMLElement>(PAGE_TRANSITION_ROOT_SELECTOR);
  if (root?.isConnected) {
    root.style.removeProperty("pointer-events");
    root.style.removeProperty("opacity");
    root.style.removeProperty("transition");
  }
}

/** Restore interaction/styles and abort any in-flight sidebar transition. */
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
) {
  return new Promise<void>((resolve) => {
    let settled = false;
    let settleTimer: number | undefined;

    const finish = () => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      window.clearTimeout(timeoutTimer);
      if (settleTimer !== undefined) window.clearTimeout(settleTimer);
      signal.removeEventListener("abort", finish);
      resolve();
    };

    const observer = new MutationObserver(() => {
      if (settled) return;
      if (!pathnameMatchesNavigationTarget(window.location.pathname, targetPathname)) {
        return;
      }
      if (!settleTimer) {
        settleTimer = window.setTimeout(() => {
          settleTimer = undefined;
          finish();
        }, FIRST_MUTATION_SETTLE_MS);
      }
    });

    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    const timeoutTimer = window.setTimeout(finish, TIMEOUT_MS);

    if (pathnameMatchesNavigationTarget(window.location.pathname, targetPathname)) {
      settleTimer = window.setTimeout(() => {
        settleTimer = undefined;
        finish();
      }, FIRST_MUTATION_SETTLE_MS);
    }

    if (signal.aborted) {
      finish();
      return;
    }

    signal.addEventListener("abort", finish, { once: true });
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

/**
 * Sidebar-style fade transition for in-app navigations (game settings tabs, home quick links).
 * Always calls `router.push` so navigation succeeds even if a fade lock was stuck.
 */
export function navigateWithMainTransition(
  router: AppRouterInstance,
  href: string,
  options?: { skipIfSamePath?: boolean },
) {
  const targetPathname = normalizeAppPathname(href);
  const currentPathname = normalizeAppPathname(window.location.pathname);

  abortActiveMainNavigation();

  if (options?.skipIfSamePath && currentPathname === targetPathname) {
    return;
  }

  const root =
    getPageTransitionElement() ?? document.querySelector<HTMLElement>("main");
  if (!root) {
    router.push(href);
    return;
  }

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    router.push(href);
    return;
  }

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

  root.style.transition = `opacity ${FADE_OUT_MS}ms ease-out`;
  root.style.opacity = "0";

  const main = document.querySelector<HTMLElement>("main");
  router.push(href);
  const contentReady = waitForPageContent(
    main ?? root,
    targetPathname,
    controller.signal,
  );

  window.setTimeout(async () => {
    try {
      if (controller.signal.aborted) return;
      await contentReady;
      if (getActiveMainNavigation() !== navigation) return;
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          if (!root.isConnected) {
            resolve();
            return;
          }
          root.style.transition = `opacity ${FADE_IN_MS}ms ease-out`;
          root.style.opacity = "1";
          window.setTimeout(() => resolve(), FADE_IN_MS + 20);
        });
      });
    } finally {
      if (getActiveMainNavigation() === navigation) {
        restoreTargetStyles();
      }
    }
  }, FADE_OUT_MS / 2);
}

/** Pointer-down hook: recover from a stuck sidebar fade before the click is delivered. */
export function onInAppLinkPointerDown() {
  abortActiveMainNavigation();
}

/** Legacy helper — prefer `createInAppLinkHandler` for navigations that must always route. */
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
  FADE_IN_MS,
  FIRST_MUTATION_SETTLE_MS,
  TIMEOUT_MS,
} as const;

export { waitForPageContent };
