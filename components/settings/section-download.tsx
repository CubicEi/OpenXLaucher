"use client";

import { Download } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useSettings } from "@/components/settings/settings-provider";
import { useI18n } from "@/components/i18n/use-i18n";

export function DownloadSection() {
  const { settings, update } = useSettings();
  const { t } = useI18n();
  const enabled = settings.general.autoDownloadModDependencies;

  return (
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
      <CardContent>
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
      </CardContent>
    </Card>
  );
}
