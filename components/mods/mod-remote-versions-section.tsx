"use client";

import React, { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, Download, Cloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/components/i18n/use-i18n";
import { isTauriRuntime } from "@/lib/tauri-runtime";
import {
  useDownloadManager,
  type ModUpdatePayload,
} from "@/components/download/download-provider";
import type { ModInfo } from "@/components/resource-panel";

interface RemoteModVersion {
  versionNumber: string;
  releaseType: string;
  downloadUrl: string;
  fileName: string;
  loaders: string[];
  source: string;
  publishedAt?: number | null;
}

interface ModRemoteVersionsResponse {
  resolved: { source: string; slug: string; title: string } | null;
  versions: RemoteModVersion[];
  message?: string;
}

export function ModRemoteVersionsSection({
  fileName,
  info,
  instanceDir,
  mcVersion,
  modLoader,
  onInstalled,
}: {
  fileName: string;
  info: ModInfo;
  instanceDir: string;
  mcVersion: string;
  modLoader: string;
  onInstalled: () => void;
}) {
  const { t } = useI18n();
  const { startModUpdate } = useDownloadManager();
  const [loading, setLoading] = useState(true);
  const [installingVersion, setInstallingVersion] = useState<string | null>(null);
  const [data, setData] = useState<ModRemoteVersionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadVersions = useCallback(async () => {
    if (!isTauriRuntime() || !instanceDir || !mcVersion || !modLoader) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<ModRemoteVersionsResponse>("list_mod_remote_versions", {
        instanceDir,
        fileName,
        mcVersion,
        loader: modLoader,
      });
      setData(result);
    } catch (e) {
      setError(String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [instanceDir, fileName, mcVersion, modLoader]);

  useEffect(() => {
    void loadVersions();
  }, [loadVersions]);

  const handleInstall = async (version: RemoteModVersion) => {
    if (!instanceDir || !mcVersion || !modLoader) return;
    const update: ModUpdatePayload = {
      fileName,
      modId: info.mod_id,
      modName: info.name || data?.resolved?.title || info.mod_id,
      currentVersion: info.version,
      newVersion: version.versionNumber,
      source: version.source,
      downloadUrl: version.downloadUrl,
      newFileName: version.fileName,
      slug: data?.resolved?.slug ?? info.mod_id,
    };
    setInstallingVersion(version.versionNumber);
    try {
      await startModUpdate(instanceDir, mcVersion, modLoader, update);
      onInstalled();
      await loadVersions();
    } catch (e) {
      console.error("update_mod failed:", e);
    } finally {
      setInstallingVersion(null);
    }
  };

  const normalizeVersionLabel = (version: string, mc: string) => {
    let v = version.trim().replace(/^v/i, "");
    const mcTrim = mc.trim();
    if (!mcTrim) return v.toLowerCase();
    const lower = v.toLowerCase();
    const suffixes = [
      `+${mcTrim}`,
      `+ ${mcTrim}`,
      ` for ${mcTrim}`,
      ` for mc ${mcTrim}`,
    ];
    for (const suffix of suffixes) {
      if (lower.endsWith(suffix.toLowerCase())) {
        v = v.slice(0, v.length - suffix.length).trimEnd();
        break;
      }
    }
    return v.toLowerCase();
  };

  const localNorm = normalizeVersionLabel(info.version, mcVersion);
  const isSameVersion = (version: RemoteModVersion) => {
    if (normalizeVersionLabel(version.versionNumber, mcVersion) !== localNorm) {
      return false;
    }
    const matching =
      data?.versions.filter(
        (v) => normalizeVersionLabel(v.versionNumber, mcVersion) === localNorm,
      ) ?? [];
    if (matching.length === 0) {
      return true;
    }
    const maxTs = Math.max(0, ...matching.map((v) => v.publishedAt ?? 0));
    if (maxTs === 0) {
      return true;
    }
    return (version.publishedAt ?? 0) >= maxTs;
  };

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
        <p className="text-sm text-muted-foreground">
          {data.message ?? t("panel.updateSourceNotFound")}
        </p>
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
