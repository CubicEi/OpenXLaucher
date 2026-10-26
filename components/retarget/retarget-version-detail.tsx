"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  RetargetCombinedInstall,
  type RetargetInstallControls,
} from "@/components/retarget/retarget-combined-install";
import { useI18n, type TranslationKey } from "@/components/i18n/use-i18n";
import { ArrowLeft, Loader2, Wrench } from "lucide-react";
import type { MinecraftVersion } from "@/types";
import type { RetargetContext } from "@/lib/retarget-version";

const versionTypeLabelKeys: Record<string, TranslationKey> = {
  release: "download.versionType.release",
  snapshot: "download.versionType.snapshot",
  april_fools: "download.versionType.aprilFools",
  old_version: "download.versionType.oldVersion",
};

interface RetargetVersionDetailProps {
  version: MinecraftVersion;
  onBack: () => void;
  retargetContext: RetargetContext;
}

export function RetargetVersionDetail({
  version,
  onBack,
  retargetContext,
}: RetargetVersionDetailProps) {
  const { t } = useI18n();
  const [controls, setControls] = useState<RetargetInstallControls | null>(null);
  const onControlsChange = useCallback((next: RetargetInstallControls) => {
    setControls(next);
  }, []);

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex shrink-0 items-center gap-3">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onBack}
          aria-label={t("download.backToVersionList")}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <h2 className="text-lg font-semibold leading-none">
            Minecraft {version.id}
          </h2>
          <div className="flex items-center gap-1.5">
            {version.isLatest && (
              <Badge variant="default" className="px-1.5 py-0 text-[10px]">
                {t("download.latest")}
              </Badge>
            )}
            <Badge
              variant={version.type === "release" ? "secondary" : "outline"}
              className="px-1.5 py-0 text-[10px]"
            >
              {versionTypeLabelKeys[version.type]
                ? t(versionTypeLabelKeys[version.type])
                : version.type}
            </Badge>
          </div>
        </div>
        <Button
          size="sm"
          className="shrink-0"
          disabled={!controls?.canInstall || !!controls?.installing}
          onClick={() => controls?.onInstall()}
        >
          {controls?.installing ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Wrench className="size-4" />
          )}
          {t("gameSettings.retargetStartInstall")}
        </Button>
      </div>

      <p className="shrink-0 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100">
        {t("gameSettings.retargetBanner", {
          folder: retargetContext.sourceFolderName,
          mc: retargetContext.currentMcVersion,
          loader: retargetContext.currentLoaderFamily,
        })}
      </p>

      <RetargetCombinedInstall
        version={version}
        retargetContext={retargetContext}
        onControlsChange={onControlsChange}
      />
    </div>
  );
}
