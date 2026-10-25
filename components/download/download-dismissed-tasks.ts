/**
 * Task IDs the user has cancelled, removed, or cleared from the process list.
 * Backend progress/finished events for these IDs must not recreate UI rows.
 */
const dismissedTaskIds = new Set<number>();

export function dismissTaskIds(...ids: Array<number | undefined | null>): void {
  for (const id of ids) {
    if (typeof id === "number" && Number.isFinite(id)) {
      dismissedTaskIds.add(id);
    }
  }
}

export function isTaskDismissed(taskId: number): boolean {
  return dismissedTaskIds.has(taskId);
}

/** Test / provider remount helper. */
export function clearDismissedTaskIds(): void {
  dismissedTaskIds.clear();
}
