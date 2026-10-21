/**
 * Read a localStorage value, migrating from legacy keys when the new key is absent.
 * Writes the migrated value to `newKey` so subsequent reads use the new namespace.
 */
export function readMigratedLocalStorage(
  newKey: string,
  legacyKeys: readonly string[],
): string | null {
  if (typeof window === "undefined") return null;
  try {
    const current = window.localStorage.getItem(newKey);
    if (current != null) return current;
    for (const legacy of legacyKeys) {
      const value = window.localStorage.getItem(legacy);
      if (value != null) {
        window.localStorage.setItem(newKey, value);
        return value;
      }
    }
  } catch {
    /* ignore quota / private mode */
  }
  return null;
}
