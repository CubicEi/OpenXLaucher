"use client";

import React, { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, BookOpen, ExternalLink, Loader2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useRouter } from "next/navigation";
import { fadeSlideUp } from "@/lib/motion";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/components/i18n/use-i18n";
import { RemoteVersionsSection } from "@/components/resources/remote-versions-section";
import { ResourceCoverImage } from "@/components/resources/resource-cover-image";
import type { ResourceKindWire } from "@/lib/resource-kind";
import { isTauriRuntime } from "@/lib/tauri-runtime";
import {
  buildResourceAbsolutePath,
  openResourceDownloadDetail,
} from "@/lib/resources/resource-download-navigation";

type ResolvedDownloadTarget = {
  slug: string;
  title: string;
  source: string;
};

export function ResourceDetailPage({
  fileName,
  displayName,
  instanceDir,
  instanceSubdir,
  mcVersion,
  loader,
  resourceKind,
  onBack,
  onRefresh,
}: {
  fileName: string;
  displayName: string;
  instanceDir: string;
  instanceSubdir: string;
  mcVersion: string;
  loader: string;
  resourceKind: ResourceKindWire;
  onBack: () => void;
  onRefresh: () => void;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const resourcePath = buildResourceAbsolutePath(fileName, instanceDir, instanceSubdir);

  const [localDescription, setLocalDescription] = useState<string | null>(null);
  const [remoteDescription, setRemoteDescription] = useState<string | null>(null);
  const [matched, setMatched] = useState<ResolvedDownloadTarget | null>(null);
  const [openingDownload, setOpeningDownload] = useState(false);

  useEffect(() => {
    if (!resourcePath || !isTauriRuntime()) {
      setLocalDescription(null);
      setMatched(null);
      setRemoteDescription(null);
      return;
    }

    let cancelled = false;

    void invoke<string | null>("get_pack_local_description", { resourcePath })
      .then((desc) => {
        if (!cancelled) setLocalDescription(desc?.trim() || null);
      })
      .catch(() => {
        if (!cancelled) setLocalDescription(null);
      });

    void invoke<ResolvedDownloadTarget | null>("resolve_mod_for_download", {
      modPath: resourcePath,
    })
      .then(async (target) => {
        if (cancelled) return;
        setMatched(target);
        if (!target?.slug) {
          setRemoteDescription(null);
          return;
        }
        try {
          const raw = await invoke<string>("get_modrinth_project", { slug: target.slug });
          const data = JSON.parse(raw) as { description?: string };
          if (!cancelled) {
            setRemoteDescription(data.description?.trim() || null);
          }
        } catch {
          if (!cancelled) setRemoteDescription(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMatched(null);
          setRemoteDescription(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [resourcePath]);

  const description = remoteDescription || localDescription;
  const title = matched?.title || displayName;

  const openDownloadDetail = async () => {
    if (!resourcePath || !matched || openingDownload) return;
    setOpeningDownload(true);
    try {
      await openResourceDownloadDetail({
        router,
        resourcePath,
        fileName,
        resourceKind,
        t,
      });
    } catch {
      (
        window as Window & { __rt_toast?: (value: string) => void }
      ).__rt_toast?.(t("panel.modUpdateHashMiss"));
    } finally {
      setOpeningDownload(false);
    }
  };

  const kindBadge =
    resourceKind === "resourcepack"
      ? t("download.category.resourcePacks")
      : resourceKind === "shaderpack"
        ? t("download.category.shaders")
        : resourceKind === "datapack"
          ? t("download.category.dataPacks")
          : resourceKind;

  return (
    <motion.div
      variants={fadeSlideUp}
      initial="initial"
      animate="animate"
      className="flex h-full flex-col p-4 overflow-hidden gap-4"
    >
      <div className="shrink-0 flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="size-9 shrink-0"
          onClick={onBack}
          title={t("gameSettings.resourceDetail.backToList")}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-base font-semibold truncate">{title}</h1>
          <p className="text-xs text-muted-foreground truncate">{fileName}</p>
        </div>
        {matched?.slug && (
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-9 shrink-0 bg-background"
            title={t("gameSettings.modDetail.openInDownload")}
            aria-label={t("gameSettings.modDetail.openInDownload")}
            disabled={!resourcePath || openingDownload}
            onClick={() => void openDownloadDetail()}
          >
            {openingDownload ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ExternalLink className="size-4" />
            )}
          </Button>
        )}
        <Badge variant="secondary" className="shrink-0 text-xs">
          {t("gameSettings.resourceDetail.badge")}
        </Badge>
      </div>

      <motion.div
        variants={fadeSlideUp}
        initial="initial"
        animate="animate"
        className="flex-1 overflow-y-auto border rounded-xl bg-card"
      >
        <div className="p-5 space-y-5">
          <div className="flex items-start gap-4 pb-5 border-b">
            <ResourceCoverImage resourcePath={resourcePath} resourceKind={resourceKind} />
            <div className="flex-1 min-w-0">
              <h2 className="text-2xl font-bold truncate">{title}</h2>
              <p className="mt-1.5 text-sm text-muted-foreground truncate">
                {kindBadge}
                {matched?.source ? ` · ${matched.source}` : ""}
                {matched?.slug ? ` · ${matched.slug}` : ""}
              </p>
              <p className="mt-1 text-xs text-muted-foreground truncate" title={fileName}>
                {fileName}
              </p>
            </div>
          </div>

          <div>
            <div className="flex items-center gap-2 mb-2">
              <BookOpen className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">{t("gameSettings.resourceDetail.description")}</h3>
            </div>
            {description ? (
              <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">
                {description}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("gameSettings.resourceDetail.noDescription")}
              </p>
            )}
          </div>

          <RemoteVersionsSection
            fileName={fileName}
            displayName={displayName}
            instanceDir={instanceDir}
            mcVersion={mcVersion}
            loader={loader}
            resourceKind={resourceKind}
            onInstalled={onRefresh}
          />
        </div>
      </motion.div>
    </motion.div>
  );
}
