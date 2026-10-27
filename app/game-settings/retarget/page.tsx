"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, ArrowLeft, Loader2, Wrench } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { VersionList } from "@/components/download/version-list";
import { VersionFilterBar } from "@/components/download/version-filter-bar";
import { RetargetVersionDetail } from "@/components/retarget/retarget-version-detail";
import { useMinecraftVersions } from "@/hooks/use-minecraft-versions";
import { fadeIn, fadeSlideUp, slideInFromLeft, slideInFromRight } from "@/lib/motion";
import { useI18n } from "@/components/i18n/use-i18n";
import {
  getRetargetContext,
  type RetargetContext,
} from "@/lib/retarget-version";
import type { MinecraftVersion, MinecraftVersionType } from "@/types";

function compareMinecraftVersionsDescending(
  a: MinecraftVersion,
  b: MinecraftVersion
): number {
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
 * 修改游戏版本与加载器（独立页面，不复用下载中心整页）
 * 保留版本筛选栏 + 版本列表，标题为「修改版本」+ 返回
 */
export default function RetargetVersionPage() {
  const router = useRouter();
  const { t } = useI18n();
  const { versions, loading, error, refetch } = useMinecraftVersions();
  const [versionFilter, setVersionFilter] =
    useState<MinecraftVersionType>("release");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedVersion, setSelectedVersion] =
    useState<MinecraftVersion | null>(null);
  const [retargetContext, setCtx] = useState<RetargetContext | null>(null);

  useEffect(() => {
    const ctx = getRetargetContext();
    if (!ctx) {
      router.replace("/game-settings");
      return;
    }
    setCtx(ctx);
  }, [router]);

  const filteredVersions = useMemo(() => {
    return versions
      .filter((v) => {
        if (v.type !== versionFilter) return false;
        if (
          searchQuery &&
          !v.id.toLowerCase().includes(searchQuery.toLowerCase())
        ) {
          return false;
        }
        return true;
      })
      .sort(compareMinecraftVersionsDescending);
  }, [versions, versionFilter, searchQuery]);

  if (!retargetContext) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  return (
    <AnimatePresence mode="wait" initial={false}>
      {selectedVersion ? (
        <motion.div
          key="detail"
          className="flex h-full flex-col p-4"
          variants={slideInFromRight}
          initial="initial"
          animate="animate"
          exit="exit"
        >
          <RetargetVersionDetail
            version={selectedVersion}
            onBack={() => setSelectedVersion(null)}
            retargetContext={retargetContext}
          />
        </motion.div>
      ) : (
        <motion.div
          key="list"
          className="flex h-full flex-col gap-4 p-4"
          variants={slideInFromLeft}
          initial="initial"
          animate="animate"
          exit="exit"
        >
          <motion.div
            variants={fadeSlideUp}
            initial="initial"
            animate="animate"
            className="flex shrink-0 items-center gap-3"
          >
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => router.push("/game-settings")}
              aria-label={t("common.back")}
            >
              <ArrowLeft className="size-4" />
            </Button>
            <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10">
              <Wrench className="size-5 text-primary" />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg font-semibold leading-none">
                {t("gameSettings.retargetPageTitle")}
              </h1>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {t("gameSettings.retargetBanner", {
                  folder: retargetContext.sourceFolderName,
                  mc: retargetContext.currentMcVersion,
                  loader: retargetContext.currentLoaderFamily,
                })}
              </p>
            </div>
          </motion.div>

          <div className="flex min-h-0 flex-1 flex-col gap-4">
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
                  <Button size="sm" variant="outline" onClick={() => void refetch()}>
                    {t("download.retry")}
                  </Button>
                </motion.div>
              ) : (
                <motion.div
                  key="list-body"
                  className="flex min-h-0 flex-1 flex-col"
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
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
