import { invoke } from "@tauri-apps/api/core";
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";

export const SCHEMATIC_VIEWER_ROUTE = "/game-settings/schematics/viewer";

export type SchematicViewerSource = "game-settings" | "instance-settings";

export type OpenSchematicViewerContext = {
  instanceDir?: string | null;
  /** Instance subfolder, default `schematics`. */
  instanceSubdir?: string;
  /** Path segments under the instance subfolder (subdirectories). */
  instanceRelativePath?: string[];
  minecraftVersion?: string;
  /** Where the user opened the viewer from (for back navigation). */
  source?: SchematicViewerSource;
};

export type SchematicFileRef = {
  name: string;
  /** Absolute path when already known (cache column). */
  path?: string;
};

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

export async function resolveSchematicAbsolutePath(
  file: SchematicFileRef,
  side: "left" | "right",
  ctx: OpenSchematicViewerContext,
): Promise<string | null> {
  const subdir = ctx.instanceSubdir ?? "schematics";

  if (side === "left") {
    if (!ctx.instanceDir) return null;
    const rel = ctx.instanceRelativePath?.length
      ? `${ctx.instanceRelativePath.map((s) => s.replace(/\\/g, "/")).join("/")}/`
      : "";
    return normalizePath(`${ctx.instanceDir}/${subdir}/${rel}${file.name}`);
  }

  if (typeof file.path === "string" && file.path.trim()) {
    return normalizePath(file.path);
  }

  const cacheRoot = await invoke<string | null>("get_mod_cache_dir_cmd", {
    kind: "world",
    mcVersion: ctx.minecraftVersion ?? "",
    modLoader: "",
  }).catch(() => null);

  if (cacheRoot && file.name) {
    return normalizePath(`${cacheRoot}/${file.name}`);
  }

  return null;
}

/**
 * Navigate to the schematic viewer. Prefer `?path=` so large files do not depend on sessionStorage.
 */
export async function openSchematicViewer(
  router: AppRouterInstance,
  file: SchematicFileRef,
  side: "left" | "right",
  ctx: OpenSchematicViewerContext,
): Promise<void> {
  const absPath = await resolveSchematicAbsolutePath(file, side, ctx);
  if (!absPath) {
    throw new Error("Could not resolve schematic file path");
  }

  const params = new URLSearchParams();
  params.set("path", absPath);
  params.set("name", file.name);
  if (ctx.source) {
    params.set("from", ctx.source);
  }

  router.push(`${SCHEMATIC_VIEWER_ROUTE}?${params.toString()}`);
}

/** Legacy sessionStorage handoff (kept for compatibility). */
export async function openSchematicViewerViaSession(
  router: AppRouterInstance,
  file: SchematicFileRef,
  absPath: string,
  ctx?: Pick<OpenSchematicViewerContext, "source">,
): Promise<void> {
  const b64 = await invoke<string>("read_file_base64", { path: absPath });
  const key = `schematic_viewer:${Date.now()}`;
  sessionStorage.setItem(key, JSON.stringify({ name: file.name, b64, path: absPath }));
  const params = new URLSearchParams();
  params.set("k", key);
  if (ctx?.source) params.set("from", ctx.source);
  router.push(`${SCHEMATIC_VIEWER_ROUTE}?${params.toString()}`);
}

export function schematicViewerBackRoute(from: string | null | undefined): string {
  if (from === "instance-settings") return "/instance-settings/schematics";
  return "/game-settings/schematics";
}
