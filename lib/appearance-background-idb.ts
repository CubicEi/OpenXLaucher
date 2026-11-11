/** 启动器自定义背景图（大图）— IndexedDB 存 Blob，显示用 blob: URL */

export const APPEARANCE_BACKGROUND_DB_NAME = "openxlauncher";
export const APPEARANCE_BACKGROUND_DB_VERSION = 1;
export const APPEARANCE_BACKGROUND_STORE = "appearance";
export const APPEARANCE_BACKGROUND_IMAGE_KEY = "background-image";

function openAppearanceBackgroundDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("indexedDB unavailable"));
      return;
    }
    const request = indexedDB.open(
      APPEARANCE_BACKGROUND_DB_NAME,
      APPEARANCE_BACKGROUND_DB_VERSION,
    );
    request.onerror = () => reject(request.error ?? new Error("indexedDB open failed"));
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(APPEARANCE_BACKGROUND_STORE)) {
        db.createObjectStore(APPEARANCE_BACKGROUND_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function isBlobLike(value: unknown): value is Blob {
  return typeof Blob !== "undefined" && value instanceof Blob;
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) {
    throw new Error("invalid data url");
  }
  const header = dataUrl.slice(0, comma);
  const base64 = dataUrl.slice(comma + 1);
  const mime = /data:([^;]+);/i.exec(header)?.[1] ?? "image/png";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

async function normalizeStoredImage(value: unknown): Promise<Blob | null> {
  if (isBlobLike(value) && value.size > 0) {
    return value;
  }
  if (typeof value === "string" && value.length > 0) {
    try {
      const blob = value.startsWith("data:") ? dataUrlToBlob(value) : await fetch(value).then((r) => r.blob());
      if (blob.size > 0) {
        await setBackgroundImageBlob(blob);
        return blob;
      }
    } catch (e) {
      console.warn("[settings] 背景图格式迁移失败", e);
    }
  }
  return null;
}

export async function getBackgroundImageBlob(): Promise<Blob | null> {
  try {
    const db = await openAppearanceBackgroundDb();
    const raw = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(APPEARANCE_BACKGROUND_STORE, "readonly");
      const req = tx.objectStore(APPEARANCE_BACKGROUND_STORE).get(
        APPEARANCE_BACKGROUND_IMAGE_KEY,
      );
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("indexedDB get failed"));
    });
    return await normalizeStoredImage(raw);
  } catch (e) {
    console.warn("[settings] 读取背景图（IndexedDB）失败", e);
    return null;
  }
}

export async function setBackgroundImageBlob(blob: Blob): Promise<void> {
  const db = await openAppearanceBackgroundDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(APPEARANCE_BACKGROUND_STORE, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("indexedDB write failed"));
    tx.objectStore(APPEARANCE_BACKGROUND_STORE).put(blob, APPEARANCE_BACKGROUND_IMAGE_KEY);
  });
}

export async function deleteBackgroundImage(): Promise<void> {
  try {
    const db = await openAppearanceBackgroundDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(APPEARANCE_BACKGROUND_STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("indexedDB delete failed"));
      tx.objectStore(APPEARANCE_BACKGROUND_STORE).delete(APPEARANCE_BACKGROUND_IMAGE_KEY);
    });
  } catch (e) {
    console.warn("[settings] 清除背景图（IndexedDB）失败", e);
  }
}

export type HydratedBackgroundConfig = {
  /** 运行时 blob: URL，用于 CSS（避免巨大 data: 写入 --app-bg） */
  imageObjectUrl?: string;
  /** 内存中的 Blob，用于持久化；不写入 localStorage */
  imageBlob?: Blob;
  /** @deprecated 仅从旧版 localStorage 读取时短暂存在 */
  imageDataUrl?: string;
  /** 同步首帧预览，保留在 localStorage */
  bootstrapDataUrl?: string;
  hasStoredImage?: boolean;
  opacity: number;
  blur: number;
};

export function createBackgroundObjectUrl(blob: Blob): string {
  return URL.createObjectURL(blob);
}

export function revokeBackgroundObjectUrl(url: string | undefined): void {
  if (url && url.startsWith("blob:")) {
    URL.revokeObjectURL(url);
  }
}

/** 从 localStorage 片段 + IndexedDB 拼出完整背景配置 */
export async function hydrateBackgroundConfig(
  bg: HydratedBackgroundConfig,
): Promise<HydratedBackgroundConfig> {
  const legacyInline = bg.imageDataUrl?.length ? bg.imageDataUrl : undefined;

  if (legacyInline) {
    try {
      const blob = dataUrlToBlob(legacyInline);
      await setBackgroundImageBlob(blob);
      const imageObjectUrl = createBackgroundObjectUrl(blob);
      return {
        opacity: bg.opacity,
        blur: bg.blur,
        hasStoredImage: true,
        imageObjectUrl,
        imageBlob: blob,
        bootstrapDataUrl: bg.bootstrapDataUrl,
      };
    } catch (e) {
      console.warn("[settings] 迁移背景图到 IndexedDB 失败", e);
      return { opacity: bg.opacity, blur: bg.blur, hasStoredImage: false };
    }
  }

  if (bg.hasStoredImage) {
    const blob = await getBackgroundImageBlob();
    if (blob) {
      const imageObjectUrl = createBackgroundObjectUrl(blob);
      return {
        opacity: bg.opacity,
        blur: bg.blur,
        hasStoredImage: true,
        imageObjectUrl,
        imageBlob: blob,
        bootstrapDataUrl: bg.bootstrapDataUrl,
      };
    }
    return {
      opacity: bg.opacity,
      blur: bg.blur,
      hasStoredImage: false,
    };
  }

  if (bg.imageObjectUrl) {
    return {
      opacity: bg.opacity,
      blur: bg.blur,
      hasStoredImage: true,
      imageObjectUrl: bg.imageObjectUrl,
      imageBlob: bg.imageBlob,
      bootstrapDataUrl: bg.bootstrapDataUrl,
    };
  }

  return {
    opacity: bg.opacity,
    blur: bg.blur,
    hasStoredImage: false,
  };
}
