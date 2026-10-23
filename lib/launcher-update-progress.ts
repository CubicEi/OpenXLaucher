import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const LAUNCHER_UPDATE_PROGRESS_EVENT = "launcher-update-progress";

export type LauncherUpdateProgressPayload = {
  percent: number;
};

/** Subscribe to backend download progress (0–100). Returns unlisten async fn. */
export async function listenLauncherUpdateProgress(
  onPercent: (percent: number) => void,
): Promise<UnlistenFn> {
  return listen<LauncherUpdateProgressPayload>(LAUNCHER_UPDATE_PROGRESS_EVENT, (event) => {
    const percent = event.payload?.percent;
    if (typeof percent === "number" && Number.isFinite(percent)) {
      onPercent(percent);
    }
  });
}
