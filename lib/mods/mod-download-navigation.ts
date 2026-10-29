import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { invoke } from "@tauri-apps/api/core";
import { navigateWithMainTransition } from "@/lib/main-navigation-transition";
import type { TranslationKey } from "@/components/i18n/use-i18n";

export type ModFileSide = "instance" | "cache";

export function buildModAbsolutePath(
  fileName: string,
  side: ModFileSide,
  instanceDir: string,
  modCacheDir?: string,
): string {
  const safeName = fileName.replace(/^\/+/, "");
  if (side === "cache") {
    const base = (modCacheDir || "").replace(/\\/g, "/").replace(/\/+$/, "");
    return base ? `${base}/${safeName}` : "";
  }
  const base = instanceDir.replace(/\\/g, "/").replace(/\/+$/, "");
  return base ? `${base}/mods/${safeName}` : "";
}

export async function openModDownloadDetail(params: {
  router: AppRouterInstance;
  modPath: string;
  fileName: string;
  modSide: ModFileSide;
  t: (key: TranslationKey) => string;
}): Promise<void> {
  const { router, modPath, fileName, modSide, t } = params;
  if (!modPath) return;

  const target = await invoke<{ slug: string } | null>("resolve_mod_for_download", { modPath });
  if (!target?.slug) {
    (window as Window & { __rt_toast?: (value: string) => void }).__rt_toast?.(
      t("panel.modUpdateHashMiss"),
    );
    return;
  }

  const query = new URLSearchParams({
    mod: target.slug,
    returnTo: "modDetail",
    modFile: fileName,
    modPath,
    modSide,
  });
  navigateWithMainTransition(router, `/download/detail?${query.toString()}`);
}
