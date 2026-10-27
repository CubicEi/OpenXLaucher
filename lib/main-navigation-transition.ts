/** Sidebar / in-app page transition state — shared so links can cancel a stuck lock. */

import type { MouseEvent as ReactMouseEvent } from "react";
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { animTrace } from "@/lib/animation-trace";
import { appLog } from "@/lib/runtime-log";
import { isTauriRuntime } from "@/lib/tauri-runtime";

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
/** Poll after `router.push` before hard-assign (non-lightweight navigations only). */
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

/** Matches `trailingSlash: true` in next.config — static export routing expects trailing slashes. */
export function toAppHref(href: string) {
  if (href === "/" || href.endsWith("/")) return href;
  return `${href}/`;
}

const SHARED_LAYOUT_PREFIXES = ["/game-settings", "/instance-settings", "/settings"];

/** Tab / sub-route navigation inside the same Next.js layout (no full-page fade). */
export function isSharedLayoutRoute(path: string) {
  const normalized = normalizeAppPathname(path);
  return SHARED_LAYOUT_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  );
}

/**
 * AnimatePresence key for the shell page transition.
 * Shared-layout sections keep a stable key so in-section category/tab switches
 * do not remount the outer fade (layouts handle that with path-keyed children).
 */
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

/** Tab switches inside the same layout (e.g. /game-settings → /game-settings/export), not home → game-settings. */
export function shouldUseLightweightAppNavigation(current: string, target: string) {
  const normalizedCurrent = normalizeAppPathname(current);
  const normalizedTarget = normalizeAppPathname(target);
  if (normalizedCurrent === normalizedTarget) return false;
  return isWithinSameLayoutSection(normalizedCurrent, normalizedTarget);
}

/**
 * Shared-layout tab / category links (settings, game-settings): use hard navigation immediately.
 * In Tauri + static export, `router.push` often never updates `location.pathname` until assign.
 */
export function pushAppRouteLightweight(href: string) {
  if (typeof window === "undefined") return;

  if (pushAppRoutePollTimer !== undefined) {
    window.clearInterval(pushAppRoutePollTimer);
    pushAppRoutePollTimer = undefined;
  }

  const pushHref = toAppHref(href);
  const targetPathname = normalizeAppPathname(href);
  const from = normalizeAppPathname(window.location.pathname);

  if (from === targetPathname) {
    return;
  }

  animTrace("Nav/pushAppRouteLightweight", "assign", {
    href,
    pushHref,
    targetPathname,
    from,
  });
  window.location.assign(pushHref);
}

/** Client navigation with trailing-slash href; falls back to `location.assign` when push stalls. */
export function pushAppRoute(router: AppRouterInstance, href: string) {
  const pushHref = toAppHref(href);
  const targetPathname = normalizeAppPathname(href);
  animTrace("Nav/pushAppRoute", "push", {
    href,
    pushHref,
    targetPathname,
    from: typeof window !== "undefined" ? window.location.pathname : "",
  });
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
      animTrace("Nav/pushAppRoute", "settled", {
        targetPathname,
        elapsedMs: Date.now() - startedAt,
      });
      return;
    }
    if (Date.now() - startedAt < APP_ROUTE_PUSH_FALLBACK_MS) {
      return;
    }
    if (pushAppRoutePollTimer !== undefined) {
      window.clearInterval(pushAppRoutePollTimer);
      pushAppRoutePollTimer = undefined;
    }
    appLog.warn("nav", "pushAppRoute assign fallback", {
      pushHref,
      pathname: window.location.pathname,
      targetPathname,
      elapsedMs: Date.now() - startedAt,
    });
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
      if (!pathnameReady() && !allowMutationWithoutPathMatch) {
        return;
      }
      scheduleMutationSettle(
        pathnameReady() ? "mutation" : "mutation-descendant",
      );
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

    if (pathnameReady()) {
      scheduleMutationSettle("pathname-already-matched");
    }

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

  const pushHref = toAppHref(href);
  if (shouldUseLightweightAppNavigation(currentPathname, targetPathname)) {
    pushAppRouteLightweight(href);
    return;
  }

  const root =
    getPageTransitionElement() ?? document.querySelector<HTMLElement>("main");
  if (!root) {
    router.push(pushHref);
    return;
  }

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    router.push(pushHref);
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

  if (isTauriRuntime()) {
    animTrace("Nav/navigateWithMainTransition", "tauri-assign-after-fade", {
      targetPathname,
      pushHref,
      from: currentPathname,
    });
    window.setTimeout(() => {
      window.location.assign(pushHref);
    }, FADE_OUT_MS);
    return;
  }

  const main = document.querySelector<HTMLElement>("main");
  router.push(pushHref);
  const contentReady = waitForPageContent(
    main ?? root,
    targetPathname,
    controller.signal,
    currentPathname,
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

    const targetPathname = normalizeAppPathname(href);
    const currentPathname = normalizeAppPathname(window.location.pathname);

    if (shouldUseLightweightAppNavigation(currentPathname, targetPathname)) {
      animTrace("Nav/createInAppLinkHandler", "lightweight", {
        currentPathname,
        targetPathname,
        href,
        lightweight: true,
        sameSection: isWithinSameLayoutSection(currentPathname, targetPathname),
      });
      pushAppRouteLightweight(href);
      return;
    }

    animTrace("Nav/createInAppLinkHandler", "full-transition", {
      currentPathname,
      targetPathname,
      href,
      lightweight: false,
    });
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
