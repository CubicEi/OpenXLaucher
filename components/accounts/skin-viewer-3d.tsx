"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Minecraft 3D 皮肤查看器（基于 skinview3d 库，该库使用 three.js）
 *
 * skinview3d 是成熟的 Minecraft 皮肤渲染库，支持：
 *  - 64x64（1.8+）双层皮肤（帽子/外套/外袖/外裤）
 *  - 64x32（1.8 前）旧格式
 *  - slim（细胳膊）与 classic（粗胳膊）两种模型
 *  - 披风渲染
 *  - 鼠标拖拽旋转
 *  - 自动旋转动画
 */

type SkinViewer3DProps = {
  skinSrc: string;          // PNG 皮肤的 URL 或 base64 (data:image/png;base64,...)
  capeSrc?: string;         // 披风贴图（可选）
  playerName?: string;
  width?: number;
  height?: number;
  modelType?: "classic" | "slim";
  autoRotate?: boolean;
};

function normalizeTextureUrl(url?: string): string | null {
  if (!url) return null;
  if (url.startsWith("http://")) {
    return "https://" + url.slice(7);
  }
  return url;
}

export function SkinViewer3D({
  skinSrc,
  capeSrc,
  width = 320,
  height = 400,
  modelType = "classic",
  autoRotate = true,
}: SkinViewer3DProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerRef = useRef<any>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [skinview3d, setSkinview3d] = useState<typeof import("skinview3d") | null>(null);
  const [libraryFailed, setLibraryFailed] = useState(false);

  // three.js/skinview3d 体积较大，在首帧绘制完成后再加载，避免阻塞主页交互。
  useEffect(() => {
    let cancelled = false;
    void import("skinview3d")
      .then((module) => {
        if (!cancelled) setSkinview3d(module);
      })
      .catch(() => {
        if (!cancelled) setLibraryFailed(true);
      });
    return () => { cancelled = true; };
  }, []);

  // 初始化 viewer
  useEffect(() => {
    if (!skinview3d) return;
    if (!canvasRef.current) return;

    let cancelled = false;
    try {
      // skinview3d v3.4.x 的构造 API
      const viewer = new skinview3d.SkinViewer({
        canvas: canvasRef.current,
        width,
        height,
        skin: normalizeTextureUrl(skinSrc),
        cape: normalizeTextureUrl(capeSrc),
        devicePixelRatio: typeof window !== "undefined" ? window.devicePixelRatio : 1,
        preserveDrawingBuffer: true,
        // model: modelType === "slim" ? "slim" : "default",
        controls: {
          enabled: true,
          zoom: true,
          rotate: true,
          pan: false,
        },
      } as any);

      // 设置模型类型（slim=细胳膊，default=粗胳膊）
      // skinview3d 会自动从皮肤中检测，但我们可以显式设置
      try {
        (viewer as any).model = modelType === "slim" ? "slim" : "default";
      } catch {}

      // 初始视角
      try {
        viewer.camera.rotation.x = -0.15;
        viewer.camera.position.y = 0;
        viewer.camera.position.z = 55;
      } catch {}

      // 显式刷新一次，确保纹理映射在 initial load 时正确
      try {
        viewer.setSize(width, height);
      } catch {}

      // 动画
      if (autoRotate) {
        try {
          viewer.animation = new skinview3d.WalkingAnimation();
          (viewer.animation as any).speed = 0.6;
        } catch {
          try {
            viewer.animation = new skinview3d.IdleAnimation();
          } catch {}
        }
      }

      viewerRef.current = viewer;
      setTimeout(() => {
        if (!cancelled) setLoaded(true);
      }, 100);
    } catch (e) {
      console.error("SkinViewer 初始化失败:", e);
      setError(true);
    }

    return () => {
      cancelled = true;
      if (viewerRef.current) {
        try {
          viewerRef.current.dispose();
        } catch {}
        viewerRef.current = null;
      }
    };
  }, [skinview3d]);

  // 更新皮肤
  useEffect(() => {
    if (!viewerRef.current || !skinSrc) return;
    try {
      const normalized = normalizeTextureUrl(skinSrc);
      if (normalized) {
        viewerRef.current.skin = normalized;
        setError(false);
      }
    } catch (e) {
      console.error("加载皮肤失败:", e);
      setError(true);
    }
  }, [skinSrc]);

  // 更新披风
  useEffect(() => {
    if (!viewerRef.current) return;
    try {
      viewerRef.current.cape = normalizeTextureUrl(capeSrc);
    } catch (e) {
      console.error("加载披风失败:", e);
    }
  }, [capeSrc]);

  // 更新模型类型
  useEffect(() => {
    if (!viewerRef.current) return;
    try {
      viewerRef.current.model = modelType === "slim" ? "slim" : "default";
    } catch {}
  }, [modelType]);

  // 更新尺寸
  useEffect(() => {
    if (!viewerRef.current) return;
    try {
      viewerRef.current.setSize(width, height);
    } catch {}
  }, [width, height]);

  if (libraryFailed) {
    return (
      <div
        ref={containerRef}
        className="flex items-center justify-center rounded-lg border border-dashed border-muted-foreground/30 bg-muted/20 text-sm text-muted-foreground select-none"
        style={{ width, height }}
      >
        <div className="text-center p-4">
          <p>skinview3d 库未安装</p>
          <p className="mt-2 text-xs opacity-70">请运行: npm install skinview3d three</p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="relative flex items-center justify-center select-none overflow-hidden"
      style={{ width, height }}
    >
      <canvas
        ref={canvasRef}
        className="rounded-lg bg-gradient-to-b from-transparent to-black/5"
        style={{ width: "100%", height: "100%", display: "block" }}
      />
      {!loaded && !error && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          加载皮肤中...
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          皮肤加载失败
        </div>
      )}
    </div>
  );
}
