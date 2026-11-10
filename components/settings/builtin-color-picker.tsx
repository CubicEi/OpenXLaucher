"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { Input } from "@/components/ui/input";
import {
  hexToHsv,
  hsvToHex,
  hslHueColor,
  normalizeHex,
  type HsvColor,
} from "@/lib/theme-color-utils";
import { cn } from "@/lib/utils";

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n));
}

export interface BuiltinColorPickerProps {
  hex: string;
  onChangeHex: (hex: string) => void;
  className?: string;
}

export function BuiltinColorPicker({
  hex,
  onChangeHex,
  className,
}: BuiltinColorPickerProps) {
  const [hsv, setHsv] = useState<HsvColor>(() => hexToHsv(hex));
  const [hexInput, setHexInput] = useState(hex.toUpperCase());
  const svRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const next = normalizeHex(hex) ?? hex;
    setHsv(hexToHsv(next));
    setHexInput(next.toUpperCase());
  }, [hex]);

  const applyHsv = useCallback(
    (next: HsvColor) => {
      const snapped: HsvColor = {
        h: ((next.h % 360) + 360) % 360,
        s: clamp01(next.s),
        v: clamp01(next.v),
      };
      const nextHex = hsvToHex(snapped);
      setHsv(snapped);
      setHexInput(nextHex);
      onChangeHex(nextHex);
    },
    [onChangeHex],
  );

  const pickSvFromPointer = useCallback(
    (clientX: number, clientY: number) => {
      const el = svRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const x = clamp01((clientX - rect.left) / rect.width);
      const y = clamp01((clientY - rect.top) / rect.height);
      applyHsv({ h: hsv.h, s: x, v: 1 - y });
    },
    [applyHsv, hsv.h],
  );

  const pickHueFromPointer = useCallback(
    (clientX: number) => {
      const el = hueRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const x = clamp01((clientX - rect.left) / rect.width);
      applyHsv({ h: x * 360, s: hsv.s, v: hsv.v });
    },
    [applyHsv, hsv.s, hsv.v],
  );

  const onSvPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pickSvFromPointer(e.clientX, e.clientY);
  };

  const onSvPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    pickSvFromPointer(e.clientX, e.clientY);
  };

  const onHuePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pickHueFromPointer(e.clientX);
  };

  const onHuePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    pickHueFromPointer(e.clientX);
  };

  const commitHexInput = () => {
    const normalized = normalizeHex(hexInput);
    if (!normalized) {
      setHexInput(hex.toUpperCase());
      return;
    }
    applyHsv(hexToHsv(normalized));
  };

  const thumbLeft = `${hsv.s * 100}%`;
  const thumbTop = `${(1 - hsv.v) * 100}%`;
  const hueLeft = `${(hsv.h / 360) * 100}%`;

  return (
    <div className={cn("space-y-3", className)}>
      <div
        ref={svRef}
        role="slider"
        aria-label="Saturation and brightness"
        aria-valuemin={0}
        aria-valuemax={100}
        tabIndex={0}
        className="relative h-36 w-full cursor-crosshair overflow-hidden rounded-lg border border-border touch-none"
        style={{ backgroundColor: hslHueColor(hsv.h) }}
        onPointerDown={onSvPointerDown}
        onPointerMove={onSvPointerMove}
      >
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background: "linear-gradient(to right, #fff, transparent)",
          }}
        />
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background: "linear-gradient(to top, #000, transparent)",
          }}
        />
        <PickerThumb
          className="border-white shadow-md"
          style={{ left: thumbLeft, top: thumbTop }}
        />
      </div>

      <div
        ref={hueRef}
        role="slider"
        aria-label="Hue"
        aria-valuemin={0}
        aria-valuemax={360}
        tabIndex={0}
        className="relative h-3 w-full cursor-pointer overflow-hidden rounded-full border border-border touch-none"
        style={{
          background:
            "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)",
        }}
        onPointerDown={onHuePointerDown}
        onPointerMove={onHuePointerMove}
      >
        <PickerThumb
          className="size-4 -translate-x-1/2 -translate-y-1/2 border-2 border-white shadow"
          style={{ left: hueLeft, top: "50%" }}
        />
      </div>

      <div className="flex items-center gap-2">
        <span
          className="size-9 shrink-0 rounded-md border border-border shadow-inner"
          style={{ backgroundColor: hsvToHex(hsv) }}
        />
        <Input
          value={hexInput}
          onChange={(e) => setHexInput(e.target.value.toUpperCase())}
          onBlur={commitHexInput}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitHexInput();
          }}
          className="h-8 flex-1 font-mono text-xs"
          spellCheck={false}
          autoComplete="off"
        />
      </div>
    </div>
  );
}

function PickerThumb({
  className,
  style,
}: {
  className?: string;
  style: { left: string; top: string };
}) {
  return (
    <span
      className={cn(
        "pointer-events-none absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-border bg-background ring-1 ring-black/20",
        className,
      )}
      style={style}
    />
  );
}
