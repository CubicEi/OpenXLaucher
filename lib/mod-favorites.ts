import { readMigratedLocalStorage } from "@/lib/storage-migrate";

export interface ModFavorite {
  id: string;
  slug: string;
  name: string;
  versionLabel: string;
  mcVersion: string;
  modLoader: string;
  downloadUrl: string;
  addedAt: number;
}

const STORAGE_KEY = "openxlauncher.mod-favorites.v1";
const LEGACY_STORAGE_KEYS = ["rtlauncher.mod-favorites.v1"] as const;
const CHANGE_EVENT = "openxlauncher:mod-favorites-changed";

export function readModFavorites(): ModFavorite[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = readMigratedLocalStorage(STORAGE_KEY, LEGACY_STORAGE_KEYS);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isModFavorite) : [];
  } catch {
    return [];
  }
}

export function writeModFavorites(favorites: ModFavorite[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(favorites));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function modFavoritesChangeEvent() {
  return CHANGE_EVENT;
}

function isModFavorite(value: unknown): value is ModFavorite {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ModFavorite>;
  return [
    candidate.id,
    candidate.slug,
    candidate.name,
    candidate.versionLabel,
    candidate.mcVersion,
    candidate.modLoader,
    candidate.downloadUrl,
  ].every((field) => typeof field === "string") && typeof candidate.addedAt === "number";
}
