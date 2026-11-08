"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  ExportIncludeExpandable,
  ExportIncludeItem,
} from "@/components/game-settings/export-include-item";
import { fadeSlideUp } from "@/lib/motion";
import {
  GAME_SETTINGS_EXPORT_ICON_BG,
  GAME_SETTINGS_EXPORT_ICON_TEXT,
} from "@/constants/index";
import { cn } from "@/lib/utils";
import type { DirEntry, InstanceExportOptions } from "@/types";

const SAVE_SIZE_WARN_BYTES = 512 * 1024 * 1024;
const PACK_FILE_EXTS = new Set(["zip", "jar"]);

function isPackEntry(entry: DirEntry): boolean {
  if (entry.is_dir) return true;
  return PACK_FILE_EXTS.has((entry.extension || "").toLowerCase());
}

function toggleName(list: string[], name: string, next: boolean): string[] {
  if (next) {
    return list.includes(name) ? list : [...list, name];
  }
  return list.filter((n) => n !== name);
}

/** 与启动配置「游戏进程优先级」一致的分段切换 */
function ExportSegment<T extends string>({
  value,
  onChange,
  options,
  disabled,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  disabled?: boolean;
}) {
  return (
    <div className="flex w-full gap-1 rounded-lg bg-muted p-1">
      {options.map(({ value: optionValue, label }) => {
        const selected = value === optionValue;
        return (
          <button
            key={optionValue}
            type="button"
            disabled={disabled}
            className={cn(
              "flex-1 rounded-md px-2 py-1 text-xs font-medium leading-tight transition-colors",
              selected
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
              disabled && "pointer-events-none opacity-50",
            )}
            onClick={() => onChange(optionValue)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

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
  const [embedAllFiles, setEmbedAllFiles] = useState(false);

  const [includeMods, setIncludeMods] = useState(true);
  const [includeModConfigs, setIncludeModConfigs] = useState(false);
  const [includeShaderConfigs, setIncludeShaderConfigs] = useState(false);
  const [includeGameSettings, setIncludeGameSettings] = useState(true);
  const [includeSaves, setIncludeSaves] = useState(false);
  const [includeSchematics, setIncludeSchematics] = useState(false);
  const [includeServerList, setIncludeServerList] = useState(false);

  const [resourcepackNames, setResourcepackNames] = useState<string[]>([]);
  const [shaderpackNames, setShaderpackNames] = useState<string[]>([]);
  const [availableResourcepacks, setAvailableResourcepacks] = useState<string[]>([]);
  const [availableShaderpacks, setAvailableShaderpacks] = useState<string[]>([]);
  const [resourceExpanded, setResourceExpanded] = useState(false);
  const [shaderExpanded, setShaderExpanded] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sizeWarnOpen, setSizeWarnOpen] = useState(false);
  const [pendingExport, setPendingExport] = useState(false);
  const exportBtnRef = useRef<HTMLButtonElement>(null);
  const flyOriginRef = useRef<FlyCoords | null>(null);

  const instanceRoot = useMemo(() => {
    if (!minecraftPath || !instanceFolder) return "";
    return `${minecraftPath.replace(/[\\/]+$/, "")}/versions/${instanceFolder}`;
  }, [minecraftPath, instanceFolder]);

  useEffect(() => {
    let cancelled = false;
    async function loadPacks(subdir: "resourcepacks" | "shaderpacks") {
      if (!instanceRoot) return [] as string[];
      try {
        const entries = await invoke<DirEntry[]>("vm_list_dir", {
          dirPath: `${instanceRoot}/${subdir}`,
          extensionsFilter: [] as string[],
        });
        return entries
          .filter(isPackEntry)
          .map((e) => e.name)
          .sort((a, b) => a.localeCompare(b));
      } catch {
        return [] as string[];
      }
    }

    void (async () => {
      const [resources, shaders] = await Promise.all([
        loadPacks("resourcepacks"),
        loadPacks("shaderpacks"),
      ]);
      if (cancelled) return;
      setAvailableResourcepacks(resources);
      setAvailableShaderpacks(shaders);
      // Default export only includes mods + game settings; packs stay unchecked.
      setResourcepackNames([]);
      setShaderpackNames([]);
    })();

    return () => {
      cancelled = true;
    };
  }, [instanceRoot]);

  const includeResourcepacks = resourcepackNames.length > 0;
  const includeShaderpacks = shaderpackNames.length > 0;

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
      embedAllFiles,
      // Portable always bundles the launcher; pack_only never does.
      includeLauncher: outputMode === "portable_folder",
      includeMods,
      includeModConfigs,
      includeShaderpacks,
      includeShaderConfigs,
      includeResourcepacks,
      resourcepackNames,
      shaderpackNames,
      includeGameSettings,
      includeSaves,
      includeSchematics,
      includeServerList,
    }),
    [
      minecraftPath,
      instanceFolder,
      packName,
      packVersion,
      summary,
      format,
      outputMode,
      embedAllFiles,
      includeMods,
      includeModConfigs,
      includeShaderpacks,
      includeShaderConfigs,
      includeResourcepacks,
      resourcepackNames,
      shaderpackNames,
      includeGameSettings,
      includeSaves,
      includeSchematics,
      includeServerList,
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

  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden p-4">
      <motion.div
        variants={fadeSlideUp}
        initial="initial"
        animate="animate"
        className="flex shrink-0 items-center gap-3"
      >
        <div className={`flex size-9 items-center justify-center rounded-xl ${GAME_SETTINGS_EXPORT_ICON_BG}`}>
          <Package className={`size-5 ${GAME_SETTINGS_EXPORT_ICON_TEXT}`} />
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
        <section className="flex min-h-0 w-full flex-col gap-3 overflow-y-auto md:w-1/3 md:shrink-0 md:border-r md:border-border md:pr-4">
          <div className="grid gap-1.5">
            <Label className="text-xs">{t("gameSettings.exportPackName")}</Label>
            <Input
              className="h-7 px-2.5 text-xs"
              value={packName}
              onChange={(e) => setPackName(e.target.value)}
              disabled={formDisabled}
            />
          </div>

          <div className="grid gap-1.5">
            <Label className="text-xs">{t("gameSettings.exportPackVersion")}</Label>
            <Input
              className="h-7 px-2.5 text-xs"
              value={packVersion}
              onChange={(e) => setPackVersion(e.target.value)}
              disabled={formDisabled}
            />
          </div>

          <div className="grid gap-1.5">
            <Label className="text-xs">{t("gameSettings.exportSummary")}</Label>
            <Input
              className="h-7 px-2.5 text-xs"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              disabled={formDisabled}
              placeholder={t("gameSettings.exportSummaryPlaceholder")}
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">{t("gameSettings.exportFormat")}</Label>
            <ExportSegment
              value={format}
              disabled={formDisabled}
              onChange={setFormat}
              options={[
                { value: "modrinth", label: "Modrinth (.mrpack)" },
                { value: "curseforge", label: "CurseForge (.zip)" },
              ]}
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">{t("gameSettings.exportOutputMode")}</Label>
            <ExportSegment
              value={outputMode}
              disabled={formDisabled}
              onChange={setOutputMode}
              options={[
                { value: "pack_only", label: t("gameSettings.exportModePackOnly") },
                { value: "portable_folder", label: t("gameSettings.exportModePortable") },
              ]}
            />
            {outputMode === "portable_folder" && (
              <p className="text-[11px] leading-snug text-muted-foreground">
                {t("gameSettings.exportPortableHint")}
              </p>
            )}
            <ExportIncludeItem
              checked={embedAllFiles}
              label={t("gameSettings.exportEmbedAllFiles")}
              disabled={formDisabled}
              onToggle={setEmbedAllFiles}
            />
            {embedAllFiles && (
              <p className="text-[11px] leading-snug text-muted-foreground">
                {t("gameSettings.exportEmbedAllFilesHint")}
              </p>
            )}
          </div>

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </section>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:pl-1">
          <p className="mb-2 shrink-0 text-xs font-medium text-muted-foreground">
            {t("gameSettings.exportInclude")}
          </p>
          <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto rounded-xl border border-border bg-card p-2">
            <ExportIncludeItem
              checked={includeMods}
              label={t("gameSettings.exportIncludeMods")}
              disabled={formDisabled}
              onToggle={(next) => {
                setIncludeMods(next);
                if (!next) setIncludeModConfigs(false);
              }}
            />
            <ExportIncludeItem
              checked={includeModConfigs}
              label={t("gameSettings.exportIncludeModConfigs")}
              disabled={formDisabled || !includeMods}
              onToggle={setIncludeModConfigs}
            />

            <ExportIncludeExpandable
              checked={includeResourcepacks}
              label={t("gameSettings.exportIncludeResourcepacks")}
              disabled={formDisabled}
              expanded={resourceExpanded}
              onExpandedChange={setResourceExpanded}
              onToggle={(next) => {
                setResourcepackNames(next ? [...availableResourcepacks] : []);
              }}
            >
              {availableResourcepacks.length === 0 ? (
                <p className="px-3 py-2 pl-9 text-xs text-muted-foreground">
                  {t("gameSettings.exportIncludeEmptyPacks")}
                </p>
              ) : (
                availableResourcepacks.map((name) => (
                  <ExportIncludeItem
                    key={name}
                    indent
                    checked={resourcepackNames.includes(name)}
                    label={name}
                    disabled={formDisabled}
                    onToggle={(next) =>
                      setResourcepackNames((prev) => toggleName(prev, name, next))
                    }
                  />
                ))
              )}
            </ExportIncludeExpandable>

            <ExportIncludeExpandable
              checked={includeShaderpacks || includeShaderConfigs}
              label={t("gameSettings.exportIncludeShaderpacks")}
              disabled={formDisabled}
              expanded={shaderExpanded}
              onExpandedChange={setShaderExpanded}
              onToggle={(next) => {
                setIncludeShaderConfigs(next);
                setShaderpackNames(next ? [...availableShaderpacks] : []);
              }}
            >
              <ExportIncludeItem
                indent
                checked={includeShaderConfigs}
                label={t("gameSettings.exportIncludeSelectedShaderConfig")}
                disabled={formDisabled}
                onToggle={setIncludeShaderConfigs}
              />
              {availableShaderpacks.length === 0 ? (
                <p className="px-3 py-2 pl-9 text-xs text-muted-foreground">
                  {t("gameSettings.exportIncludeEmptyPacks")}
                </p>
              ) : (
                availableShaderpacks.map((name) => (
                  <ExportIncludeItem
                    key={name}
                    indent
                    checked={shaderpackNames.includes(name)}
                    label={name}
                    disabled={formDisabled}
                    onToggle={(next) =>
                      setShaderpackNames((prev) => toggleName(prev, name, next))
                    }
                  />
                ))
              )}
            </ExportIncludeExpandable>

            <ExportIncludeItem
              checked={includeGameSettings}
              label={t("gameSettings.exportIncludeGameSettings")}
              disabled={formDisabled}
              onToggle={setIncludeGameSettings}
            />
            <ExportIncludeItem
              checked={includeSaves}
              label={t("gameSettings.exportIncludeSaves")}
              disabled={formDisabled}
              onToggle={setIncludeSaves}
            />
            <ExportIncludeItem
              checked={includeSchematics}
              label={t("gameSettings.exportIncludeSchematics")}
              disabled={formDisabled}
              onToggle={setIncludeSchematics}
            />
            <ExportIncludeItem
              checked={includeServerList}
              label={t("gameSettings.exportIncludeServerList")}
              disabled={formDisabled}
              onToggle={setIncludeServerList}
            />
            <ExportIncludeItem
              checked={outputMode === "portable_folder"}
              label={t("gameSettings.exportIncludeLauncher")}
              disabled
              onToggle={() => {}}
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
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setSizeWarnOpen(false);
                  setPendingExport(false);
                }}
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  setSizeWarnOpen(false);
                  if (pendingExport) {
                    setPendingExport(false);
                    void runExport();
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
