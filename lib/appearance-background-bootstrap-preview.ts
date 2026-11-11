/** 同步首帧用的压缩预览：写入 localStorage，避免硬刷新等 IndexedDB 时闪成无背景。 */

const MAX_DATA_URL_CHARS = 350_000;
const EDGE_STEPS = [1280, 960, 720, 512] as const;
const WEBP_QUALITIES = [0.92, 0.82, 0.7] as const;
const JPEG_QUALITIES = [0.9, 0.78, 0.62] as const;

function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("bootstrap preview image decode failed"));
    };
    img.src = url;
  });
}

function canvasFromImage(img: HTMLImageElement, maxEdge: number): HTMLCanvasElement | null {
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight, 1));
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx =
    canvas.getContext("2d", { colorSpace: "srgb" } as CanvasRenderingContext2DSettings) ??
    canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, width, height);
  return canvas;
}

function encodeUnderLimit(
  canvas: HTMLCanvasElement,
  mime: string,
  qualities: readonly number[],
): string | undefined {
  if (mime === "image/png") {
    const dataUrl = canvas.toDataURL("image/png");
    if (dataUrl.length > 0 && dataUrl.length < MAX_DATA_URL_CHARS) return dataUrl;
    return undefined;
  }
  for (const quality of qualities) {
    const dataUrl = canvas.toDataURL(mime, quality);
    if (dataUrl.length > 0 && dataUrl.length < MAX_DATA_URL_CHARS) return dataUrl;
  }
  return undefined;
}

/**
 * 生成可放入 localStorage 的预览 data URL（优先 WebP/PNG，避免 JPEG 色偏）。
 * 失败或仍过大时返回 undefined（仍走 IndexedDB 异步恢复）。
 */
export async function createBootstrapBackgroundDataUrl(
  blob: Blob,
): Promise<string | undefined> {
  if (typeof document === "undefined") return undefined;
  try {
    const img = await loadImageFromBlob(blob);
    for (const maxEdge of EDGE_STEPS) {
      const canvas = canvasFromImage(img, maxEdge);
      if (!canvas) continue;
      const webp = encodeUnderLimit(canvas, "image/webp", WEBP_QUALITIES);
      if (webp) return webp;
      const png = encodeUnderLimit(canvas, "image/png", []);
      if (png) return png;
      const jpeg = encodeUnderLimit(canvas, "image/jpeg", JPEG_QUALITIES);
      if (jpeg) return jpeg;
    }
  } catch (e) {
    console.warn("[settings] 生成背景首帧预览失败", e);
  }
  return undefined;
}
