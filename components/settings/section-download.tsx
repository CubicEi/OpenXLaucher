"use client";

import { Download } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  useSettings,
  DOWNLOAD_WORKERS_PER_FILE_MIN,
  DOWNLOAD_WORKERS_PER_FILE_MAX,
  DOWNLOAD_MAX_TOTAL_WORKERS_UNLIMITED,
  DOWNLOAD_MAX_TOTAL_WORKERS_MIN,
  DOWNLOAD_MAX_TOTAL_WORKERS_MAX,
  DOWNLOAD_TOTAL_WORKERS_SLIDER_UNLIMITED,
  clampDownloadSettings,
} from "@/components/settings/settings-provider";
import { useI18n } from "@/components/i18n/use-i18n";

const RANGE_CLASS =
  "accent-primary h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-muted";

function totalWorkersSliderValue(maxTotalWorkers: number) {
  if (maxTotalWorkers === DOWNLOAD_MAX_TOTAL_WORKERS_UNLIMITED) {
    return DOWNLOAD_TOTAL_WORKERS_SLIDER_UNLIMITED;
  }
  return maxTotalWorkers;
}

function totalWorkersFromSlider(sliderValue: number) {
  if (sliderValue >= DOWNLOAD_TOTAL_WORKERS_SLIDER_UNLIMITED) {
    return DOWNLOAD_MAX_TOTAL_WORKERS_UNLIMITED;
  }
  return sliderValue;
}

export function DownloadSection() {
  const { settings, update } = useSettings();
  const { t } = useI18n();
  const enabled = settings.general.autoDownloadModDependencies;
  const { workersPerFile, maxTotalWorkers } = settings.download;

  const applyDownloadPatch = (patch: { workersPerFile?: number; maxTotalWorkers?: number }) => {
    update(
      "download",
      clampDownloadSettings({ ...settings.download, ...patch }),
    );
  };

  const totalLabel =
    maxTotalWorkers === DOWNLOAD_MAX_TOTAL_WORKERS_UNLIMITED
      ? t("settings.download.unlimited")
      : String(maxTotalWorkers);

  return (
    <div className="space-y-4">
      <Card id="section-download" className="scroll-mt-4">
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2 text-base">
            <Download className="size-4 text-primary" />
            {t("settings.download.downloads")}
          </CardTitle>
          <CardDescription className="mt-1 text-xs">
            {t("settings.download.configureModDownloadBehavior")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
            <div className="space-y-1">
              <Label className="text-sm font-medium">
                {t("settings.download.downloadRequiredDependencies")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("settings.download.whenDownloadingModrinthOrCurseForgeModsAutomaticallyResolve")}
              </p>
            </div>
            <Switch
              checked={enabled}
              onCheckedChange={(checked) => update("general", { autoDownloadModDependencies: checked })}
              aria-label={t("settings.download.toggleRequiredDependencyDownloads")}
            />
          </div>

          <div className="space-y-3 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <Label className="text-sm font-medium">{t("settings.download.workersPerFile")}</Label>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("settings.download.workersPerFileDescription")}
                </p>
              </div>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">{workersPerFile}</span>
            </div>
            <input
              type="range"
              min={DOWNLOAD_WORKERS_PER_FILE_MIN}
              max={DOWNLOAD_WORKERS_PER_FILE_MAX}
              step={1}
              value={workersPerFile}
              onChange={(e) =>
                applyDownloadPatch({ workersPerFile: Number.parseInt(e.target.value, 10) })
              }
              className={RANGE_CLASS}
            />
          </div>

          <div className="space-y-3 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <Label className="text-sm font-medium">{t("settings.download.maxTotalWorkers")}</Label>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("settings.download.maxTotalWorkersDescription")}
                </p>
              </div>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">{totalLabel}</span>
            </div>
            <input
              type="range"
              min={DOWNLOAD_MAX_TOTAL_WORKERS_MIN}
              max={DOWNLOAD_TOTAL_WORKERS_SLIDER_UNLIMITED}
              step={1}
              value={totalWorkersSliderValue(maxTotalWorkers)}
              onChange={(e) =>
                applyDownloadPatch({
                  maxTotalWorkers: totalWorkersFromSlider(Number.parseInt(e.target.value, 10)),
                })
              }
              className={RANGE_CLASS}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
