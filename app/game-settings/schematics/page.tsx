"use client";

import React, { useCallback } from "react";
import { Map } from "lucide-react";
import { createResourcePage } from "@/components/resource-page-factory";
import {
  GAME_SETTINGS_SCHEMATICS_ICON_BG,
  GAME_SETTINGS_SCHEMATICS_ICON_TEXT,
} from "@/constants/index";
import { useRouter } from "next/navigation";
import { useInstancePath } from "@/hooks/use-instance-path";
import { openSchematicViewer } from "@/lib/open-schematic-viewer";
import type { FileItem } from "@/components/resource-panel";

const SCHEMATIC_EXTS = ["schem", "schematic", "litematic", "nbt"];

function formatSchematicSubtitle(file: FileItem): string {
  const dot = file.name.lastIndexOf(".");
  const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : "—";
  const sizeKb = file.size > 0 ? `${(file.size / 1024).toFixed(1)} KB` : "";
  return [`.${ext}`, sizeKb].filter(Boolean).join(" · ");
}

export default function SchematicsPageWrapper() {
  const router = useRouter();
  const { instanceDir, configLoaded } = useInstancePath();

  const handleOpenViewer = useCallback(
    async (
      file: FileItem,
      side: "left" | "right",
      context?: { instanceRelativePath?: string[] },
    ) => {
      if (!configLoaded || file.isDir) return;
      try {
        await openSchematicViewer(router, file, side, {
          instanceDir,
          instanceSubdir: "schematics",
          instanceRelativePath: context?.instanceRelativePath,
          source: "game-settings",
        });
      } catch (e) {
        console.error("预览打开失败", e);
      }
    },
    [instanceDir, configLoaded, router],
  );

  const ViewerResourcePage = createResourcePage({
    title: "panel.schematics",
    leftIcon: <Map className={`size-5 ${GAME_SETTINGS_SCHEMATICS_ICON_TEXT}`} />,
    leftIconBg: GAME_SETTINGS_SCHEMATICS_ICON_BG,
    leftIconColor: GAME_SETTINGS_SCHEMATICS_ICON_TEXT,
    instanceSubdir: "schematics",
    cacheKind: "world",
    extensions: SCHEMATIC_EXTS,
    directoryNavigation: true,
    simplifyName: (name) => name.replace(/\.(schem|schematic|litematic|nbt)$/i, ""),
    onOpenViewer: handleOpenViewer,
    viewerExtensions: SCHEMATIC_EXTS,
    getFileSubtitle: formatSchematicSubtitle,
  });

  return <ViewerResourcePage />;
}
