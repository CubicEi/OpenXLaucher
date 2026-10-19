/** Whether the page is currently running inside a Tauri webview. */
export function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean(
      (window as typeof window & { __TAURI_INTERNALS__?: unknown })
        .__TAURI_INTERNALS__
    )
  );
}
