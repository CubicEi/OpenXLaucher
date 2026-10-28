/** Persist across Tauri same-section `location.assign` remounts. */
const STORAGE_KEY = "oxl:skip-section-chrome";

/** Mark next mount of this section's chrome to skip float (in-section tab switch). */
export function markSkipSectionChrome(sectionKey: string) {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(STORAGE_KEY, sectionKey);
  } catch {
    /* private mode / quota */
  }
}

/** Clear stale skip so a later true section-enter can animate. */
export function clearSkipSectionChrome() {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Consume skip for this section. Returns true if chrome should render static
 * (same-section remount).
 */
export function consumeSkipSectionChrome(sectionKey: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const value = sessionStorage.getItem(STORAGE_KEY);
    if (value === sectionKey) {
      sessionStorage.removeItem(STORAGE_KEY);
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}
