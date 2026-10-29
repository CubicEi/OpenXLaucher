import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { invoke } from "@tauri-apps/api/core";
import { navigateWithMainTransition } from "@/lib/main-navigation-transition";
import type { TranslationKey } from "@/components/i18n/use-i18n";
import type { ResourceKindWire } from "@/lib/resource-kind";

export function buildResourceAbsolutePath(
  fileName: string,
  instanceDir: string,
  instanceSubdir: string,
): string {
  const safeName = fileName.replace(/^\/+/, "");
  const base = instanceDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const sub = instanceSubdir.replace(/^\/+|\/+$/g, "");
  if (!base || !sub) return "";
  return `${base}/${sub}/${safeName}`;
}

export function resourceKindReturnPath(resourceKind: ResourceKindWire): string {
  switch (resourceKind) {
    case "resourcepack":
      return "/game-settings/resources";
    case "shaderpack":
      return "/game-settings/shaders";
    case "datapack":
      return "/game-settings/datapacks";
    default:
      return "/game-settings/mods";
  }
}

export async function openResourceDownloadDetail(params: {
  router: AppRouterInstance;
  resourcePath: string;
  fileName: string;
  resourceKind: ResourceKindWire;
  t: (key: TranslationKey) => string;
}): Promise<boolean> {
  const { router, resourcePath, fileName, resourceKind, t } = params;
  if (!resourcePath) return false;

  const target = await invoke<{ slug: string } | null>("resolve_mod_for_download", {
    modPath: resourcePath,
  });
  if (!target?.slug) {
    (window as Window & { __rt_toast?: (value: string) => void }).__rt_toast?.(
      t("panel.modUpdateHashMiss"),
    );
    return false;
  }

  const query = new URLSearchParams({
    mod: target.slug,
    returnTo: "resourceDetail",
    resourceFile: fileName,
    resourceKind,
    modPath: resourcePath,
  });
  navigateWithMainTransition(router, `/download/detail?${query.toString()}`);
  return true;
}
