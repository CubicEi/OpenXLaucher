"use client";

import { Rocket } from "lucide-react";
import { LaunchConfigCard } from "@/components/launch/launch-config-card";
import { LaunchPanel } from "@/components/launch/launch-panel";
import { LaunchConsole } from "@/components/launch/launch-console";
import { PageEnter, PageEnterItem } from "@/components/layout/page-enter";
import { useI18n } from "@/components/i18n/use-i18n";

export default function LaunchPage() {
  const { t } = useI18n();
  return (
    <div className="h-full overflow-y-auto p-4">
      <PageEnter stagger className="flex flex-col gap-4 min-h-0">
        <PageEnterItem className="flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10">
              <Rocket className="size-5 text-primary" />
            </div>
            <div>
              <h1 className="text-lg font-semibold leading-none">{t("launch.title")}</h1>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("launch.chooseAVersionConfigureLaunchSettingsAndBeginYour")}
              </p>
            </div>
          </div>
        </PageEnterItem>

        <PageEnterItem className="flex flex-col lg:flex-row gap-4 lg:items-stretch min-h-0">
          <div className="w-full lg:w-1/2 xl:w-3/5 flex flex-col gap-4 min-h-0">
            <LaunchConfigCard />
          </div>
          <div className="w-full lg:w-1/2 xl:w-2/5 flex flex-col gap-4 min-h-0">
            <LaunchPanel />
            <LaunchConsole />
          </div>
        </PageEnterItem>
      </PageEnter>
    </div>
  );
}
