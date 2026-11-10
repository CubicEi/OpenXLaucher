import {
  deleteBackgroundImage,
  setBackgroundImageBlob,
} from "@/lib/appearance-background-idb";
import {
  SETTINGS_STORAGE_KEY,
  type BackgroundConfig,
  type LauncherSettings,
} from "@/components/settings/settings-provider";

function backgroundHasImage(bg: BackgroundConfig): boolean {
  return !!bg.imageObjectUrl && bg.imageObjectUrl.length > 0;
}

export function settingsForLocalStorage(settings: LauncherSettings): LauncherSettings {
  const bg = settings.appearance.background;
  const hasImage = backgroundHasImage(bg);
  return {
    ...settings,
    appearance: {
      ...settings.appearance,
      background: {
        opacity: bg.opacity,
        blur: bg.blur,
        hasStoredImage: hasImage,
      },
    },
  };
}

/** 写入 IndexedDB + localStorage（不含 imageObjectUrl） */
export async function persistLauncherBackground(settings: LauncherSettings): Promise<void> {
  const bg = settings.appearance.background;
  if (backgroundHasImage(bg)) {
    let blob = bg.imageBlob;
    if (!blob && bg.imageObjectUrl) {
      blob = await fetch(bg.imageObjectUrl).then((r) => r.blob());
    }
    if (blob && blob.size > 0) {
      await setBackgroundImageBlob(blob);
    }
  } else {
    await deleteBackgroundImage();
  }
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settingsForLocalStorage(settings)));
}
