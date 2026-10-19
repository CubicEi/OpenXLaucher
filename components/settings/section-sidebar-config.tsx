"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useUIConfigContext } from "@/components/ui-config/ui-config-provider";
import { Home, Gamepad2, Rocket, Download, Globe, Wrench, Settings, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/components/i18n/use-i18n";

const TAB_ICONS: Record<string, React.ReactNode> = {
  home: <Home className="size-4" />,
  "game-settings": <Gamepad2 className="size-4" />,
  launch: <Rocket className="size-4" />,
  download: <Download className="size-4" />,
  multiplayer: <Globe className="size-4" />,
  tools: <Wrench className="size-4" />,
  settings: <Settings className="size-4" />,
};

const TAB_NAMES_EN: Record<string, string> = {
  home: "Home",
  "game-settings": "Game Settings",
  launch: "Launch",
  download: "Downloads",
  multiplayer: "Multiplayer",
  tools: "Tools",
  settings: "Settings",
};

export function SidebarConfigSection() {
  const { config, updateTabVisibility, resetConfig } = useUIConfigContext();
  const { isEnglish, t } = useI18n();

  const handleReset = () => {
    if (confirm(t("settings.sidebarConfig.resetAllSidebarTabsToTheirDefaultVisibility"))) {
      resetConfig();
    }
  };

  return (
    <Card id="section-sidebar-config" size="sm">
      <CardHeader>
        <CardTitle>{t("settings.sidebarConfig.sidebarTabs")}</CardTitle>
        <CardDescription>
          {t("settings.sidebarConfig.chooseWhichTabsAppearInTheSidebarAndHide")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          {config.sidebarTabs.map((tab) => (
            <div
              key={tab.id}
              className={cn(
                "flex items-center justify-between rounded-lg border p-3",
                !tab.canHide && "bg-muted/50"
              )}
            >
              <div className="flex items-center gap-3">
                <div className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                  {TAB_ICONS[tab.id] || <Settings className="size-4" />}
                </div>
                <div>
                  <p className="text-sm font-medium">{isEnglish ? TAB_NAMES_EN[tab.id] ?? tab.name : tab.name}</p>
                  {!tab.canHide && (
                    <p className="text-[10px] text-muted-foreground">
                      {t("settings.sidebarConfig.coreFeatureAlwaysVisible")}
                    </p>
                  )}
                </div>
              </div>
              <Switch
                checked={tab.visible}
                onCheckedChange={(checked) => updateTabVisibility(tab.id, checked)}
                disabled={!tab.canHide}
              />
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between pt-2 border-t">
          <p className="text-xs text-muted-foreground">
            {config.sidebarTabs.filter(t => t.visible).length} / {config.sidebarTabs.length} {t("settings.sidebarConfig.tabsVisible")}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={handleReset}
            className="gap-2"
          >
            <RotateCcw className="size-3.5" />
            {t("settings.sidebarConfig.reset")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
