import {
  deleteBackgroundImage,
  setBackgroundImageBlob,
} from "@/lib/appearance-background-idb";
import { createBootstrapBackgroundDataUrl } from "@/lib/appearance-background-bootstrap-preview";
import {
  SETTINGS_STORAGE_KEY,
  type BackgroundConfig,
  type LauncherSettings,
} from "@/components/settings/settings-provider";

function backgroundHasImage(bg: BackgroundConfig): boolean {
  return !!bg.hasStoredImage || (!!bg.imageObjectUrl && bg.imageObjectUrl.length > 0);
}

function readStoredBootstrapDataUrl(): string | undefined {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return undefined;
    const value = JSON.parse(raw)?.appearance?.background?.bootstrapDataUrl;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function settingsForLocalStorage(settings: LauncherSettings): LauncherSettings {
  const bg = settings.appearance.background;
  const hasImage = backgroundHasImage(bg);
  const bootstrapDataUrl = hasImage
    ? bg.bootstrapDataUrl || readStoredBootstrapDataUrl()
    : undefined;
  return {
    ...settings,
    appearance: {
      ...settings.appearance,
      background: {
        opacity: bg.opacity,
        blur: bg.blur,
        hasStoredImage: hasImage,
        ...(bootstrapDataUrl ? { bootstrapDataUrl } : {}),
      },
    },
  };
}

/** 写入 IndexedDB + localStorage（含同步首帧预览，不含运行时 blob URL） */
export async function persistLauncherBackground(settings: LauncherSettings): Promise<void> {
  const bg = settings.appearance.background;
  if (backgroundHasImage(bg)) {
    let blob = bg.imageBlob;
    if (!blob && bg.imageObjectUrl) {
      blob = await fetch(bg.imageObjectUrl).then((r) => r.blob());
    }
    if (blob && blob.size > 0) {
      await setBackgroundImageBlob(blob);
      const bootstrapDataUrl =
        bg.bootstrapDataUrl || (await createBootstrapBackgroundDataUrl(blob));
      localStorage.setItem(
        SETTINGS_STORAGE_KEY,
        JSON.stringify(
          settingsForLocalStorage({
            ...settings,
            appearance: {
              ...settings.appearance,
              background: {
                ...bg,
                imageBlob: blob,
                bootstrapDataUrl,
                hasStoredImage: true,
              },
            },
          }),
        ),
      );
      return;
    }
  } else {
    await deleteBackgroundImage();
  }
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settingsForLocalStorage(settings)));
}
