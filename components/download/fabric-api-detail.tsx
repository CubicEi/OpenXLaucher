"use client";

import { useState, useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { InputDialog } from "@/components/input-dialog";
import { LoaderVersionList } from "@/components/download/loader-version-list";
import { ArrowLeft, Download } from "lucide-react";
import { slideInFromRight, fadeIn } from "@/lib/motion";
import type { LoaderVersion } from "@/types";
import { invoke } from "@tauri-apps/api/core";
import { useDownloadManager } from "@/components/download/download-provider";
import { useI18n } from "@/components/i18n/use-i18n";
import { buildSingleLoaderInstanceName } from "@/lib/instance-name";

interface FabricApiDetailProps {
  mcVersion: string;
  onBack: () => void;
}

const FABRIC_LOADER_DEFAULT = "0.15.11";
const FABRIC_API_DETAIL_NOTICE_ID = "fabric-api-detail-versions";

export function FabricApiDetail({ mcVersion, onBack }: FabricApiDetailProps) {
  const { t } = useI18n();
  const [apiVersions, setApiVersions] = useState<LoaderVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedApiVersion, setSelectedApiVersion] = useState<LoaderVersion | null>(null);
  const [showNameDialog, setShowNameDialog] = useState(false);
  const [pendingApi, setPendingApi] = useState<LoaderVersion | null>(null);
  const [instanceNameInput, setInstanceNameInput] = useState("");
  const { startFabricDownload, pushNotice, dismissNotice } = useDownloadManager();
  const loadingNoticeActiveRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const fetchApiVersions = async () => {
      setLoading(true);
      pushNotice({
        id: FABRIC_API_DETAIL_NOTICE_ID,
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
        const versions: LoaderVersion[] = result.map((v) => ({
          id: v.id,
          version: v.version,
          releaseDate: "",
          isRecommended: false,
        }));
        setApiVersions(versions);
      } catch (err) {
        console.error("获取Fabric API版本列表失败:", err);
        if (!cancelled) setApiVersions([]);
      } finally {
        if (!cancelled) setLoading(false);
        if (loadingNoticeActiveRef.current) {
          dismissNotice(FABRIC_API_DETAIL_NOTICE_ID);
          loadingNoticeActiveRef.current = false;
        }
      }
    };
    void fetchApiVersions();
    return () => {
      cancelled = true;
      if (loadingNoticeActiveRef.current) {
        dismissNotice(FABRIC_API_DETAIL_NOTICE_ID);
        loadingNoticeActiveRef.current = false;
      }
    };
  }, [mcVersion, pushNotice, dismissNotice, t]);

  const defaultName = (_apiVer: string) =>
    buildSingleLoaderInstanceName(mcVersion, "fabric", FABRIC_LOADER_DEFAULT);

  const confirmDownload = async () => {
    if (!pendingApi) return;
    const name = instanceNameInput.trim();
    const instanceName = name.length > 0 ? name : defaultName(pendingApi.version);

    setShowNameDialog(false);
    const api = pendingApi;
    setPendingApi(null);

    try {
      await startFabricDownload(mcVersion, FABRIC_LOADER_DEFAULT, api.version, instanceName);
    } catch (err) {
      console.error("下载并安装Fabric API失败:", err);
    }
  };

  const handleInstall = async (apiVersion: LoaderVersion) => {
    setPendingApi(apiVersion);
    setInstanceNameInput(defaultName(apiVersion.version));
    setShowNameDialog(true);
  };

  return (
    <>
    <div className="flex h-full flex-col gap-4">
      {/* 返回按钮 + 版本信息头 */}
      <div className="flex items-center gap-3 shrink-0">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onBack}
          aria-label={t("download.back")}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold leading-none">
            Fabric API
          </h2>
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
            {mcVersion}
          </Badge>
        </div>
      </div>

      {/* 子标题区域 */}
      <div className="shrink-0">
        <h3 className="text-sm font-medium text-muted-foreground">
          {t("download.selectFabricApiVersion")}
        </h3>
        <p className="text-xs text-muted-foreground/70 mt-0.5">
          {t("download.selectFabricApiVersionHint")}
        </p>
      </div>

      {/* 内容区域 */}
      <div className="flex-1 min-h-0 overflow-y-auto p-1">
        <AnimatePresence mode="wait">
          {!loading ? (
            <motion.div
              key="list"
              variants={fadeIn}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              <LoaderVersionList
                loaderName="Fabric API"
                versions={apiVersions}
                onInstall={handleInstall}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>

    <InputDialog
      open={showNameDialog}
      onOpenChange={(open) => {
        setShowNameDialog(open);
        if (!open) setPendingApi(null);
      }}
      title={t("download.instanceName")}
      value={instanceNameInput}
      onValueChange={setInstanceNameInput}
      inputId="fabric-api-instance-name"
      placeholder={pendingApi ? defaultName(pendingApi.version) : ""}
      confirmLabel={t("download.startDownload")}
      cancelLabel={t("download.cancel")}
      onConfirm={confirmDownload}
      onInputKeyDown={(e) => {
        if (e.key === "Enter") confirmDownload();
      }}
    >
      <p>
        {t("download.instanceNameHintApi")}
        <code className="mx-1 px-1.5 py-0.5 rounded bg-muted text-xs">
          {pendingApi ? defaultName(pendingApi.version) : ""}
        </code>
      </p>
    </InputDialog>
    </>
  );
}
