/**
 * Resolve download cache `resourceKind` from file extension + browse context.
 * Mirrors `handler/resource_kind_resolve.rs`.
 */

export type ResourceKindWire =
  | "mod"
  | "resourcepack"
  | "shaderpack"
  | "datapack"
  | "modpack"
  | "world";

function fileExtensionLower(fileName: string): string | null {
  const base = fileName.trim().split(/[/\\]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot < 0 || dot + 1 >= base.length) return null;
  return base.slice(dot + 1).toLowerCase();
}

function browseCategoryToKind(category: string): ResourceKindWire | null {
  const c = category.trim().toLowerCase();
  const map: Record<string, ResourceKindWire> = {
    mod: "mod",
    mods: "mod",
    resourcepack: "resourcepack",
    resourcepacks: "resourcepack",
    shaders: "shaderpack",
    shader: "shaderpack",
    shaderpack: "shaderpack",
    shaderpacks: "shaderpack",
    datapack: "datapack",
    datapacks: "datapack",
    "data pack": "datapack",
    "data-pack": "datapack",
    modpack: "modpack",
    modpacks: "modpack",
    world: "world",
    worlds: "world",
  };
  return map[c] ?? null;
}

function apiProjectTypeToKind(projectType: string): ResourceKindWire | null {
  const pt = projectType.trim().toLowerCase();
  if (!pt || pt === "mod" || pt === "minecraft") return null;
  if (pt.includes("resourcepack") || pt.includes("resource pack") || pt.includes("texture")) {
    return "resourcepack";
  }
  if (pt.includes("shader")) return "shaderpack";
  if (pt.includes("datapack") || pt.includes("data pack") || pt.includes("data-pack")) {
    return "datapack";
  }
  if (pt.includes("modpack") || pt.includes("mod pack")) return "modpack";
  if (pt.includes("world") || pt.includes("map")) return "world";
  return null;
}

export function resolveResourceKindForDownload(
  fileName: string,
  hintKind?: string | null,
  browseCategory?: string | null,
  apiProjectType?: string | null,
): ResourceKindWire {
  const ext = fileExtensionLower(fileName);
  if (ext === "jar" || ext === "litemod") return "mod";

  const browse = browseCategory ? browseCategoryToKind(browseCategory) : null;
  if (browse && browse !== "mod") return browse;

  const hint = hintKind ? browseCategoryToKind(hintKind) : null;
  if (hint && hint !== "mod") return hint;

  const api = apiProjectType ? apiProjectTypeToKind(apiProjectType) : null;
  if (api) return api;

  if (hint) return hint;

  if (ext === "zip" || ext === "rar" || ext === "7z") return "resourcepack";

  return "mod";
}

/** Map game-settings cacheKind to update API resource_kind. */
export function cacheKindToUpdateResourceKind(cacheKind: string): ResourceKindWire {
  const k = cacheKind.trim().toLowerCase();
  if (k === "mod" || k === "mods") return "mod";
  if (k === "resourcepack" || k === "resourcepacks") return "resourcepack";
  if (k === "shaderpack" || k === "shaderpacks" || k === "shader") return "shaderpack";
  if (k === "datapack" || k === "datapacks") return "datapack";
  return "mod";
}
