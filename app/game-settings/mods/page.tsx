"use client";

import React, { useState, useEffect, Suspense } from "react";
import { motion } from "framer-motion";
import {
  Puzzle,
  Package,
  ArrowLeft,
  BookOpen,
  Tag,
  Link as LinkIcon,
  ExternalLink,
  GitBranch,
  AlertTriangle,
  Users,
  Loader2,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import ResourcePanel, { ModInfo } from "@/components/resource-panel";
import { useResourcePage, ResourcePageFallback } from "@/components/resource-page-factory";
import { fadeSlideUp } from "@/lib/motion";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/components/i18n/use-i18n";
import { ModRemoteVersionsSection } from "@/components/mods/mod-remote-versions-section";
import { ModCoverImage } from "@/components/mods/mod-cover-image";
import { useInstanceResourceUpdates } from "@/hooks/use-instance-resource-updates";
import {
  buildModAbsolutePath,
  openModDownloadDetail,
  type ModFileSide,
} from "@/lib/mods/mod-download-navigation";

function normalizeModInfo(info: ModInfo, fileName: string): ModInfo {
  const stem = fileName.replace(/\.(jar|litemod|zip)$/i, "");
  return {
    ...info,
    file_name: info.file_name || fileName,
    mod_id: info.mod_id || stem,
    name: info.name || stem,
    version: info.version || "unknown",
    authors: info.authors ?? [],
    dependencies: info.dependencies ?? [],
    optional_dependencies: info.optional_dependencies ?? [],
    incompatible_dependencies: info.incompatible_dependencies ?? [],
  };
}

const MODS_CONFIG = {
  title: "panel.mods" as const,
  leftIcon: <Puzzle className="size-5 text-emerald-500" />,
  leftIconBg: "bg-emerald-500/10",
  leftIconColor: "text-emerald-500",
  instanceSubdir: "mods",
  cacheKind: "mod",
  needsModLoader: true,
  enableInstanceRename: false,
  extensions: ["jar", "litemod", "zip"],
  simplifyName: (name: string) => name.replace(/\.(jar|litemod|zip)$/i, ""),
};

/**
 * 模组详情子页面 - 显示完整的元数据和依赖项
 */
function ModDetailPage({
  fileName,
  info,
  fileSide,
  instanceDir,
  modCacheDir,
  mcVersion,
  modLoader,
  onBack,
  onRefresh,
}: {
  fileName: string;
  info: ModInfo;
  fileSide: ModFileSide;
  instanceDir: string;
  modCacheDir?: string;
  mcVersion: string;
  modLoader: string;
  onBack: () => void;
  onRefresh: () => void;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const safeInfo = normalizeModInfo(info, fileName);
  const modPath = buildModAbsolutePath(fileName, fileSide, instanceDir, modCacheDir);

  const [openingDownload, setOpeningDownload] = useState(false);

  const openDownloadDetail = async () => {
    if (!modPath || openingDownload) return;
    setOpeningDownload(true);
    try {
      await openModDownloadDetail({
        router,
        modPath,
        fileName,
        modSide: fileSide,
        t,
      });
    } catch {
      (window as Window & { __rt_toast?: (value: string) => void }).__rt_toast?.(
        t("panel.modUpdateHashMiss"),
      );
    } finally {
      setOpeningDownload(false);
    }
  };

  return (
    <motion.div
      variants={fadeSlideUp}
      initial="initial"
      animate="animate"
      className="flex h-full flex-col p-4 overflow-hidden gap-4"
    >
      {/* 顶部栏 */}
      <div className="shrink-0 flex items-center gap-3">
        <Button variant="ghost" size="icon" className="size-9 shrink-0" onClick={onBack} title="返回列表">
          <ArrowLeft className="size-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-base font-semibold truncate">{safeInfo.name}</h1>
          <p className="text-xs text-muted-foreground truncate">
            {safeInfo.mod_id} · v{safeInfo.version}
            {safeInfo.mod_loader && ` · ${safeInfo.mod_loader}`}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-9 shrink-0 bg-background"
          title={t("gameSettings.modDetail.openInDownload")}
          aria-label={t("gameSettings.modDetail.openInDownload")}
          disabled={!modPath || openingDownload}
          onClick={() => void openDownloadDetail()}
        >
          {openingDownload ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <ExternalLink className="size-4" />
          )}
        </Button>
        <Badge variant="secondary" className="shrink-0 text-xs">
          {t("gameSettings.modDetail.badge")}
        </Badge>
      </div>

      {/* 内容区 */}
      <motion.div
        variants={fadeSlideUp}
        initial="initial"
        animate="animate"
        className="flex-1 overflow-y-auto border rounded-xl bg-card"
      >
        <div className="p-5 space-y-5">
          {/* 头部信息卡 */}
          <div className="flex items-start gap-4 pb-5 border-b">
            <ModCoverImage modPath={modPath} modIdHint={safeInfo.mod_id} />
            <div className="flex-1 min-w-0">
              <h2 className="text-2xl font-bold truncate">{safeInfo.name}</h2>
              <p className="mt-1.5 text-sm text-muted-foreground truncate">
                {safeInfo.mod_id} · v{safeInfo.version}
                {safeInfo.mod_loader && ` · ${safeInfo.mod_loader}`}
              </p>
              {safeInfo.authors.length > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  作者: {safeInfo.authors.join(", ")}
                </p>
              )}
            </div>
          </div>

          {/* 描述 */}
          {safeInfo.description && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <BookOpen className="size-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">描述</h3>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">
                {safeInfo.description}
              </p>
            </div>
          )}

          {/* 基本信息 */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Tag className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">基本信息</h3>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {safeInfo.license && (
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">协议</p>
                  <p className="text-sm font-medium mt-0.5">{safeInfo.license}</p>
                </div>
              )}
              {safeInfo.minecraft_version && (
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">MC 版本</p>
                  <p className="text-sm font-medium mt-0.5">{safeInfo.minecraft_version}</p>
                </div>
              )}
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">文件</p>
                <p className="text-sm font-medium mt-0.5 truncate" title={fileName}>
                  {fileName}
                </p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">Mod ID</p>
                <p className="text-sm font-medium mt-0.5">{safeInfo.mod_id}</p>
              </div>
            </div>
          </div>

          {/* 链接 */}
          {(safeInfo.homepage || safeInfo.source || safeInfo.issues) && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <LinkIcon className="size-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">链接</h3>
              </div>
              <div className="space-y-2">
                {safeInfo.homepage && (
                  <a
                    href={safeInfo.homepage}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-sm text-primary hover:underline"
                  >
                    <ExternalLink className="size-3.5" />
                    主页
                  </a>
                )}
                {safeInfo.source && (
                  <a
                    href={safeInfo.source}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-sm text-primary hover:underline"
                  >
                    <GitBranch className="size-3.5" />
                    源代码
                  </a>
                )}
                {safeInfo.issues && (
                  <a
                    href={safeInfo.issues}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-sm text-primary hover:underline"
                  >
                    <AlertTriangle className="size-3.5" />
                    问题反馈
                  </a>
                )}
              </div>
            </div>
          )}

          {/* 必需依赖 */}
          {safeInfo.dependencies.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Package className="size-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">必需依赖 ({safeInfo.dependencies.length})</h3>
              </div>
              <div className="space-y-2">
                {safeInfo.dependencies.map((dep) => (
                  <div key={dep.mod_id} className="rounded-lg border p-3 flex items-center gap-3">
                    <div className="size-2 rounded-full bg-destructive shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{dep.mod_id}</p>
                      {dep.version_range && (
                        <p className="text-xs text-muted-foreground">版本: {dep.version_range}</p>
                      )}
                      {(dep.side || dep.ordering) && (
                        <p className="text-xs text-muted-foreground">
                          {[dep.side, dep.ordering].filter(Boolean).join(" · ")}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 可选依赖 */}
          {safeInfo.optional_dependencies.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Users className="size-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">可选/推荐 ({safeInfo.optional_dependencies.length})</h3>
              </div>
              <div className="space-y-2">
                {safeInfo.optional_dependencies.map((dep) => (
                  <div key={dep.mod_id} className="rounded-lg border p-3 flex items-center gap-3">
                    <div className="size-2 rounded-full bg-amber-500 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{dep.mod_id}</p>
                      {dep.version_range && (
                        <p className="text-xs text-muted-foreground">版本: {dep.version_range}</p>
                      )}
                      {(dep.side || dep.ordering) && (
                        <p className="text-xs text-muted-foreground">
                          {[dep.side, dep.ordering].filter(Boolean).join(" · ")}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 不兼容依赖 */}
          {safeInfo.incompatible_dependencies.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="size-4 text-red-500" />
                <h3 className="text-sm font-semibold text-red-500">不兼容 ({safeInfo.incompatible_dependencies.length})</h3>
              </div>
              <div className="space-y-2">
                {safeInfo.incompatible_dependencies.map((dep) => (
                  <div key={dep.mod_id} className="rounded-lg border border-red-200 p-3 flex items-center gap-3 bg-red-50">
                    <div className="size-2 rounded-full bg-red-500 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{dep.mod_id}</p>
                      {dep.version_range && (
                        <p className="text-xs text-muted-foreground">版本: {dep.version_range}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 若无依赖信息 */}
          {safeInfo.dependencies.length === 0 && safeInfo.optional_dependencies.length === 0 && safeInfo.incompatible_dependencies.length === 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Package className="size-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">依赖</h3>
              </div>
              <p className="text-sm text-muted-foreground">该模组无声明的依赖项</p>
            </div>
          )}

          <ModRemoteVersionsSection
            fileName={fileName}
            info={safeInfo}
            instanceDir={instanceDir}
            modCacheDir={modCacheDir}
            fileSide={fileSide}
            mcVersion={mcVersion}
            modLoader={modLoader}
            onInstalled={onRefresh}
          />
        </div>
      </motion.div>
    </motion.div>
  );
}

export default function ModsPage() {
  return (
    <Suspense
      fallback={
        <ResourcePageFallback
          title="pageFactory.loadingConfiguration"
          subtitle="pageFactory.pleaseWait"
        />
      }
    >
      <ModsPageContent />
    </Suspense>
  );
}

function ModsPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { panel, loadingState, extra } = useResourcePage(MODS_CONFIG);
  const [view, setView] = useState<"list" | "detail">("list");
  const [selectedDetail, setSelectedDetail] = useState<{
    fileName: string;
    info: ModInfo;
    side: "left" | "right";
  } | null>(null);

  useEffect(() => {
    const modFile = searchParams.get("modFile")?.trim();
    if (!modFile || view === "detail") return;
    const sideParam = searchParams.get("modSide");
    const side: "left" | "right" =
      sideParam === "cache" ? "right" : "left";
    const infoMap = side === "right" ? extra.cacheModInfo : extra.instanceModInfo;
    const info = infoMap.get(modFile);
    if (!info) return;
    setSelectedDetail({ fileName: modFile, info, side });
    setView("detail");
    router.replace("/game-settings/mods");
  }, [searchParams, extra.instanceModInfo, extra.cacheModInfo, view, router]);

  const updates = useInstanceResourceUpdates({
    resourceKind: "mod",
    needsLoader: true,
    instanceDir: extra.instanceDir,
    mcVersion: extra.mcVersion,
    modLoader: extra.modLoader,
    onRefresh: extra.refresh,
  });

  // 准备中状态：configLoaded=true 但 instances 还在扫描 / minecraftPath 待定
  const [preparingTimeout, setPreparingTimeout] = useState(false);
  useEffect(() => {
    if (!loadingState.configLoaded) return;
    const t = window.setTimeout(() => setPreparingTimeout(true), 1200);
    return () => window.clearTimeout(t);
  }, [loadingState.configLoaded]);

  const blockingInstanceScan =
    loadingState.instancesScanning && !loadingState.instanceDir;
  if (
    !loadingState.configLoaded ||
    (loadingState.configLoaded &&
      !preparingTimeout &&
      (blockingInstanceScan || !loadingState.minecraftPath))
  ) {
    return (
      <ResourcePageFallback
        title="pageFactory.loadingConfiguration"
        subtitle="pageFactory.pleaseWait"
      />
    );
  }

  if (!loadingState.minecraftPath) {
    return (
      <ResourcePageFallback
        title="pageFactory.gameDirectoryIsNotConfigured"
        subtitle="pageFactory.configureTheMinecraftGameDirectoryOnTheLaunchPage"
      />
    );
  }

  // ============ 详情子页面 ============
  if (view === "detail" && selectedDetail) {
    return (
      <ModDetailPage
        fileName={selectedDetail.fileName}
        info={selectedDetail.info}
        fileSide={selectedDetail.side === "right" ? "cache" : "instance"}
        instanceDir={extra.instanceDir ?? ""}
        modCacheDir={extra.modCacheDir}
        mcVersion={extra.mcVersion ?? ""}
        modLoader={extra.modLoader ?? ""}
        onRefresh={() => extra.refresh()}
        onBack={() => {
          setSelectedDetail(null);
          setView("list");
        }}
      />
    );
  }

  // ============ 列表主页面 ============
  const handleOpenDetail = (fileName: string, info: ModInfo, side: "left" | "right") => {
    setSelectedDetail({ fileName, info, side });
    setView("detail");
  };

  const leftDescription = updates.checkMessage
    ? `${panel.leftDescription} · ${updates.checkMessage}`
    : panel.leftDescription;

  return (
    <ResourcePanel
      {...panel}
      leftDescription={leftDescription}
      onOpenModDetail={handleOpenDetail}
      modUpdates={updates.modUpdatesForPanel}
      onCheckUpdates={updates.handleCheckUpdates}
      checkingUpdates={updates.checkingUpdates}
      onUpdateAll={updates.handleUpdateAll}
      onUpdateOne={updates.handleUpdateOne}
      updatingFiles={updates.updatingFiles}
    />
  );
}
