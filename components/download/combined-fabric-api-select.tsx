"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ArrowLeft, CheckCircle2, Puzzle, X } from "lucide-react";
import { fadeIn } from "@/lib/motion";
import { invoke } from "@tauri-apps/api/core";
import { useDownloadManager } from "@/components/download/download-provider";
import { useI18n } from "@/components/i18n/use-i18n";
import type { LoaderVersion } from "@/types";

interface CombinedFabricApiSelectProps {
  mcVersion: string;
  selectedVersionId: string;
  onSelect: (versionId: string, displayVersion: string) => void;
  onBack: () => void;
  onClear: () => void;
}

const FABRIC_API_VERSIONS_NOTICE_ID = "combined-fabric-api-versions";

export function CombinedFabricApiSelect({
  mcVersion,
  selectedVersionId,
  onSelect,
  onBack,
  onClear,
}: CombinedFabricApiSelectProps) {
  const { t } = useI18n();
  const { pushNotice, dismissNotice } = useDownloadManager();
  const [apiVersions, setApiVersions] = useState<LoaderVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const loadingNoticeActiveRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const fetchApiVersions = async () => {
      setLoading(true);
      pushNotice({
        id: FABRIC_API_VERSIONS_NOTICE_ID,
        message: t("download.loadingVersionList"),
        variant: "info",
        loading: true,
      });
      loadingNoticeActiveRef.current = true;
      try {
        const result = await invoke<{ id: string; version: string }[]>(
          "get_fabric_api_versions",
          { mcVersion }
        );
        if (cancelled) return;
        const versions = result.map((v) => ({
          id: v.id,
          version: v.version,
          releaseDate: "",
          isRecommended: false,
        }));
        setApiVersions(versions);
        if (versions.length === 0) {
          pushNotice({
            message: t("download.noAvailableLoaderVersions", { name: "Fabric API" }),
            variant: "error",
          });
        }
      } catch (err) {
        console.error("获取Fabric API版本列表失败:", err);
        if (!cancelled) {
          setApiVersions([]);
          pushNotice({
            message: t("download.noAvailableLoaderVersions", { name: "Fabric API" }),
            variant: "error",
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
        if (loadingNoticeActiveRef.current) {
          dismissNotice(FABRIC_API_VERSIONS_NOTICE_ID);
          loadingNoticeActiveRef.current = false;
        }
      }
    };
    void fetchApiVersions();
    return () => {
      cancelled = true;
      if (loadingNoticeActiveRef.current) {
        dismissNotice(FABRIC_API_VERSIONS_NOTICE_ID);
        loadingNoticeActiveRef.current = false;
      }
    };
  }, [mcVersion, pushNotice, dismissNotice, t]);

  const hasSelection = selectedVersionId !== "";

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex items-center gap-3 shrink-0">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onBack}
          aria-label={t("download.backToLoaderSelection")}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-blue-100 p-1.5 dark:bg-blue-900/30">
          <Puzzle className="size-full text-blue-600 dark:text-blue-400" />
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <h2 className="text-lg font-semibold leading-none">Fabric API</h2>
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
            {mcVersion}
          </Badge>
        </div>
        {hasSelection && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 shrink-0 text-xs"
            onClick={onClear}
          >
            <X className="mr-1 size-3.5" />
            {t("download.clearSelection")}
          </Button>
        )}
      </div>

      <div className="shrink-0">
        <h3 className="text-sm font-medium text-muted-foreground">
          {t("download.selectFabricApiVersion")}
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground/70">
          {t("download.selectFabricApiVersionCombinedHint")}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        <AnimatePresence mode="wait">
          {!loading && apiVersions.length > 0 ? (
            <motion.div
              key="list"
              className="space-y-2"
              variants={fadeIn}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              {apiVersions.map((v) => {
                const isChosen = selectedVersionId === v.id;
                return (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => onSelect(v.id, v.version)}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3 text-left transition-all duration-200",
                      isChosen
                        ? "border-primary ring-2 ring-primary"
                        : "border-border hover:border-primary/50"
                    )}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{v.version}</p>
                      {v.isRecommended && (
                        <Badge variant="secondary" className="mt-1 px-1.5 py-0 text-[10px]">
                          {t("download.recommended")}
                        </Badge>
                      )}
                    </div>
                    {isChosen ? (
                      <CheckCircle2 className="size-4 shrink-0 text-primary" />
                    ) : (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {t("download.select")}
                      </span>
                    )}
                  </button>
                );
              })}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}
