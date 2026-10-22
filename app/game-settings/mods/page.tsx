"use client";

import React, { useState, useEffect, useCallback } from "react";
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
} from "lucide-react";
import ResourcePanel, { ModInfo } from "@/components/resource-panel";
import { useResourcePage, ResourcePageFallback } from "@/components/resource-page-factory";
import { fadeSlideUp } from "@/lib/motion";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@/lib/tauri-runtime";
import {
  useDownloadManager,
  type ModUpdatePayload,
} from "@/components/download/download-provider";
import { useI18n, type TranslationKey } from "@/components/i18n/use-i18n";
import { ModRemoteVersionsSection } from "@/components/mods/mod-remote-versions-section";

const MODS_CONFIG = {
  title: "panel.mods" as const,
  leftIcon: <Puzzle className="size-5 text-emerald-500" />,
  leftIconBg: "bg-emerald-500/10",
  leftIconColor: "text-emerald-500",
  instanceSubdir: "mods",
  cacheKind: "mod",
  needsModLoader: true,
  extensions: ["jar", "litemod", "zip"],
  simplifyName: (name: string) => name.replace(/\.(jar|litemod|zip)$/i, ""),
};

/**
 * 模组详情子页面 - 显示完整的元数据和依赖项
 */
function ModDetailPage({
  fileName,
  info,
  instanceDir,
  mcVersion,
  modLoader,
  onBack,
  onRefresh,
}: {
  fileName: string;
  info: ModInfo;
  instanceDir: string;
  mcVersion: string;
  modLoader: string;
  onBack: () => void;
  onRefresh: () => void;
}) {
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
          <h1 className="text-base font-semibold truncate">{info.name}</h1>
          <p className="text-xs text-muted-foreground truncate">
            {info.mod_id} · v{info.version}
            {info.mod_loader && ` · ${info.mod_loader}`}
          </p>
        </div>
        <Badge variant="secondary" className="shrink-0 text-xs">模组详情</Badge>
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
            <div className="size-14 rounded-2xl bg-emerald-500/10 flex items-center justify-center shrink-0">
              <Package className="size-7 text-emerald-500" />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-2xl font-bold truncate">{info.name}</h2>
              <p className="mt-1.5 text-sm text-muted-foreground truncate">
                {info.mod_id} · v{info.version}
                {info.mod_loader && ` · ${info.mod_loader}`}
              </p>
              {info.authors.length > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  作者: {info.authors.join(", ")}
                </p>
              )}
            </div>
          </div>

          {/* 描述 */}
          {info.description && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <BookOpen className="size-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">描述</h3>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">
                {info.description}
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
              {info.license && (
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">协议</p>
                  <p className="text-sm font-medium mt-0.5">{info.license}</p>
                </div>
              )}
              {info.minecraft_version && (
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">MC 版本</p>
                  <p className="text-sm font-medium mt-0.5">{info.minecraft_version}</p>
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
                <p className="text-sm font-medium mt-0.5">{info.mod_id}</p>
              </div>
            </div>
          </div>

          {/* 链接 */}
          {(info.homepage || info.source || info.issues) && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <LinkIcon className="size-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">链接</h3>
              </div>
              <div className="space-y-2">
                {info.homepage && (
                  <a
                    href={info.homepage}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-sm text-primary hover:underline"
                  >
                    <ExternalLink className="size-3.5" />
                    主页
                  </a>
                )}
                {info.source && (
                  <a
                    href={info.source}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-sm text-primary hover:underline"
                  >
                    <GitBranch className="size-3.5" />
                    源代码
                  </a>
                )}
                {info.issues && (
                  <a
                    href={info.issues}
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
          {info.dependencies.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Package className="size-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">必需依赖 ({info.dependencies.length})</h3>
              </div>
              <div className="space-y-2">
                {info.dependencies.map((dep) => (
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
          {info.optional_dependencies.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Users className="size-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">可选/推荐 ({info.optional_dependencies.length})</h3>
              </div>
              <div className="space-y-2">
                {info.optional_dependencies.map((dep) => (
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
          {info.incompatible_dependencies.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="size-4 text-red-500" />
                <h3 className="text-sm font-semibold text-red-500">不兼容 ({info.incompatible_dependencies.length})</h3>
              </div>
              <div className="space-y-2">
                {info.incompatible_dependencies.map((dep) => (
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
          {info.dependencies.length === 0 && info.optional_dependencies.length === 0 && info.incompatible_dependencies.length === 0 && (
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
            info={info}
            instanceDir={instanceDir}
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
  const { t } = useI18n();
  const { panel, loadingState, extra } = useResourcePage(MODS_CONFIG);
  const { startModUpdate, startModUpdateAll } = useDownloadManager();
  const [view, setView] = useState<"list" | "detail">("list");
  const [selectedDetail, setSelectedDetail] = useState<{ fileName: string; info: ModInfo } | null>(null);

  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updatesByFile, setUpdatesByFile] = useState<Map<string, ModUpdatePayload>>(new Map());
  const [updatingFiles, setUpdatingFiles] = useState<Set<string>>(new Set());
  const [checkMessage, setCheckMessage] = useState<string | null>(null);

  // 准备中状态：configLoaded=true 但 instances 还在扫描 / minecraftPath 待定
  const [preparingTimeout, setPreparingTimeout] = useState(false);
  useEffect(() => {
    if (!loadingState.configLoaded) return;
    const t = window.setTimeout(() => setPreparingTimeout(true), 1200);
    return () => window.clearTimeout(t);
  }, [loadingState.configLoaded]);

  const handleCheckUpdates = useCallback(async () => {
    if (!isTauriRuntime()) return;
    const { instanceDir, mcVersion, modLoader } = extra;
    if (!instanceDir || !mcVersion || !modLoader) {
      setCheckMessage(t("panel.updateSourceNotFound"));
      return;
    }
    setCheckingUpdates(true);
    setCheckMessage(null);
    try {
      const results = await invoke<ModUpdatePayload[]>("check_mods_updates", {
        instanceDir,
        mcVersion,
        loader: modLoader,
      });
      const map = new Map<string, ModUpdatePayload>();
      for (const item of results) {
        map.set(item.fileName, item);
      }
      setUpdatesByFile(map);
      setCheckMessage(
        map.size > 0
          ? t("panel.updatesFound", { count: map.size })
          : t("panel.noUpdatesFound")
      );
    } catch (e) {
      console.error("check_mods_updates failed:", e);
      const msg = String(e);
      setCheckMessage(
        msg.startsWith("panel.") ? t(msg as TranslationKey) : msg,
      );
    } finally {
      setCheckingUpdates(false);
    }
  }, [extra, t]);

  const normalizeGameDir = (path: string) =>
    path.replace(/\//g, "\\").toLowerCase();

  const assertInstanceNotRunning = useCallback(
    async (instanceDir: string) => {
      if (!isTauriRuntime()) return true;
      const state = await invoke<{
        running: boolean;
        gameDir?: string | null;
      }>("get_running_game_state");
      if (
        state.running &&
        state.gameDir &&
        normalizeGameDir(state.gameDir) === normalizeGameDir(instanceDir)
      ) {
        setCheckMessage(t("panel.closeGameBeforeUpdate"));
        return false;
      }
      return true;
    },
    [t]
  );

  const handleUpdateOne = useCallback(
    async (fileName: string) => {
      const update = updatesByFile.get(fileName);
      const { instanceDir, mcVersion, modLoader } = extra;
      if (!update || !instanceDir || !mcVersion || !modLoader) return;
      if (!(await assertInstanceNotRunning(instanceDir))) return;
      setUpdatingFiles((prev) => new Set(prev).add(fileName));
      try {
        await startModUpdate(instanceDir, mcVersion, modLoader, update);
        setUpdatesByFile((prev) => {
          const next = new Map(prev);
          next.delete(fileName);
          return next;
        });
        extra.refresh();
      } catch (e) {
        console.error("update_mod failed:", e);
      } finally {
        setUpdatingFiles((prev) => {
          const next = new Set(prev);
          next.delete(fileName);
          return next;
        });
      }
    },
    [updatesByFile, extra, startModUpdate, assertInstanceNotRunning]
  );

  const handleUpdateAll = useCallback(async () => {
    const { instanceDir, mcVersion, modLoader } = extra;
    if (!instanceDir || !mcVersion || !modLoader || updatesByFile.size === 0) return;
    if (!(await assertInstanceNotRunning(instanceDir))) return;
    const updates = Array.from(updatesByFile.values());
    const files = updates.map((u) => u.fileName);
    setUpdatingFiles(new Set(files));
    try {
      await startModUpdateAll(instanceDir, mcVersion, modLoader, updates);
      setUpdatesByFile(new Map());
      extra.refresh();
    } catch (e) {
      console.error("update_mods failed:", e);
    } finally {
      setUpdatingFiles(new Set());
    }
  }, [extra, updatesByFile, startModUpdateAll, assertInstanceNotRunning]);

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
        instanceDir={extra.instanceDir ?? ""}
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
  const handleOpenDetail = (fileName: string, info: ModInfo) => {
    setSelectedDetail({ fileName, info });
    setView("detail");
  };

  const modUpdatesForPanel = new Map(
    Array.from(updatesByFile.entries()).map(([file, u]) => [
      file,
      {
        newVersion: u.newVersion,
        currentVersion: u.currentVersion,
        source: u.source,
      },
    ])
  );

  const leftDescription = checkMessage
    ? `${panel.leftDescription} · ${checkMessage}`
    : panel.leftDescription;

  return (
    <ResourcePanel
      {...panel}
      leftDescription={leftDescription}
      onOpenModDetail={handleOpenDetail}
      modUpdates={modUpdatesForPanel}
      onCheckUpdates={handleCheckUpdates}
      checkingUpdates={checkingUpdates}
      onUpdateAll={handleUpdateAll}
      onUpdateOne={handleUpdateOne}
      updatingFiles={updatingFiles}
    />
  );
}
