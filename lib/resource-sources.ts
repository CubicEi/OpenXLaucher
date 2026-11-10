import catalog from "@/lib/data/resource_sources.json";

export type ResourceSourceMode = "integrated_search" | "link_only";

export interface ResourceSourceEntry {
  id: string;
  nameZh: string;
  nameEn: string;
  url: string;
  resourceKinds: string[];
  mode: ResourceSourceMode;
}

const ENTRIES = catalog as ResourceSourceEntry[];

const EXCLUDED_IDS = new Set([
  "mcpedl",
  "mcpe_planet",
  "github_topics",
  "geyser",
  "mcversions",
  "minecraftcapes",
]);

const BROWSE_CATEGORIES = [
  "mod",
  "modpack",
  "resourcepack",
  "shaders",
  "datapack",
  "worlds",
  "schematic",
] as const;

export type LinkSiteBrowseCategory = (typeof BROWSE_CATEGORIES)[number];

export function listLinkOnlySites(category: string): ResourceSourceEntry[] {
  const cat = category.trim().toLowerCase();
  return ENTRIES.filter(
    (e) =>
      e.mode === "link_only" &&
      !EXCLUDED_IDS.has(e.id) &&
      e.resourceKinds.some((k) => k === cat || (cat === "shaders" && k === "shaders")),
  );
}

export function listLinkOnlySitesGrouped(): { category: LinkSiteBrowseCategory; sites: ResourceSourceEntry[] }[] {
  return BROWSE_CATEGORIES.map((category) => ({
    category,
    sites: listLinkOnlySites(category),
  })).filter((group) => group.sites.length > 0);
}

export function sourceDisplayName(entry: ResourceSourceEntry, locale: string): string {
  return locale.startsWith("zh") ? entry.nameZh : entry.nameEn;
}
