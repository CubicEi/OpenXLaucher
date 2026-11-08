"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * 从皮肤贴图截取正视面部：
 * - 内层脸：UV (8, 8) 8×8
 * - 外层（帽子）脸：UV (40, 8) 8×8，叠在内层之上（保留透明）
 */

type SkinFaceAvatarProps = {
  skinSrc: string;
  size?: number;
  className?: string;
};

function normalizeTextureUrl(url?: string): string | null {
  if (!url) return null;
  if (url.startsWith("http://")) return `https://${url.slice(7)}`;
  return url;
}

export function SkinFaceAvatar({
  skinSrc,
  size = 96,
  className,
}: SkinFaceAvatarProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const src = normalizeTextureUrl(skinSrc);
    if (!src) {
      setFailed(true);
      return;
    }

    setFailed(false);
    const img = new Image();
    // data: / blob: 无需 CORS；http(s) 皮肤若跨域需后端已转 base64
    if (!src.startsWith("data:") && !src.startsWith("blob:")) {
      img.crossOrigin = "anonymous";
    }

    img.onload = () => {
      if (cancelled || !canvasRef.current) return;
      const el = canvasRef.current;
      const scale = Math.max(1, Math.floor(size / 8));
      const out = 8 * scale;
      el.width = out;
      el.height = out;

      const ctx = el.getContext("2d");
      if (!ctx) {
        setFailed(true);
        return;
      }

      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, out, out);

      // 内层面部
      ctx.drawImage(img, 8, 8, 8, 8, 0, 0, out, out);

      // 外层面部（64×64 皮肤才有；旧 64×32 无此外层）
      if (img.height >= 64) {
        ctx.drawImage(img, 40, 8, 8, 8, 0, 0, out, out);
      }
    };

    img.onerror = () => {
      if (!cancelled) setFailed(true);
    };

    img.src = src;
    return () => {
      cancelled = true;
    };
  }, [skinSrc, size]);

  if (failed) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-2xl bg-muted text-muted-foreground",
          className,
        )}
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <canvas
      ref={canvasRef}
      className={cn("block rounded-2xl [image-rendering:pixelated]", className)}
      style={{ width: size, height: size }}
      aria-hidden
    />
  );
}
