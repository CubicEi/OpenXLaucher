"use client";

import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export const PROCESS_LIST_BUTTON_ID = "process-list-title-btn";

const FLY_EVENT = "oxl:fly-to-process-list";
/** Slightly smaller than the title-bar Cpu icon (16px). Kept constant for the whole arc. */
const DOT_SIZE = 12;
const DURATION_MS = 560;

export type FlyCoords = { x: number; y: number };

type FlyParticle = {
  id: number;
  from: FlyCoords;
  to: FlyCoords;
};

let lastPointer: FlyCoords = { x: 0, y: 0 };
let pointerTrackingStarted = false;
let particleSeq = 0;

function ensurePointerTracking() {
  if (pointerTrackingStarted || typeof window === "undefined") return;
  pointerTrackingStarted = true;
  const track = (e: PointerEvent) => {
    lastPointer = { x: e.clientX, y: e.clientY };
  };
  window.addEventListener("pointerdown", track, true);
  window.addEventListener("pointermove", track, { capture: true, passive: true });
}

export function getLastPointerCoords(): FlyCoords {
  ensurePointerTracking();
  if (lastPointer.x === 0 && lastPointer.y === 0 && typeof window !== "undefined") {
    return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  }
  return lastPointer;
}

function getProcessListButtonCenter(): FlyCoords | null {
  if (typeof document === "undefined") return null;
  const el = document.getElementById(PROCESS_LIST_BUTTON_ID);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

/** Arc control point between start and end (curves upward). */
function arcControl(from: FlyCoords, to: FlyCoords): FlyCoords {
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  // Perpendicular offset for a noticeable arc
  const lift = Math.min(120, Math.max(48, dist * 0.28));
  const nx = -dy / dist;
  const ny = dx / dist;
  // Prefer arcing "up" on screen (negative Y)
  const sign = ny > 0 ? -1 : 1;
  return {
    x: midX + nx * lift * sign,
    y: midY + ny * lift * sign,
  };
}

/**
 * Trigger the fly-to-title-bar animation.
 * Pass click coords, or omit to use the last pointer position.
 */
export function flyToProcessList(from?: FlyCoords) {
  ensurePointerTracking();
  if (typeof window === "undefined") return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const origin = from ?? getLastPointerCoords();
  window.dispatchEvent(new CustomEvent(FLY_EVENT, { detail: origin }));
}

export function FlyToProcessListOverlay() {
  const [particles, setParticles] = useState<FlyParticle[]>([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    ensurePointerTracking();
    const onFly = (event: Event) => {
      const custom = event as CustomEvent<FlyCoords>;
      const from = custom.detail ?? getLastPointerCoords();
      const to = getProcessListButtonCenter();
      if (!to) return;
      const id = ++particleSeq;
      setParticles((prev) => [...prev, { id, from, to }]);
      window.setTimeout(() => {
        setParticles((prev) => prev.filter((p) => p.id !== id));
      }, DURATION_MS + 40);
    };
    window.addEventListener(FLY_EVENT, onFly);
    return () => window.removeEventListener(FLY_EVENT, onFly);
  }, []);

  if (!mounted || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="pointer-events-none fixed inset-0 overflow-hidden"
      style={{ zIndex: 2147483000 }}
      aria-hidden
    >
      {particles.map((p) => {
        const ctrl = arcControl(p.from, p.to);
        const ox = DOT_SIZE / 2;
        return (
          <motion.div
            key={p.id}
            initial={{
              opacity: 0.8,
              x: p.from.x - ox,
              y: p.from.y - ox,
              scale: 1,
            }}
            animate={{
              // Constant size for the whole arc; brief fade only on arrival.
              opacity: [0.8, 0.8, 0],
              scale: 1,
              x: [p.from.x - ox, ctrl.x - ox, p.to.x - ox],
              y: [p.from.y - ox, ctrl.y - ox, p.to.y - ox],
            }}
            transition={{
              duration: DURATION_MS / 1000,
              ease: [0.22, 0.61, 0.36, 1],
              opacity: {
                duration: DURATION_MS / 1000,
                times: [0, 0.88, 1],
                ease: "linear",
              },
              x: {
                duration: DURATION_MS / 1000,
                ease: [0.22, 0.61, 0.36, 1],
                times: [0, 0.55, 1],
              },
              y: {
                duration: DURATION_MS / 1000,
                ease: [0.22, 0.61, 0.36, 1],
                times: [0, 0.55, 1],
              },
            }}
            className="absolute rounded-full bg-primary/70 shadow-sm"
            style={{ width: DOT_SIZE, height: DOT_SIZE, willChange: "transform, opacity" }}
          />
        );
      })}
    </div>,
    document.body
  );
}
