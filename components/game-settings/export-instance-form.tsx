"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FlyCoords } from "@/components/process-list/fly-to-process-list";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, Package, Upload } from "lucide-react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/components/i18n/use-i18n";
import { ExportIncludeItem } from "@/components/game-settings/export-include-item";
import { fadeSlideUp } from "@/lib/motion";
import type { InstanceExportOptions } from "@/types";

const SAVE_SIZE_WARN_BYTES = 512 * 1024 * 1024;

export type ExportInstanceFormProps = {
  minecraftPath: string;
  instanceFolder: string;
  defaultPackName: string;
  disabled?: boolean;
  onExport: (
    options: InstanceExportOptions,
    flyFrom?: FlyCoords,
  ) => Promise<void>;
};

type OutputMode = "pack_only" | "portable_folder";
type PackFormat = "modrinth" | "curseforge";

export function ExportInstanceForm({
  minecraftPath,
  instanceFolder,
  defaultPackName,
  disabled = false,
  onExport,
}: ExportInstanceFormProps) {
  const { t } = useI18n();

  const [packName, setPackName] = useState(defaultPackName);
  const [packVersion, setPackVersion] = useState("1.0.0");
  const [summary, setSummary] = useState("");
  const [format, setFormat] = useState<PackFormat>("modrinth");
  const [outputMode, setOutputMode] = useState<OutputMode>("pack_only");

  const [includeMods, setIncludeMods] = useState(true);
  const [includeModConfigs, setIncludeModConfigs] = useState(true);
  const [includeShaderpacks, setIncludeShaderpacks] = useState(true);
  const [includeShaderConfigs, setIncludeShaderConfigs] = useState(true);
  const [includeResourcepacks, setIncludeResourcepacks] = useState(true);
  const [includeGameSettings, setIncludeGameSettings] = useState(true);
  const [includeSaves, setIncludeSaves] = useState(false);
  const [includeLauncher, setIncludeLauncher] = useState(true);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sizeWarnOpen, setSizeWarnOpen] = useState(false);
  const [pendingExport, setPendingExport] = useState(false);
  const exportBtnRef = useRef<HTMLButtonElement>(null);
  const flyOriginRef = useRef<FlyCoords | null>(null);

  const resolveFlyOrigin = (): FlyCoords | undefined => {
    if (flyOriginRef.current) return flyOriginRef.current;
    const el = exportBtnRef.current;
    if (!el) return undefined;
    const rect = el.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  };

  useEffect(() => {
    setPackName(defaultPackName);
  }, [defaultPackName]);

  const buildOptions = useCallback(
    (outputPath: string): InstanceExportOptions => ({
      minecraftPath,
      instanceFolder,
      packName: packName.trim() || defaultPackName,
      packVersion: packVersion.trim() || "1.0.0",
      summary: summary.trim() ? summary.trim() : undefined,
      format,
      outputMode,
      outputPath,
      // Portable always bundles the launcher; pack_only never does.
      includeLauncher: outputMode === "portable_folder",
      includeMods,
      includeModConfigs,
      includeShaderpacks,
      includeShaderConfigs,
      includeResourcepacks,
      includeGameSettings,
      includeSaves,
    }),
    [
      minecraftPath,
      instanceFolder,
      packName,
      packVersion,
      summary,
      format,
      outputMode,
      includeMods,
      includeModConfigs,
      includeShaderpacks,
      includeShaderConfigs,
      includeResourcepacks,
      includeGameSettings,
      includeSaves,
      defaultPackName,
    ],
  );

  const pickOutputPath = async (): Promise<string | null> => {
    const mod = await import("@tauri-apps/plugin-dialog");
    if (outputMode === "portable_folder") {
      const dir = await mod.open({ directory: true, multiple: false });
      return typeof dir === "string" ? dir : null;
    }
    const ext = format === "curseforge" ? "zip" : "mrpack";
    const defaultPath = `${packName.trim() || defaultPackName}.${ext}`;
    const file = await mod.save({
      defaultPath,
      filters: [
        {
          name: format === "curseforge" ? "CurseForge" : "Modrinth",
          extensions: [ext],
        },
      ],
    });
    return typeof file === "string" ? file : null;
  };

  const runExport = async () => {
    setError(null);
    const outputPath = await pickOutputPath();
    if (!outputPath) return;

    setSubmitting(true);
    try {
      await onExport(buildOptions(outputPath), resolveFlyOrigin());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const handleExportClick = async () => {
    setError(null);
    try {
      const size = await invoke<number>("estimate_instance_export_size_cmd", {
        options: buildOptions(""),
      });
      if (includeSaves && size > SAVE_SIZE_WARN_BYTES) {
        setPendingExport(true);
        setSizeWarnOpen(true);
        return;
      }
    } catch {
      /* estimate optional */
    }
    await runExport();
  };

  const formDisabled = disabled || submitting;

  const includeItems: {
    checked: boolean;
    setChecked: (v: boolean) => void;
    labelKey: Parameters<typeof t>[0];
  }[] = [
    { checked: includeMods, setChecked: setIncludeMods, labelKey: "gameSettings.exportIncludeMods" },
    { checked: includeModConfigs, setChecked: setIncludeModConfigs, labelKey: "gameSettings.exportIncludeModConfigs" },
    { checked: includeShaderpacks, setChecked: setIncludeShaderpacks, labelKey: "gameSettings.exportIncludeShaderpacks" },
    { checked: includeShaderConfigs, setChecked: setIncludeShaderConfigs, labelKey: "gameSettings.exportIncludeShaderConfigs" },
    { checked: includeResourcepacks, setChecked: setIncludeResourcepacks, labelKey: "gameSettings.exportIncludeResourcepacks" },
    { checked: includeGameSettings, setChecked: setIncludeGameSettings, labelKey: "gameSettings.exportIncludeGameSettings" },
    { checked: includeSaves, setChecked: setIncludeSaves, labelKey: "gameSettings.exportIncludeSaves" },
  ];

  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden p-4">
      {/* 与模组管理页 ResourcePanel 标题栏一致：图标 + 标题 + 右侧操作 */}
      <motion.div
        variants={fadeSlideUp}
        initial="initial"
        animate="animate"
        className="flex shrink-0 items-center gap-3"
      >
        <div className="flex size-9 items-center justify-center rounded-xl bg-sky-500/10">
          <Package className="size-5 text-sky-500" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold leading-none">
            {t("gameSettings.exportInstance")}
          </h1>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {t("gameSettings.exportInstanceHint")}
            {instanceFolder ? ` · ${instanceFolder}` : ""}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            ref={exportBtnRef}
            type="button"
            size="sm"
            className="h-8 gap-1.5"
            disabled={formDisabled}
            onPointerDown={(e) => {
              flyOriginRef.current = { x: e.clientX, y: e.clientY };
            }}
            onClick={handleExportClick}
          >
            {submitting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Upload className="size-3.5" />
            )}
            {t("gameSettings.exportStart")}
          </Button>
        </div>
      </motion.div>

      <motion.div
        variants={fadeSlideUp}
        initial="initial"
        animate="animate"
        transition={{ delay: 0.05 }}
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden md:flex-row"
      >
        {/* 左侧约 1/3：元数据与输出选项 */}
        <section className="flex min-h-0 w-full flex-col gap-4 overflow-y-auto md:w-1/3 md:shrink-0 md:border-r md:border-border md:pr-4">
          <div className="grid gap-2">
            <Label>{t("gameSettings.exportPackName")}</Label>
            <Input
              value={packName}
              onChange={(e) => setPackName(e.target.value)}
              disabled={formDisabled}
            />
          </div>

          <div className="grid gap-2">
            <Label>{t("gameSettings.exportPackVersion")}</Label>
            <Input
              value={packVersion}
              onChange={(e) => setPackVersion(e.target.value)}
              disabled={formDisabled}
            />
          </div>

          <div className="grid gap-2">
            <Label>{t("gameSettings.exportSummary")}</Label>
            <Input
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              disabled={formDisabled}
              placeholder={t("gameSettings.exportSummaryPlaceholder")}
            />
          </div>

          <div className="space-y-2">
            <Label>{t("gameSettings.exportFormat")}</Label>
            <div className="flex flex-col gap-1.5">
              <Button
                type="button"
                size="sm"
                className="w-full justify-start"
                variant={format === "modrinth" ? "default" : "outline"}
                disabled={formDisabled}
                onClick={() => setFormat("modrinth")}
              >
                Modrinth (.mrpack)
              </Button>
              <Button
                type="button"
                size="sm"
                className="w-full justify-start"
                variant={format === "curseforge" ? "default" : "outline"}
                disabled={formDisabled}
                onClick={() => setFormat("curseforge")}
              >
                CurseForge (.zip)
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <Label>{t("gameSettings.exportOutputMode")}</Label>
            <div className="flex flex-col gap-1.5">
              <Button
                type="button"
                size="sm"
                className="w-full justify-start"
                variant={outputMode === "pack_only" ? "default" : "outline"}
                disabled={formDisabled}
                onClick={() => setOutputMode("pack_only")}
              >
                {t("gameSettings.exportModePackOnly")}
              </Button>
              <Button
                type="button"
                size="sm"
                className="w-full justify-start"
                variant={outputMode === "portable_folder" ? "default" : "outline"}
                disabled={formDisabled}
                onClick={() => {
                  setIncludeLauncher(true);
                  setOutputMode("portable_folder");
                }}
              >
                {t("gameSettings.exportModePortable")}
              </Button>
            </div>
            {outputMode === "portable_folder" && (
              <p className="text-xs text-muted-foreground">
                {t("gameSettings.exportPortableHint")}
              </p>
            )}
          </div>

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </section>

        {/* 右侧约 2/3：包含内容纵向列表 */}
        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:pl-1">
          <p className="mb-2 shrink-0 text-xs font-medium text-muted-foreground">
            {t("gameSettings.exportInclude")}
          </p>
          <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto rounded-xl border border-border bg-card p-2">
            {includeItems.map((item) => (
              <ExportIncludeItem
                key={item.labelKey}
                checked={item.checked}
                label={t(item.labelKey)}
                disabled={formDisabled}
                onToggle={item.setChecked}
              />
            ))}
            <ExportIncludeItem
              checked={outputMode === "portable_folder" ? true : includeLauncher}
              label={t("gameSettings.exportIncludeLauncher")}
              disabled={formDisabled || outputMode === "portable_folder"}
              onToggle={setIncludeLauncher}
            />
          </div>
          {includeSaves && (
            <p className="mt-2 shrink-0 text-xs text-amber-600 dark:text-amber-400">
              {t("gameSettings.exportSavesSizeHint")}
            </p>
          )}
        </section>
      </motion.div>

      <Dialog open={sizeWarnOpen} onOpenChange={setSizeWarnOpen}>
        <DialogContent className="!max-w-md p-0">
          <DialogHeader>
            <DialogTitle>{t("gameSettings.exportSavesSizeWarnTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 p-5 pt-0">
            <p className="text-sm text-muted-foreground">
              {t("gameSettings.exportSavesSizeWarnBody")}
            </p>
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setSizeWarnOpen(false);
                  setPendingExport(false);
                }}
              >
                {t("common.cancel")}
              </Button>
              <Button
                onClick={async () => {
                  setSizeWarnOpen(false);
                  if (pendingExport) {
                    setPendingExport(false);
                    await runExport();
                  }
                }}
              >
                {t("gameSettings.exportSavesSizeWarnContinue")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
