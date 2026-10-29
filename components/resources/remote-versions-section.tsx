"use client";

import React, { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, Download, Cloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useI18n, type TranslationKey } from "@/components/i18n/use-i18n";
import { isTauriRuntime } from "@/lib/tauri-runtime";
import {
  useDownloadManager,
  type ModUpdatePayload,
} from "@/components/download/download-provider";
import type { ResourceKindWire } from "@/lib/resource-kind";

interface RemoteModVersion {
  versionNumber: string;
  releaseType: string;
  downloadUrl: string;
  fileName: string;
  loaders: string[];
  source: string;
  publishedAt?: number | null;
}

interface InstalledFileSnapshot {
  versionNumber: string;
  publishedAt?: number | null;
  fileName: string;
  slug: string;
  title: string;
  source: string;
}

interface ModRemoteVersionsResponse {
  resolved: { source: string; slug: string; title: string } | null;
  installed?: InstalledFileSnapshot | null;
  versions: RemoteModVersion[];
  message?: string;
}

function translatePanelKey(
  t: (key: TranslationKey) => string,
  message: string,
) {
  if (message.startsWith("panel.")) {
    return t(message as TranslationKey);
  }
  return message;
}

export function RemoteVersionsSection({
  fileName,
  displayName,
  modId,
  currentVersion,
  instanceDir,
  storageSubdir,
  mcVersion,
  loader,
  resourceKind,
  onInstalled,
}: {
  fileName: string;
  displayName: string;
  modId?: string;
  currentVersion?: string;
  instanceDir: string;
  /** When set to "", file is resolved at instanceDir root (mod cache library). */
  storageSubdir?: string;
  mcVersion: string;
  loader: string;
  resourceKind: ResourceKindWire;
  onInstalled: () => void;
}) {
  const { t } = useI18n();
  const { startModUpdate } = useDownloadManager();
  const [loading, setLoading] = useState(true);
  const [installingVersion, setInstallingVersion] = useState<string | null>(null);
  const [data, setData] = useState<ModRemoteVersionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadVersions = useCallback(async () => {
    if (!isTauriRuntime() || !instanceDir || !mcVersion) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<ModRemoteVersionsResponse>(
        "list_resource_remote_versions",
        {
          instanceDir,
          fileName,
          mcVersion,
          loader,
          resourceKind,
          storageSubdir: storageSubdir ?? null,
        }
      );
      setData(result);
    } catch (e) {
      setError(translatePanelKey(t, String(e)));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [instanceDir, fileName, mcVersion, loader, resourceKind, storageSubdir, t]);

  useEffect(() => {
    void loadVersions();
  }, [loadVersions]);

  const handleInstall = async (version: RemoteModVersion) => {
    if (!instanceDir || !mcVersion) return;
    const installed = data?.installed;
    const update: ModUpdatePayload = {
      fileName,
      modId: modId ?? data?.resolved?.slug ?? installed?.slug ?? fileName,
      modName: displayName || data?.resolved?.title || fileName,
      currentVersion: installed?.versionNumber ?? currentVersion ?? "",
      newVersion: version.versionNumber,
      source: version.source,
      downloadUrl: version.downloadUrl,
      newFileName: version.fileName,
      slug: data?.resolved?.slug ?? installed?.slug ?? modId ?? fileName,
    };
    setInstallingVersion(version.versionNumber);
    try {
      await startModUpdate(instanceDir, mcVersion, loader, update, resourceKind);
      onInstalled();
      await loadVersions();
    } catch (e) {
      console.error("update_resource failed:", e);
    } finally {
      setInstallingVersion(null);
    }
  };

  const isSameVersion = (version: RemoteModVersion) => {
    const installed = data?.installed;
    if (!installed) return false;
    if (version.fileName !== installed.fileName) return false;
    const instTs = installed.publishedAt ?? 0;
    const verTs = version.publishedAt ?? 0;
    if (instTs > 0 || verTs > 0) {
      return instTs === verTs;
    }
    return version.versionNumber === installed.versionNumber;
  };

  const emptyMessage = data?.message
    ? translatePanelKey(t, data.message)
    : t("panel.updateSourceNotFound");

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Cloud className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">{t("panel.remoteVersionsTitle")}</h3>
        {data?.resolved && (
          <Badge variant="outline" className="text-xs">
            {data.resolved.source} · {data.resolved.slug}
          </Badge>
        )}
      </div>
      {data?.resolved && (
        <p className="text-xs text-muted-foreground mb-3">
          {t("panel.remoteVersionsResolved", {
            title: data.resolved.title,
            source: data.resolved.source,
          })}
        </p>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
          <Loader2 className="size-4 animate-spin" />
          {t("panel.remoteVersionsLoading")}
        </div>
      )}

      {!loading && error && (
        <p className="text-sm text-destructive">{error}</p>
      )}

      {!loading && !error && data && data.versions.length === 0 && (
        <p className="text-sm text-muted-foreground">{emptyMessage}</p>
      )}

      {!loading && !error && data && data.versions.length > 0 && (
        <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
          {data.versions.map((version) => {
            const same = isSameVersion(version);
            const busy = installingVersion === version.versionNumber;
            return (
              <div
                key={`${version.source}-${version.versionNumber}-${version.fileName}`}
                className="rounded-lg border p-3 flex items-center gap-3"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{version.versionNumber}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {version.releaseType}
                    {version.loaders.length > 0 && ` · ${version.loaders.join(", ")}`}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant={same ? "secondary" : "default"}
                  disabled={same || busy || installingVersion !== null}
                  onClick={() => void handleInstall(version)}
                >
                  {busy ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Download className="size-4" />
                  )}
                  <span className="ml-1.5">
                    {same ? t("panel.remoteVersionCurrent") : t("panel.remoteVersionInstall")}
                  </span>
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
