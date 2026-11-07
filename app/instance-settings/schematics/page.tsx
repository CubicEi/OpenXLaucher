"use client";

import React, { useCallback } from "react";
import { motion } from "framer-motion";
import { Boxes, Package } from "lucide-react";
import { CACHE_LIBRARY_ICON_BG, CacheLibraryIcon } from "@/components/resource/cache-library-icon";
import { useRouter } from "next/navigation";
import ResourcePanel from "@/components/resource-panel";
import { useInstancePath } from "@/hooks/use-instance-path";
import { useResourceManager } from "@/hooks/use-resource-manager";
import { fadeSlideUp } from "@/lib/motion";
import { FileItem } from "@/components/resource-panel";
import { openSchematicViewer } from "@/lib/open-schematic-viewer";

export default function SchematicsPage() {
  const router = useRouter();
  const { instanceDir, selectedInstance, minecraftPath, configLoaded } = useInstancePath();

  const viewerExtensions = ["schem", "schematic", "litematic", "nbt"];

  const schematicSubtitle = useCallback((file: FileItem) => {
    const dot = file.name.lastIndexOf(".");
    const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : "—";
    const sizeKb = file.size > 0 ? `${(file.size / 1024).toFixed(1)} KB` : "";
    return [`.${ext}`, sizeKb].filter(Boolean).join(" · ");
  }, []);

  const handleOpenViewer = useCallback(
    async (
      file: FileItem,
      side: "left" | "right",
      context?: { instanceRelativePath?: string[] },
    ) => {
      if (!file || file.isDir) return;
      try {
        await openSchematicViewer(router, file, side, {
          instanceDir,
          instanceSubdir: "schematics",
          instanceRelativePath: context?.instanceRelativePath,
          minecraftVersion: selectedInstance?.minecraft_version,
          source: "instance-settings",
        });
      } catch (e) {
        console.error("预览打开失败", e);
      }
    },
    [instanceDir, router, selectedInstance],
  );

  const {
    filteredInstanceFiles,
    filteredCacheFiles,
    instanceLoading,
    cacheLoading,
    instanceError,
    cacheError,
    addToInstance,
    removeFromInstance,
    refresh,
    instanceSearch,
    setInstanceSearch,
    cacheSearch,
    setCacheSearch,
    instanceFiles,
    cacheFiles,
    openInstanceDirectory,
    goToParentInstanceDirectory,
    instanceDirectoryPath,
    openInstanceFolderInExplorer,
    clearCacheLibrary,
    deleteFromInstance,
    deleteFromCache,
    uploadFiles,
  } = useResourceManager(
    instanceDir,
    "schematics",
    "world",
    selectedInstance?.minecraft_version,
    undefined,
    ["schem", "schematic", "litematic", "nbt"],
    true,
  );

  if (!configLoaded) {
    return (
      <motion.div
        variants={fadeSlideUp}
        initial="initial"
        animate="animate"
        className="flex h-full flex-col items-center justify-center gap-3 text-center p-4"
      >
        <div className="size-12 rounded-full bg-muted flex items-center justify-center">
          <Package className="size-6 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium">正在加载配置...</p>
        <p className="text-xs text-muted-foreground">请稍候</p>
      </motion.div>
    );
  }

  if (!minecraftPath || !instanceDir) {
    return (
      <motion.div
        variants={fadeSlideUp}
        initial="initial"
        animate="animate"
        className="flex h-full flex-col items-center justify-center gap-3 text-center p-4"
      >
        <div className="size-12 rounded-full bg-muted flex items-center justify-center">
          <Package className="size-6 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium">未配置游戏目录</p>
        <p className="text-xs text-muted-foreground">请先在「启动」页面配置游戏目录路径</p>
      </motion.div>
    );
  }

  return (
    <ResourcePanel
      leftTitle="Schematics 管理"
      leftDescription={
        selectedInstance
          ? `${selectedInstance.name} · ${instanceFiles.length} 个文件`
          : "请选择一个实例"
      }
      leftIcon={<Boxes className="size-5 text-rose-500" />}
      leftIconBg="bg-rose-500/10"
      leftFiles={filteredInstanceFiles}
      leftLoading={instanceLoading}
      leftError={instanceError}
      leftSearch={instanceSearch}
      setLeftSearch={setInstanceSearch}
      leftBadge={`${instanceFiles.length} 个`}
      leftDirectoryPath={instanceDirectoryPath}
      onOpenLeftDirectory={openInstanceDirectory}
      onNavigateUpLeft={goToParentInstanceDirectory}
      rightTitle=""
      rightIcon={<CacheLibraryIcon />}
      rightIconBg={CACHE_LIBRARY_ICON_BG}
      rightFiles={filteredCacheFiles}
      rightLoading={cacheLoading}
      rightError={cacheError}
      rightSearch={cacheSearch}
      setRightSearch={setCacheSearch}
      rightBadge={`${cacheFiles.length} 个`}
      onMoveRightToLeft={addToInstance}
      onMoveLeftToRight={removeFromInstance}
      onDeleteLeft={deleteFromInstance}
      onDeleteRight={deleteFromCache}
      onUploadFiles={uploadFiles}
      onOpenInstanceFolder={openInstanceFolderInExplorer}
      onClearCache={clearCacheLibrary}
      onRefresh={refresh}
      onOpenViewer={handleOpenViewer}
      viewerExtensions={viewerExtensions}
      getFileSubtitle={schematicSubtitle}
      simplifyName={(name) => name.replace(/\.(schem|schematic|litematic|nbt)$/i, "")}
    />
  );
}