"use client";

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ExternalLink, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";

export const OPENP2P_LATEST_RELEASE_URL =
  "https://github.com/openp2p-cn/openp2p/releases/latest";

export function OpenP2PDownloadLink() {
  const [isOpening, setIsOpening] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleOpenLatestRelease = async () => {
    setIsOpening(true);
    setErrorMessage(null);

    try {
      await invoke("open_external", { url: OPENP2P_LATEST_RELEASE_URL });
    } catch {
      const openedWindow = window.open(
        OPENP2P_LATEST_RELEASE_URL,
        "_blank",
        "noopener,noreferrer"
      );
      if (!openedWindow) {
        setErrorMessage("无法打开下载页面，请稍后重试");
      }
    } finally {
      setIsOpening(false);
    }
  };

  return (
    <div className="flex flex-col items-center gap-1.5 text-center">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleOpenLatestRelease}
        disabled={isOpening}
      >
        {isOpening ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <ExternalLink className="size-3.5" />
        )}
        下载 OpenP2P 最新版本
      </Button>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        若 GitHub 无法访问，可尝试使用网络加速工具
      </p>
      {errorMessage && (
        <p role="alert" className="text-[11px] text-destructive">
          {errorMessage}
        </p>
      )}
    </div>
  );
}
