/** 与后端 `updater::handler::LAUNCHER_UPDATE_TASK_ID` 一致 */
export const LAUNCHER_UPDATE_TASK_ID = 900_001;

export function isLauncherUpdateTask(taskId: number): boolean {
  return taskId === LAUNCHER_UPDATE_TASK_ID;
}
