"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, FolderOpen, Loader2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/i18n/use-i18n";
import { useDownloadManager } from "@/components/download/download-provider";

const HTTP_URL_RE = /^https?:\/\/.+/i;

function inferFileName(url: string): string {
  try {
    const parsed = new URL(url.trim());
    const segment = parsed.pathname.split("/").filter(Boolean).pop();
    return segment && segment.length > 0 ? segment : "download.bin";
  } catch {
    return "download.bin";
  }
}

export function CustomDownloadCard() {
  const { t } = useI18n();
  const { startCustomDownload } = useDownloadManager();
  const [url, setUrl] = useState("");
  const [directory, setDirectory] = useState("");
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void invoke<{ customDownloadDirectory?: string | null }>("get_download_prefs")
      .then((prefs) => {
        if (prefs.customDownloadDirectory) {
          setDirectory(prefs.customDownloadDirectory);
        }
      })
      .catch(() => {
        /* 浏览器预览或无 Tauri */
      });
  }, []);

  const persistDirectory = async (path: string) => {
    try {
      await invoke("set_custom_download_directory", {
        directory: path.trim() || null,
      });
    } catch {
      /* ignore */
    }
  };

  const urlValid = useMemo(() => HTTP_URL_RE.test(url.trim()), [url]);
  const canStart = urlValid && directory.trim().length > 0 && !busy;

  const browseDirectory = async () => {
    try {
      const mod = await import("@tauri-apps/plugin-dialog");
      const result = await mod.open({ directory: true, multiple: false });
      if (typeof result === "string" && result) {
        setDirectory(result);
        setError(null);
        await persistDirectory(result);
      }
    } catch {
      /* 用户取消或非 Tauri 环境 */
    }
  };

  const startDownload = async () => {
    if (!canStart) return;
    setBusy(true);
    setError(null);
    try {
      await persistDirectory(directory);
      const trimmedName = fileName.trim();
      await startCustomDownload({
        url: url.trim(),
        directory: directory.trim(),
        fileName: trimmedName.length > 0 ? trimmedName : null,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message || t("tools.customDownload.startFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Download className="size-4 text-primary" />
          {t("tools.customDownload.title")}
        </CardTitle>
        <CardDescription className="text-xs">{t("tools.customDownload.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="custom-download-url">{t("tools.customDownload.url")}</Label>
          <Input
            id="custom-download-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t("tools.customDownload.urlPlaceholder")}
            autoComplete="off"
          />
          {url.length > 0 && !urlValid && (
            <p className="text-xs text-destructive">{t("tools.customDownload.invalidUrl")}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label>{t("tools.customDownload.saveDirectory")}</Label>
          <div className="flex gap-2">
            <Input value={directory} readOnly placeholder="…" className="min-w-0 flex-1" />
            <Button type="button" variant="outline" size="sm" className="shrink-0 gap-1.5" onClick={browseDirectory}>
              <FolderOpen className="size-3.5" />
              {t("tools.customDownload.browse")}
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="custom-download-filename">{t("tools.customDownload.fileName")}</Label>
          <Input
            id="custom-download-filename"
            value={fileName}
            onChange={(e) => setFileName(e.target.value)}
            placeholder={
              urlValid
                ? inferFileName(url)
                : t("tools.customDownload.fileNamePlaceholder")
            }
          />
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        <Button type="button" className="gap-2" disabled={!canStart} onClick={startDownload}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
          {busy ? t("tools.customDownload.downloading") : t("tools.customDownload.start")}
        </Button>
      </CardContent>
    </Card>
  );
}
