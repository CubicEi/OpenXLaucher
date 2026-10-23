/** 与 Rust `JAVA_AUTO_SELECT_PATH` 保持一致 */
export const JAVA_AUTO_SELECT_PATH = "@openxlauncher/auto-java";

export function isAutoJavaSelection(path: string | undefined | null): boolean {
  if (!path) return true;
  return path === JAVA_AUTO_SELECT_PATH;
}
