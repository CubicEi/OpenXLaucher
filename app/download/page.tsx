"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Download,
  Loader2,
  AlertCircle,
  RefreshCw,
  Coffee,
  Search,
  ArrowRight,
  ExternalLink,
  type LucideIcon,
} from "lucide-react";
import {
  DOWNLOAD_CENTER_CATEGORY_ICONS,
  type DownloadEnglishCategoryId,
} from "@/constants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { VersionList } from "@/components/download/version-list";
import { VersionDetail } from "@/components/download/version-detail";
import { FavoriteModList } from "@/components/download/favorite-mod-list";
import {
  VersionFilterBar,
  downloadSubFilterButtonClass,
} from "@/components/download/version-filter-bar";
import { cn } from "@/lib/utils";
import { useMinecraftVersions } from "@/hooks/use-minecraft-versions";
import { slideInFromRight, slideInFromLeft, fadeIn } from "@/lib/motion";
import { useDownloadManager } from "@/components/download/download-provider";
import { useI18n, type TranslationKey } from "@/components/i18n/use-i18n";
import { invoke } from "@tauri-apps/api/core";
import { useRouter } from "next/navigation";
import type { MinecraftVersion, MinecraftVersionType } from "@/types";

// -------- English search --------
type EnglishCategory = DownloadEnglishCategoryId;

const ENGLISH_CATEGORIES: {
  id: EnglishCategory;
  labelKey: TranslationKey;
  icon: LucideIcon;
}[] = [
  { id: "mod", labelKey: "download.category.mods", icon: DOWNLOAD_CENTER_CATEGORY_ICONS.mod },
  {
    id: "modpack",
    labelKey: "download.category.modpacks",
    icon: DOWNLOAD_CENTER_CATEGORY_ICONS.modpack,
  },
  {
    id: "resourcepack",
    labelKey: "download.category.resourcePacks",
    icon: DOWNLOAD_CENTER_CATEGORY_ICONS.resourcepack,
  },
  {
    id: "shaders",
    labelKey: "download.category.shaders",
    icon: DOWNLOAD_CENTER_CATEGORY_ICONS.shaders,
  },
  {
    id: "datapack",
    labelKey: "download.category.dataPacks",
    icon: DOWNLOAD_CENTER_CATEGORY_ICONS.datapack,
  },
  {
    id: "worlds",
    labelKey: "download.category.worlds",
    icon: DOWNLOAD_CENTER_CATEGORY_ICONS.worlds,
  },
  {
    id: "schematic",
    labelKey: "download.category.schematics",
    icon: DOWNLOAD_CENTER_CATEGORY_ICONS.schematic,
  },
];

type SearchSource =
  | "modrinth"
  | "curseforge"
  | "both"
  | "modpackindex"
  | "mcschematic";

interface SearchResultItem {
  title: string;
  slug: string;
  description?: string;
  iconUrl?: string;
  source: SearchSource;
  projectType: string;
  downloads?: number;
  categories?: string[];
  latestVersions?: string[];
  mcVersions?: string[];
  updated?: string;
  author?: string;
  externalUrl?: string;
  schematicUuid?: string;
  schematicFileType?: number;
}

function sourceBadgeLabel(source: SearchSource, t: (key: TranslationKey) => string): string {
  switch (source) {
    case "both":
      return "Modrinth + CurseForge";
    case "modrinth":
      return "Modrinth";
    case "curseforge":
      return "CurseForge";
    case "modpackindex":
      return t("download.source.modpackindex");
    case "mcschematic":
      return t("download.source.mcschematic");
    default:
      return source;
  }
}

function formatNumber(n?: number): string {
  if (n === undefined || n === null) return "";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

function formatDate(iso: string | undefined, t: (key: TranslationKey, values?: Record<string, string | number>) => string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const now = Date.now();
    const diffMs = now - d.getTime();
    const day = 24 * 60 * 60 * 1000;
    if (diffMs < day) return t("download.today");
    if (diffMs < 7 * day) return t("download.daysAgo", { count: Math.round(diffMs / day) });
    if (diffMs < 30 * day) return t("download.weeksAgo", { count: Math.round(diffMs / (7 * day)) });
    if (diffMs < 365 * day) return t("download.monthsAgo", { count: Math.round(diffMs / (30 * day)) });
    return t("download.yearsAgo", { count: Math.round(diffMs / (365 * day)) });
  } catch {
    return "";
  }
}

function categoryPath(category: string, slug: string, returnQuery?: string, returnCategory?: EnglishCategory): string {
  // Route to the detail page and keep enough state to restore English search.
  const params = new URLSearchParams({ mod: slug });
  if (returnQuery !== undefined && returnCategory !== undefined) {
    params.set("returnTo", "english");
    params.set("query", returnQuery);
    params.set("category", returnCategory);
  }
  return `/download/detail?${params.toString()}`;
}

function categoryForSource(projectType: string): string {
  const map: Record<string, string> = {
    mod: "mod",
    modpack: "modpack",
    resourcepack: "resourcepack",
    "resource pack": "resourcepack",
    shader: "shaders",
    shaders: "shaders",
    "shader pack": "shaders",
    datapack: "datapack",
    "data pack": "datapack",
    worlds: "worlds",
    world: "worlds",
    schematic: "schematic",
  };
  return map[projectType.toLowerCase()] ?? projectType;
}

function compareMinecraftVersionsDescending(a: MinecraftVersion, b: MinecraftVersion): number {
  const parts = (version: string) => {
    const match = version.match(/^(\d+(?:\.\d+)+)/);
    return match ? match[1].split(".").map(Number) : null;
  };
  const aParts = parts(a.id);
  const bParts = parts(b.id);
  if (aParts && bParts) {
    const length = Math.max(aParts.length, bParts.length);
    for (let index = 0; index < length; index += 1) {
      const difference = (bParts[index] ?? 0) - (aParts[index] ?? 0);
      if (difference !== 0) return difference;
    }
  }
  return new Date(b.releaseDate).getTime() - new Date(a.releaseDate).getTime();
}

/**
 * Download Center
 * Contains Minecraft version downloads, Java downloads, and Chinese mod search
 */
export default function DownloadPage() {
  const router = useRouter();
  const { t } = useI18n();
  const { versions, loading, error, refetch } = useMinecraftVersions();
  const [versionFilter, setVersionFilter] = useState<MinecraftVersionType>("release");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedVersion, setSelectedVersion] =
    useState<MinecraftVersion | null>(null);

  const [tab, setTab] = useState<"minecraft" | "java" | "english" | "favorites">("minecraft");

  // Java 多源下载状态
  type JavaVendorId = "zulu" | "adoptium" | "oracle" | "microsoft";
  type JavaOffer = {
    vendor: JavaVendorId;
    vendorLabel: string;
    major: number;
    label: string;
    downloadMode: "installer" | "external";
    externalUrl?: string | null;
  };
  const [javaOffers, setJavaOffers] = useState<JavaOffer[]>([]);
  const [javaVersionsLoading, setJavaVersionsLoading] = useState(false);
  const [javaMessage, setJavaMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [javaVendorFilter, setJavaVendorFilter] = useState<"all" | JavaVendorId>("all");
  const [javaSearchQuery, setJavaSearchQuery] = useState("");

  // 英文检索状态
  const [englishQuery, setEnglishQuery] = useState("");
  const [englishCategory, setEnglishCategory] = useState<EnglishCategory>("mod");
  const [englishResults, setEnglishResults] = useState<SearchResultItem[] | null>(null);
  const [englishLoading, setEnglishLoading] = useState(false);
  const [englishError, setEnglishError] = useState<string | null>(null);
  const [schematicMessage, setSchematicMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tabParam = params.get("tab");
    if (tabParam === "favorites") {
      setTab("favorites");
      return;
    }
    if (tabParam === "java") {
      setTab("java");
      return;
    }
    if (tabParam === "chinese") {
      setTab("english");
      return;
    }
    if (tabParam !== "english") return;

    const category = params.get("category");
    setTab("english");
    setEnglishQuery(params.get("query") || "");
    if (category && ENGLISH_CATEGORIES.some((item) => item.id === category)) {
      setEnglishCategory(category as EnglishCategory);
    }
  }, []);

  const handleDownloadSchematic = useCallback(
    async (result: SearchResultItem) => {
      setSchematicMessage(null);
      const uuid = result.schematicUuid ?? result.slug;
      const fileType = result.schematicFileType ?? 1;
      try {
        const paths = await invoke<{ selected_minecraft_path: string }>("get_launcher_paths_config");
        const gameDir = paths.selected_minecraft_path?.trim();
        if (!gameDir) {
          setSchematicMessage({ type: "error", text: t("download.downloadPathNotReady") });
          return;
        }
        const savedPath = await invoke<string>("download_mcschematic_file", {
          uuid,
          schematicFileType: fileType,
          gameDir,
        });
        setSchematicMessage({
          type: "success",
          text: t("download.schematicDownloaded", { path: savedPath }),
        });
      } catch (err) {
        setSchematicMessage({
          type: "error",
          text: t("download.schematicDownloadFailed", { error: String(err) }),
        });
      }
    },
    [t],
  );

  const handleEnglishResultClick = useCallback(
    (result: SearchResultItem) => {
      if (englishCategory === "schematic" && result.source === "mcschematic") {
        void handleDownloadSchematic(result);
        return;
      }
      const detailCategory = categoryForSource(result.projectType || englishCategory);
      const path = categoryPath(detailCategory, result.slug, englishQuery, englishCategory);
      router.push(path);
    },
    [englishCategory, englishQuery, handleDownloadSchematic, router],
  );

  const handleEnglishSearch = useCallback(async () => {
    const query = englishQuery.trim();
    const browseByCategory = !query;
    setEnglishLoading(true);
    setEnglishResults(null);
    setEnglishError(null);
    setSchematicMessage(null);
    try {
      const raw = await invoke<string>("search_english_resources", {
        query: browseByCategory ? "" : query,
        category: englishCategory,
        limit: 25,
      });
      const parsed = JSON.parse(raw) as { results: SearchResultItem[] };
      setEnglishResults(parsed.results ?? []);

      if (!parsed.results?.length) {
        const categoryLabel = ENGLISH_CATEGORIES.find((c) => c.id === englishCategory)?.labelKey;
        const categoryName = categoryLabel ? t(categoryLabel) : englishCategory;
        setEnglishError(
          browseByCategory
            ? t("download.noResultsInCategory", { category: categoryName })
            : t("download.noResultsForQueryInCategory", { query, category: categoryName }),
        );
      }
    } catch (err) {
      console.error("English search failed:", err);
      setEnglishError(t("download.searchFailed", { error: String(err) }));
    } finally {
      setEnglishLoading(false);
    }
  }, [englishQuery, englishCategory, t]);

  // Auto-load when opening English search tab or changing category (browse if query empty)
  useEffect(() => {
    if (tab !== "english") return;
    void handleEnglishSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, englishCategory]);

  // Use download manager to track Java download tasks
  const { startJavaDownload, tasks } = useDownloadManager();

  const loadJavaVersions = async () => {
    setJavaVersionsLoading(true);
    setJavaMessage(null);
    try {
      const result = await invoke<JavaOffer[]>("list_java_distributions");
      setJavaOffers(result);
    } catch (err) {
      setJavaMessage({ type: "error", text: t("download.failedToGetJavaVersions", { error: String(err) }) });
    } finally {
      setJavaVersionsLoading(false);
    }
  };

  // Load distribution list when switching to Java tab
  useEffect(() => {
    if (tab === "java" && javaOffers.length === 0 && !javaVersionsLoading) {
      void loadJavaVersions();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const handleJavaDownload = async (offer: JavaOffer) => {
    setJavaMessage(null);
    try {
      if (offer.downloadMode === "external") {
        const url = offer.externalUrl;
        if (!url) {
          setJavaMessage({ type: "error", text: t("download.javaNoExternalUrl") });
          return;
        }
        await invoke("open_external", { url });
        setJavaMessage({
          type: "success",
          text: t("download.javaOpenedExternal", { label: offer.label }),
        });
        return;
      }
      const taskId = await startJavaDownload(offer.label);
      const result = await invoke<{ message: string }>("download_and_install_java", {
        vendor: offer.vendor,
        major: offer.major,
        taskId,
      });
      setJavaMessage({ type: "success", text: result.message });
    } catch (err) {
      setJavaMessage({ type: "error", text: t("download.downloadFailed", { error: String(err) }) });
    }
  };

  const filteredJavaOffers = useMemo(() => {
    return javaOffers.filter((offer) => {
      if (javaVendorFilter !== "all" && offer.vendor !== javaVendorFilter) return false;
      if (!javaSearchQuery) return true;
      const q = javaSearchQuery.toLowerCase();
      return (
        offer.label.toLowerCase().includes(q) ||
        offer.vendorLabel.toLowerCase().includes(q) ||
        String(offer.major).includes(q)
      );
    });
  }, [javaOffers, javaVendorFilter, javaSearchQuery]);

  const filteredVersions = useMemo(() => {
    return versions.filter((v) => {
      if (v.type !== versionFilter) return false;
      if (
        searchQuery &&
        !v.id.toLowerCase().includes(searchQuery.toLowerCase())
      )
        return false;
      return true;
    }).sort(compareMinecraftVersionsDescending);
  }, [versions, versionFilter, searchQuery]);

  return (
    <>
    <AnimatePresence mode="wait" initial={false}>
      {selectedVersion ? (
        // 版本详情视图
        <motion.div
          key="detail"
          className="flex h-full flex-col p-4"
          variants={slideInFromRight}
          initial="initial"
          animate="animate"
          exit="exit"
        >
          <VersionDetail
            version={selectedVersion}
            onBack={() => setSelectedVersion(null)}
          />
        </motion.div>
      ) : (
        // 列表视图
        <motion.div
          key="list"
          className="flex h-full flex-col gap-4 p-4"
          variants={slideInFromLeft}
          initial="initial"
          animate="animate"
          exit="exit"
        >
          {/* 页面标题 */}
          <div className="flex items-center justify-between gap-3 shrink-0">
            <div className="flex items-center gap-3">
              <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10">
                <Download className="size-5 text-primary" />
              </div>
              <div>
                <h1 className="text-lg font-semibold leading-none">{t("download.title")}</h1>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("download.subtitle")}
                </p>
              </div>
            </div>

          </div>

          <div className="flex-1 min-h-0 flex flex-col">
            <div className="flex gap-1 shrink-0 rounded-lg bg-muted p-1 w-fit">
              <button
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  tab === "minecraft" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setTab("minecraft")}
              >
                Minecraft
              </button>
              <button
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  tab === "java" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setTab("java")}
              >
                Java
              </button>
              <button
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  tab === "english" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                }`}
onClick={() => setTab("english")}
              >
                {t("download.tabAllPlatforms")}
              </button>
              <button
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  tab === "favorites" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                }`}
onClick={() => setTab("favorites")}
              >
                {t("download.tabFavorites")}
              </button>
            </div>

            {/* Minecraft version download */}
            {tab === "minecraft" && <div className="flex-1 min-h-0 flex flex-col gap-4 mt-4">
              <div className="shrink-0">
                <VersionFilterBar
                  filter={versionFilter}
                  onFilterChange={setVersionFilter}
                  searchQuery={searchQuery}
                  onSearchChange={setSearchQuery}
                />
              </div>

              <AnimatePresence mode="wait">
                {loading ? (
                  <motion.div
                    key="loading"
                    className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground"
                    variants={fadeIn}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                  >
                    <Loader2 className="size-8 animate-spin" />
                    <p className="text-sm">{t("download.loadingVersionList")}</p>
                  </motion.div>
                ) : error ? (
                  <motion.div
                    key="error"
                    className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground"
                    variants={fadeIn}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                  >
                    <AlertCircle className="size-8 text-destructive" />
                    <p className="text-sm">{t("download.failedToGetVersionList")}</p>
                    <p className="text-xs">{error}</p>
                    <Button variant="outline" size="sm" onClick={refetch} className="mt-2 gap-2">
                      <RefreshCw className="size-3.5" />
                      {t("download.retry")}
                    </Button>
                  </motion.div>
                ) : (
                  <motion.div
                    key="list"
                    className="flex-1 min-h-0 flex flex-col"
                    variants={fadeIn}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                  >
                    <VersionList
                      versions={filteredVersions}
                      onSelectVersion={setSelectedVersion}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>}

            {/* Java download (multi-vendor) */}
            {tab === "java" && <div className="flex-1 min-h-0 flex flex-col gap-4 mt-4">
              <div className="shrink-0 space-y-2">
                <p className="text-xs text-muted-foreground">{t("download.javaMultiVendorHint")}</p>
                <div className="flex items-center justify-between gap-4">
                  <div className="flex flex-wrap items-center gap-1">
                    {(
                      [
                        ["all", t("download.all")],
                        ["zulu", "Zulu"],
                        ["adoptium", "Temurin"],
                        ["oracle", "Oracle"],
                        ["microsoft", "Microsoft"],
                      ] as const
                    ).map(([id, label]) => (
                      <Button
                        key={id}
                        variant="ghost"
                        size="sm"
                        onClick={() => setJavaVendorFilter(id)}
                        className={downloadSubFilterButtonClass(javaVendorFilter === id)}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                  <div className="relative w-64">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                    <Input
                      placeholder={t("download.searchJavaPlaceholder")}
                      value={javaSearchQuery}
                      onChange={(e) => setJavaSearchQuery(e.target.value)}
                      className="pl-9 h-8 text-sm"
                    />
                  </div>
                </div>
                {javaMessage?.type === "success" ? (
                  <p className="text-xs text-emerald-600 dark:text-emerald-400">{javaMessage.text}</p>
                ) : null}
              </div>

              <AnimatePresence mode="wait">
                {javaVersionsLoading ? (
                  <motion.div
                    key="loading"
                    className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground"
                    variants={fadeIn}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                  >
                    <Loader2 className="size-8 animate-spin" />
                    <p className="text-sm">{t("download.loadingVersionList")}</p>
                  </motion.div>
                ) : javaMessage && javaMessage.type === "error" && javaOffers.length === 0 ? (
                  <motion.div
                    key="error"
                    className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground"
                    variants={fadeIn}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                  >
                    <AlertCircle className="size-8 text-destructive" />
                    <p className="text-sm">{t("download.failedToGetVersionList")}</p>
                    <p className="text-xs">{javaMessage.text}</p>
                    <Button variant="outline" size="sm" onClick={() => void loadJavaVersions()} className="mt-2 gap-2">
                      <RefreshCw className="size-3.5" />
                      {t("download.retry")}
                    </Button>
                  </motion.div>
                ) : filteredJavaOffers.length === 0 ? (
                  <motion.div
                    key="empty"
                    className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground py-16"
                    variants={fadeIn}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                  >
                    <Coffee className="size-10 opacity-40" />
                    <p className="text-sm">{t("download.noMatchingJavaVersions")}</p>
                  </motion.div>
                ) : (
                  <motion.div
                    key="list"
                    className="flex-1 min-h-0 overflow-y-auto rounded-xl border border-border bg-card"
                    variants={fadeIn}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                  >
                    {filteredJavaOffers.map((offer) => {
                      const isDownloading = tasks.some(
                        (task) => task.label === offer.label && task.status === "downloading"
                      );
                      const task = tasks.find((item) => item.label === offer.label);
                      const isExternal = offer.downloadMode === "external";
                      return (
                        <button
                          key={`${offer.vendor}-${offer.major}`}
                          type="button"
                          onClick={() => void handleJavaDownload(offer)}
                          className="group flex w-full items-center justify-between px-4 py-3 hover:bg-accent/50 transition-colors duration-200 border-b border-border last:border-b-0 text-left"
                          disabled={isDownloading}
                        >
                          <div className="flex items-center gap-4 min-w-0">
                            <div className="flex flex-col gap-0.5 min-w-0">
                              <span className="font-semibold text-sm leading-none">
                                {offer.label}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {offer.vendorLabel}
                                {isExternal ? ` · ${t("download.javaManualInstall")}` : ""}
                              </span>
                            </div>
                          </div>

                          <div className="flex items-center gap-3 shrink-0">
                            {task && task.status === "downloading" && task.progress !== undefined && (
                              <span className="text-xs text-muted-foreground">
                                {task.progress.toFixed(1)}%
                              </span>
                            )}
                            {task && task.status === "downloading" ? (
                              <Loader2 className="size-4 text-primary animate-spin" />
                            ) : isExternal ? (
                              <ExternalLink className="size-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity duration-200" />
                            ) : (
                              <Download className="size-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity duration-200" />
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>}

            {/* English search */}
            {tab === "english" && <div className="flex-1 min-h-0 flex flex-col gap-4 mt-4">
              <div className="shrink-0 flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  {/* Search bar */}
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                    <Input
                      placeholder={t("download.searchAllPlaceholder")}
                      value={englishQuery}
                      onChange={(e) => {
                        setEnglishQuery(e.target.value);
                        setEnglishError(null);
                      }}
                      onKeyDown={(e) => e.key === "Enter" && handleEnglishSearch()}
                      className={`pl-9 h-9 text-sm ${englishError ? "border-destructive focus-visible:ring-destructive" : ""}`}
                    />
                  </div>
                  <Button
                    size="sm"
                    onClick={handleEnglishSearch}
                    disabled={englishLoading}
                    className="h-9"
                  >
                    {englishLoading ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
                    <span className="ml-1">{t("download.search")}</span>
                  </Button>
                </div>
                {/* Six category selection buttons */}
                <div className="flex flex-wrap items-center gap-1">
                  {ENGLISH_CATEGORIES.map((cat) => {
                    const Icon = cat.icon;
                    const isActive = englishCategory === cat.id;
                    return (
                      <Button
                        key={cat.id}
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setEnglishCategory(cat.id)}
                        className={cn(
                          "gap-1.5",
                          downloadSubFilterButtonClass(isActive),
                        )}
                      >
                        <Icon className="size-3.5 shrink-0" />
                        <span>{t(cat.labelKey)}</span>
                      </Button>
                    );
                  })}
                </div>
                {englishError && (
                  <div className="flex items-center gap-2 text-xs text-destructive">
                    <AlertCircle className="size-3.5" />
                    <span>{englishError}</span>
                  </div>
                )}
                {!englishError && !englishLoading && !englishResults && (
                  <p className="text-xs text-muted-foreground">
                    {t("download.englishSearchHint")}
                  </p>
                )}
                {schematicMessage && (
                  <div
                    className={`text-xs ${schematicMessage.type === "success" ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}
                  >
                    {schematicMessage.text}
                  </div>
                )}
              </div>

              <AnimatePresence mode="wait">
                {englishLoading ? (
                  <motion.div
                    key="loading"
                    className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground"
                    variants={fadeIn}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                  >
                    <Loader2 className="size-8 animate-spin" />
                    <p className="text-sm">
                      {englishCategory === "schematic"
                        ? t("download.searchingSchematic")
                        : englishCategory === "worlds" && !englishQuery.trim()
                          ? t("download.searchingCurseforgePopular")
                          : englishQuery.trim()
                            ? t("download.searchingBoth")
                            : t("download.searchingModrinthPopular")}
                    </p>
                  </motion.div>
                ) : englishResults && englishResults.length > 0 ? (
                  <motion.div
                    key="results"
                    className="flex-1 min-h-0 overflow-y-auto rounded-xl border border-border bg-card"
                    variants={fadeIn}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                  >
                    <div className="divide-y divide-border">
                      {englishResults.map((result) => {
                        const Icon =
                          ENGLISH_CATEGORIES.find((c) => c.id === (categoryForSource(result.projectType || englishCategory) as EnglishCategory))
                            ?.icon ?? DOWNLOAD_CENTER_CATEGORY_ICONS.mod;
                        return (
                          <button
                            key={`${result.source}-${result.slug}`}
                            onClick={() => handleEnglishResultClick(result)}
                            className="group w-full text-left px-4 py-3 hover:bg-accent/50 transition-colors flex items-start gap-3"
                          >
                            {/* Icon */}
                            <div className="shrink-0 w-12 h-12 rounded-lg bg-muted flex items-center justify-center overflow-hidden border border-border">
                              {result.iconUrl ? (
                                <img
                                  src={result.iconUrl}
                                  alt=""
                                  className="w-full h-full object-contain"
                                  onError={(e) => {
                                    (e.currentTarget as HTMLImageElement).style.display = "none";
                                  }}
                                />
                              ) : (
                                <Icon className="size-5 text-muted-foreground" />
                              )}
                            </div>

                            {/* Main info */}
                            <div className="flex-1 min-w-0 flex flex-col gap-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-semibold text-sm leading-tight truncate">
                                  {result.title}
                                </span>
                                <Badge variant="outline" className="text-[10px] h-4 font-mono">
                                  {result.slug}
                                </Badge>
                                <Badge
                                  variant="secondary"
                                  className={`text-[10px] h-4 ${
                                    result.source === "both" || result.source === "modrinth"
                                      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
                                      : result.source === "curseforge"
                                        ? "bg-orange-500/10 text-orange-700 dark:text-orange-300 border-orange-500/30"
                                        : result.source === "modpackindex"
                                          ? "bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/30"
                                          : "bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/30"
                                  }`}
                                >
                                  {sourceBadgeLabel(result.source, t)}
                                </Badge>
                                {result.categories?.slice(0, 5).map((c) => (
                                  <Badge key={c} variant="secondary" className="text-[10px] h-4">
                                    {c}
                                  </Badge>
                                ))}
                              </div>
                              {result.description && (
                                <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                                  {result.description}
                                </p>
                              )}
                              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground pt-0.5">
                                {result.author && (
                                  <span className="inline-flex items-center gap-1">
                                    <span className="text-foreground/70">{t("download.author")}</span>
                                    <span className="text-foreground">{result.author}</span>
                                  </span>
                                )}
                                {result.downloads !== undefined && (
                                  <span>· {t("download.downloadsCount", { count: formatNumber(result.downloads) })}</span>
                                )}
                                {result.updated && <span>· {t("download.updated", { date: formatDate(result.updated, t) })}</span>}
                                {result.mcVersions && result.mcVersions.length > 0 && (
                                  <span className="inline-flex items-center gap-1">
                                    · MC {result.mcVersions.slice(0, 3).join(", ")}
                                    {result.mcVersions.length > 3 ? `, +${result.mcVersions.length - 3}` : ""}
                                  </span>
                                )}
                              </div>
                            </div>

                            <div className="shrink-0 flex flex-col items-end gap-1">
                              <ArrowRight className="size-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                              {result.externalUrl && (
                                <a
                                  href={result.externalUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
                                >
                                  <ExternalLink className="size-3" />
                                  {t("download.openSource")}
                                </a>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                    <div className="px-4 py-2 text-xs text-muted-foreground border-t border-border bg-muted/30">
                      {t("download.totalResults", { count: englishResults.length })}
                    </div>
                  </motion.div>
                ) : englishResults ? (
                  <motion.div
                    key="empty"
                    className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground"
                    variants={fadeIn}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                  >
                    <Coffee className="size-10 opacity-40" />
                    <p className="text-sm">{t("download.noMatchingProjects")}</p>
                  </motion.div>
                ) : (
                  <motion.div
                    key="idle"
                    className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground"
                    variants={fadeIn}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                  >
                    <Search className="size-10 opacity-40" />
                    <p className="text-sm">{t("download.enterKeywordsToStart")}</p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>}

            {tab === "favorites" && <FavoriteModList />}
          </div>
        </motion.div>
      )}
    </AnimatePresence>

    </>
  );
}
