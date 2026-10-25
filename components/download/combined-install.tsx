"use client";

import { useCallback, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { InstanceNameDialog } from "@/components/download/instance-name-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LOADER_OPTIONS } from "@/constants/data";
import { canSelectLoader } from "@/lib/utils";
import { staggerContainer, staggerItem, slideInFromLeft, slideInFromRight } from "@/lib/motion";
import { CombinedFabricApiSelect } from "@/components/download/combined-fabric-api-select";
import { LoaderIcon } from "@/components/launch/loader-icon";
import { useDownloadManager } from "@/components/download/download-provider";
import { useI18n } from "@/components/i18n/use-i18n";
import { Download, CheckCircle2, Loader2, TriangleAlert, Puzzle, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { LoaderType, LoaderVersion, MinecraftVersion } from "@/types";

const loaderColors: Record<LoaderType, { bg: string; text: string; border: string; card: string }> = {
  vanilla: { bg: "bg-stone-100 dark:bg-stone-800/40", text: "text-stone-600 dark:text-stone-400", border: "hover:border-stone-400 dark:hover:border-stone-500", card: "" },
  forge: { bg: "bg-orange-100 dark:bg-orange-900/30", text: "text-orange-600 dark:text-orange-400", border: "hover:border-orange-400 dark:hover:border-orange-500", card: "" },
  fabric: { bg: "bg-amber-100 dark:bg-amber-900/30", text: "text-amber-600 dark:text-amber-400", border: "hover:border-amber-400 dark:hover:border-amber-500", card: "" },
  quilt: { bg: "bg-purple-100 dark:bg-purple-900/30", text: "text-purple-600 dark:text-purple-400", border: "hover:border-purple-400 dark:hover:border-purple-500", card: "" },
  neoforge: { bg: "bg-red-100 dark:bg-red-900/30", text: "text-red-600 dark:text-red-400", border: "hover:border-red-400 dark:hover:border-red-500", card: "" },
  liteloader: { bg: "bg-cyan-100 dark:bg-cyan-900/30", text: "text-cyan-600 dark:text-cyan-400", border: "hover:border-cyan-400 dark:hover:border-cyan-500", card: "" },
  optifine: { bg: "bg-yellow-100 dark:bg-yellow-900/30", text: "text-yellow-600 dark:text-yellow-400", border: "hover:border-yellow-400 dark:hover:border-yellow-500", card: "" },
};

interface CombinedInstallProps {
  version: MinecraftVersion;
}

type LoaderVersionEntry = LoaderVersion & { filename?: string; official_url?: string };

interface SelectionItem {
  loader: Exclude<LoaderType, "vanilla">;
  version: string;
}

export function CombinedInstall({ version }: CombinedInstallProps) {
  const { t } = useI18n();
  const { startCombinedInstall, pushNotice, dismissNotice } = useDownloadManager();
  const versionFetchNoticeIdsRef = useRef<Partial<Record<LoaderType, string>>>({});

  const [selected, setSelected] = useState<LoaderType[]>([]);
  const [versions, setVersions] = useState<Partial<Record<LoaderType, string>>>({});
  const [versionLists, setVersionLists] = useState<Partial<Record<LoaderType, LoaderVersionEntry[]>>>({});
  const [loadingLists, setLoadingLists] = useState<Partial<Record<LoaderType, boolean>>>({});
  const [fabricApiVersion, setFabricApiVersion] = useState("");
  const [fabricApiVersionLabel, setFabricApiVersionLabel] = useState("");
  const [view, setView] = useState<"grid" | "fabric-api">("grid");

  const [showNameDialog, setShowNameDialog] = useState(false);
  const [installing, setInstalling] = useState(false);

  const hasFabric = selected.includes("fabric");
  /** 选择了版本即代表启用 Fabric API */
  const fabricApiEnabled = fabricApiVersion !== "";

  const loaderDisplayName = useCallback(
    (loader: LoaderType) =>
      LOADER_OPTIONS.find((o) => o.id === loader)?.name ?? loader,
    []
  );

  const fetchVersions = useCallback(
    async (loader: LoaderType) => {
      if (versionLists[loader] || loadingLists[loader]) return;
      const noticeId = `combined-install-versions-${loader}`;
      versionFetchNoticeIdsRef.current[loader] = pushNotice({
        id: noticeId,
        message: t("download.loadingVersionList"),
        variant: "info",
        loading: true,
      });
      setLoadingLists((prev) => ({ ...prev, [loader]: true }));
      try {
        let result: LoaderVersionEntry[] = [];
        switch (loader) {
          case "forge":
            result = (await invoke<{ id: string; version: string }[]>("get_forge_versions", { mcVersion: version.id })).map((v) => ({ id: v.id, version: v.version, releaseDate: "" }));
            break;
          case "neoforge":
            result = (await invoke<{ id: string; version: string }[]>("get_neoforge_versions", { mcVersion: version.id })).map((v) => ({ id: v.id, version: v.version, releaseDate: "" }));
            break;
          case "fabric":
            result = (await invoke<{ id: string; version: string }[]>("get_fabric_loader_versions", { mcVersion: version.id, useMirror: true })).map((v) => ({ id: v.id, version: v.version, releaseDate: "" }));
            break;
          case "quilt":
            result = (await invoke<{ id: string; version: string }[]>("get_quilt_loader_versions", { mcVersion: version.id })).map((v) => ({ id: v.id, version: v.version, releaseDate: "" }));
            break;
          case "liteloader":
            result = (await invoke<{ id: string; version: string }[]>("get_liteloader_versions", { mcVersion: version.id })).map((v) => ({ id: v.id, version: v.version, releaseDate: "" }));
            break;
          case "optifine":
            result = (await invoke<{ id: string; filename: string; self_version: string; download_url: string; official_url: string; is_pre: boolean }[]>("get_optifine_versions", { mcVersion: version.id })).map((v) => ({
              id: v.download_url,
              version: v.self_version,
              filename: v.filename,
              official_url: v.official_url,
              releaseDate: "",
              isRecommended: !v.is_pre,
            }));
            break;
          default:
            return;
        }
        setVersionLists((prev) => ({ ...prev, [loader]: result }));
        if (result.length === 0) {
          pushNotice({
            message: t("download.noAvailableLoaderVersions", {
              name: loaderDisplayName(loader),
            }),
            variant: "error",
          });
        }
      } catch (err) {
        console.error(`获取${loader}版本列表失败:`, err);
        pushNotice({
          message: t("download.noAvailableLoaderVersions", {
            name: loaderDisplayName(loader),
          }),
          variant: "error",
        });
      } finally {
        const activeNoticeId = versionFetchNoticeIdsRef.current[loader];
        if (activeNoticeId) {
          dismissNotice(activeNoticeId);
          delete versionFetchNoticeIdsRef.current[loader];
        }
        setLoadingLists((prev) => ({ ...prev, [loader]: false }));
      }
    },
    [
      version.id,
      versionLists,
      loadingLists,
      pushNotice,
      dismissNotice,
      t,
      loaderDisplayName,
    ]
  );

  const openFabricApiView = () => {
    if (!hasFabric) return;
    setView("fabric-api");
  };

  const selectFabricApiVersion = (versionId: string, displayVersion: string) => {
    setFabricApiVersion(versionId);
    setFabricApiVersionLabel(displayVersion);
    setView("grid");
  };

  const clearFabricApiSelection = () => {
    setFabricApiVersion("");
    setFabricApiVersionLabel("");
    if (view === "fabric-api") setView("grid");
  };

  const toggleLoader = (loader: LoaderType) => {
    if (loader === "vanilla") return;
    if (selected.includes(loader)) {
      setSelected((prev) => prev.filter((l) => l !== loader));
      setVersions((prev) => {
        const next = { ...prev };
        delete next[loader];
        return next;
      });
      // 取消 Fabric 时连带取消 Fabric API
      if (loader === "fabric") {
        setFabricApiVersion("");
        setFabricApiVersionLabel("");
        setView("grid");
      }
      return;
    }
    const check = canSelectLoader(version.id, loader, selected);
    if (!check.allowed) return;
    setSelected((prev) => [...prev, loader]);
    void fetchVersions(loader);
  };

  const selectableStates = (loader: LoaderType) => {
    if (loader === "vanilla") {
      return { allowed: true, reason: undefined as string | undefined };
    }
    return canSelectLoader(version.id, loader, selected);
  };

  const defaultInstanceName = (() => {
    if (selected.length === 0) return version.id;
    const parts = [version.id];
    for (const l of selected) {
      if (l === "vanilla") continue;
      const v = versions[l];
      parts.push(v ? `${l}-${v}` : l);
    }
    if (fabricApiEnabled) {
      parts.push(fabricApiVersionLabel ? `API-${fabricApiVersionLabel}` : "API");
    }
    return parts.join("-").replace(/[\\/:*?"<>|]/g, "_");
  })();

  const allVersionsChosen = selected
    .filter((l) => l !== "vanilla")
    .every((l) => Boolean(versions[l]));
  const canInstall = allVersionsChosen;

  const handleInstall = () => {
    if (!canInstall) return;
    setShowNameDialog(true);
  };

  const confirmInstall = async (instanceName: string) => {
    if (!canInstall) return;

    setShowNameDialog(false);
    setInstalling(true);
    try {
      const selections: SelectionItem[] = selected
        .filter((l) => l !== "vanilla")
        .map((l) => ({ loader: l as SelectionItem["loader"], version: versions[l]! }));
      if (fabricApiEnabled) {
        selections.push({ loader: "fabric_api" as unknown as SelectionItem["loader"], version: fabricApiVersion });
      }
      await startCombinedInstall(`Minecraft ${version.id} 组合安装`, version.id, selections, instanceName);
    } catch (err) {
      console.error("组合安装启动失败:", err);
    } finally {
      setInstalling(false);
    }
  };

  return (
    <>
      <div className="flex h-full flex-col gap-4">
        {/* 原版：必选 */}
        <div className="shrink-0">
          <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
            <div className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg p-1.5", loaderColors.vanilla.bg)}>
              <LoaderIcon kind="vanilla" className="size-full" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold">{t("download.vanillaMandatory")}</span>
                <Badge variant="default" className="text-[10px] px-1.5 py-0">
                  {t("download.mandatory")}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {version.id}
              </p>
            </div>
            <Button
              size="sm"
              disabled={!canInstall || installing}
              onClick={handleInstall}
              className="shrink-0"
            >
              {installing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Download className="size-4" />
              )}
              {t("download.installCombined")}
            </Button>
          </div>
        </div>

        {view === "grid" ? (
          <div className="shrink-0">
            <h3 className="text-sm font-medium text-muted-foreground">
              {t("download.selectLoader")}
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground/70">
              {t("download.selectLoaderHint")}
            </p>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-hidden">
          <AnimatePresence mode="wait" initial={false}>
            {view === "grid" ? (
              <motion.div
                key="loader-grid"
                className="h-full overflow-y-auto p-1"
                variants={slideInFromLeft}
                initial="initial"
                animate="animate"
                exit="exit"
              >
          <motion.div
            className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
            variants={staggerContainer}
            initial="initial"
            animate="animate"
          >
            {LOADER_OPTIONS.filter((l) => l.id !== "vanilla").map((loader) => {
              const state = selectableStates(loader.id);
              const isSelected = selected.includes(loader.id);
              const colors = loaderColors[loader.id];
              const disabled = !state.allowed;
              const list = versionLists[loader.id];
              return (
                <motion.div key={loader.id} variants={staggerItem}>
                  <Card
                    className={cn(
                      "group transition-all duration-200 shadow-sm h-full",
                      colors.border,
                      disabled && "opacity-45 cursor-not-allowed pointer-events-none",
                      isSelected && "ring-2 ring-primary"
                    )}
                  >
                    <CardHeader className="p-4 pb-2">
                      <div className="flex items-center justify-between">
                        <div
                          className={cn(
                            "flex size-10 items-center justify-center rounded-xl p-1.5",
                            colors.bg
                          )}
                        >
                          <LoaderIcon kind={loader.id} className="size-full" />
                        </div>
                        {isSelected && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="size-7 text-muted-foreground hover:text-destructive"
                            onClick={() => toggleLoader(loader.id)}
                            aria-label={`${t("download.clearSelection")} ${loader.name}`}
                          >
                            <X className="size-3.5" />
                          </Button>
                        )}
                      </div>
                      <CardTitle className="text-sm mt-2">{loader.name}</CardTitle>
                    </CardHeader>
                    <CardContent className="p-4 pt-0">
                      <CardDescription className="text-xs line-clamp-2">
                        {state.reason ?? loader.description}
                      </CardDescription>
                      <div className="mt-3">
                        <Select
                          value={versions[loader.id] ?? ""}
                          onOpenChange={(open) => {
                            if (open) void fetchVersions(loader.id);
                          }}
                          onValueChange={(v) => {
                            setVersions((prev) => ({ ...prev, [loader.id]: v }));
                            if (!selected.includes(loader.id)) {
                              setSelected((prev) => [...prev, loader.id]);
                            }
                          }}
                        >
                          <SelectTrigger className="h-9 text-xs">
                            <SelectValue placeholder={t("download.selectVersion")} />
                          </SelectTrigger>
                          <SelectContent>
                            {(list ?? []).map((v) => (
                              <SelectItem key={v.id} value={v.id} className="text-xs">
                                {v.version}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              );
            })}
            {/* Fabric API 卡片（与 Fabric 一样的一张卡片，需先选 Fabric） */}
            <motion.div key="fabric-api" variants={staggerItem}>
              <Card
                className={cn(
                  "group cursor-pointer transition-all duration-200 shadow-sm h-full",
                  "hover:border-blue-400 dark:hover:border-blue-500",
                  !hasFabric && "opacity-45 cursor-not-allowed pointer-events-none",
                  fabricApiEnabled && "ring-2 ring-primary"
                )}
                onClick={openFabricApiView}
              >
                <CardHeader className="p-4 pb-2">
                  <div className="flex items-center justify-between">
                    <div className="flex size-10 items-center justify-center rounded-xl p-1.5 bg-blue-100 dark:bg-blue-900/30">
                      <Puzzle className="size-full text-blue-600 dark:text-blue-400" />
                    </div>
                    {fabricApiEnabled && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="size-7 text-muted-foreground hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          clearFabricApiSelection();
                        }}
                        aria-label={`${t("download.clearSelection")} Fabric API`}
                      >
                        <X className="size-3.5" />
                      </Button>
                    )}
                  </div>
                  <CardTitle className="text-sm mt-2">Fabric API</CardTitle>
                </CardHeader>
                <CardContent className="p-4 pt-0">
                  <CardDescription className="text-xs line-clamp-2">
                    {!hasFabric
                      ? t("download.fabricApiRequiresFabric")
                      : fabricApiEnabled
                        ? t("download.selectedVersion", {
                            version: fabricApiVersionLabel || fabricApiVersion,
                          })
                        : hasFabric
                          ? t("download.viewFabricApiVersions")
                          : t("download.fabricApiHint")}
                  </CardDescription>
                </CardContent>
              </Card>
            </motion.div>
          </motion.div>
              </motion.div>
            ) : (
              <motion.div
                key="fabric-api-page"
                className="flex h-full flex-col"
                variants={slideInFromRight}
                initial="initial"
                animate="animate"
                exit="exit"
              >
                <CombinedFabricApiSelect
                  mcVersion={version.id}
                  selectedVersionId={fabricApiVersion}
                  onSelect={selectFabricApiVersion}
                  onBack={() => setView("grid")}
                  onClear={clearFabricApiSelection}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* 底部选择摘要 */}
        <div className="shrink-0 border-t border-border pt-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
            {selected.length === 0 ? (
              <>
                <CheckCircle2 className="size-4 text-emerald-500 shrink-0" />
                {t("download.vanillaOnly")}
              </>
            ) : (
              <>
                <CheckCircle2 className="size-4 text-emerald-500 shrink-0" />
                <span className="truncate">
                  {selected.map((l) => LOADER_OPTIONS.find((o) => o.id === l)?.name ?? l).join(" + ")}
                  {fabricApiEnabled ? " + Fabric API" : ""}
                </span>
              </>
            )}
          </div>
          {!allVersionsChosen && selected.length > 0 && (
            <div className="flex items-center gap-1.5 mt-2 text-xs text-amber-600 dark:text-amber-400">
              <TriangleAlert className="size-3.5" />
              {t("download.pickAllVersionsHint")}
            </div>
          )}
        </div>
      </div>

      <InstanceNameDialog
        open={showNameDialog}
        onOpenChange={setShowNameDialog}
        defaultName={defaultInstanceName}
        onConfirm={confirmInstall}
        confirming={installing}
      />
    </>
  );
}