"use client";

import { useEffect } from "react";

/** 靠近滚动条边缘多少像素内显示滚动条 */
const NEAR_PX = 28;
const ATTR = "data-scrollbar-near";

function canScrollY(el: HTMLElement, style: CSSStyleDeclaration): boolean {
  const o = style.overflowY;
  if (o !== "auto" && o !== "scroll" && o !== "overlay") return false;
  return el.scrollHeight > el.clientHeight + 1;
}

function canScrollX(el: HTMLElement, style: CSSStyleDeclaration): boolean {
  const o = style.overflowX;
  if (o !== "auto" && o !== "scroll" && o !== "overlay") return false;
  return el.scrollWidth > el.clientWidth + 1;
}

/**
 * 默认隐藏滚动条拇指，预留宽度；鼠标靠近滚动条槽位时再显示。
 */
export function ScrollbarProximity() {
  useEffect(() => {
    let active = new Set<HTMLElement>();
    let raf = 0;

    const clearAll = () => {
      for (const el of active) el.removeAttribute(ATTR);
      active.clear();
    };

    const sync = (next: Set<HTMLElement>) => {
      for (const el of active) {
        if (!next.has(el)) el.removeAttribute(ATTR);
      }
      for (const el of next) {
        if (!active.has(el)) el.setAttribute(ATTR, "");
      }
      active = next;
    };

    const onMove = (e: MouseEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const next = new Set<HTMLElement>();
        let node: Element | null = document.elementFromPoint(e.clientX, e.clientY);

        while (node) {
          if (
            node instanceof HTMLElement &&
            !node.classList.contains("no-scrollbar")
          ) {
            const style = getComputedStyle(node);
            const rect = node.getBoundingClientRect();

            if (canScrollY(node, style)) {
              const distRight = rect.right - e.clientX;
              if (
                distRight >= -2 &&
                distRight <= NEAR_PX &&
                e.clientY >= rect.top &&
                e.clientY <= rect.bottom
              ) {
                next.add(node);
              }
            }

            if (canScrollX(node, style)) {
              const distBottom = rect.bottom - e.clientY;
              if (
                distBottom >= -2 &&
                distBottom <= NEAR_PX &&
                e.clientX >= rect.left &&
                e.clientX <= rect.right
              ) {
                next.add(node);
              }
            }
          }
          node = node.parentElement;
        }

        sync(next);
      });
    };

    const onLeaveWindow = () => {
      cancelAnimationFrame(raf);
      clearAll();
    };

    window.addEventListener("mousemove", onMove, { passive: true });
    document.documentElement.addEventListener("mouseleave", onLeaveWindow);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("mousemove", onMove);
      document.documentElement.removeEventListener("mouseleave", onLeaveWindow);
      clearAll();
    };
  }, []);

  return null;
}
