"use client";

import { Network } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useSettings } from "@/components/settings/settings-provider";
import { useI18n } from "@/components/i18n/use-i18n";

export function NetworkProxySection() {
  const { settings, update } = useSettings();
  const { t } = useI18n();
  const enabled = settings.general.useSystemProxy;

  return (
    <Card id="section-network-proxy" className="scroll-mt-4">
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2 text-base">
          <Network className="size-4 text-primary" />
          {t("settings.general.systemProxyTitle")}
        </CardTitle>
        <CardDescription className="mt-1 text-xs">{t("settings.general.systemProxyDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
          <div className="space-y-1">
            <Label className="text-sm font-medium">{t("settings.general.useSystemProxy")}</Label>
            <p className="text-xs text-muted-foreground">{t("settings.general.systemProxyHint")}</p>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={(checked) => {
              update("general", { useSystemProxy: checked });
              void import("@tauri-apps/api/core")
                .then(({ invoke }) => invoke("set_network_proxy_preference", { enabled: checked }))
                .catch(() => {});
            }}
            aria-label={t("settings.general.toggleSystemProxy")}
          />
        </div>
      </CardContent>
    </Card>
  );
}
