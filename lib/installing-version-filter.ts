import type { DownloadTask } from "@/components/download/download-provider";

function isActiveInstall(task: DownloadTask): boolean {
  return task.status === "downloading" || task.status === "queued";
}

/**
 * Hide version folders that are mid-install (staging vanilla, loader intermediates, incomplete instance).
 */
export function shouldHideVersionDuringInstall(
  versionName: string,
  tasks: DownloadTask[]
): boolean {
  const name = versionName.trim();
  if (!name) return false;

  for (const task of tasks) {
    if (!isActiveInstall(task)) continue;

    const mc = task.mcVersion?.trim();
    if (!mc || mc === "Java" || mc === "整合包") continue;

    const target = task.targetInstanceName?.trim();

    // Staging vanilla folder (versions/{mcVersion})
    if (name === mc) {
      return true;
    }

    // Final instance directory still being assembled
    if (target && name === target) {
      return true;
    }

    // Loader / OptiFine intermediate dirs under the same MC version
    if (name.startsWith(`${mc}-`) || name.startsWith(`${mc}_`)) {
      if (target && name === target) {
        continue;
      }
      return true;
    }
  }

  return false;
}

export function filterInstancesDuringInstall<T extends { name: string }>(
  items: T[],
  tasks: DownloadTask[]
): T[] {
  if (!tasks.some(isActiveInstall)) return items;
  return items.filter((item) => !shouldHideVersionDuringInstall(item.name, tasks));
}
