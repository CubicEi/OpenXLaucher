"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/components/i18n/use-i18n";
import { useLaunchContext } from "./launch-provider";
import {
  SELECT_VERSION_PATH,
} from "@/components/launch/version-selector-panel";
import { navigateWithMainTransition } from "@/lib/main-navigation-transition";

interface VersionSelectorDialogProps {
  /** @deprecated Dialog open state is unused; navigation replaces the dialog. */
  open?: boolean;
  /** @deprecated Dialog open state is unused; navigation replaces the dialog. */
  onOpenChange?: (open: boolean) => void;
  compact?: boolean;
  className?: string;
}

/**
 * Trigger that navigates to the dedicated game-version selection page.
 * Kept name for existing call sites.
 */
export function VersionSelectorDialog({
  compact,
  className,
}: VersionSelectorDialogProps = {}) {
  const { t } = useI18n();
  const router = useRouter();
  const { config } = useLaunchContext();

  const openSelector = () => {
    navigateWithMainTransition(router, SELECT_VERSION_PATH);
  };

  return (
    <Button
      type="button"
      variant="outline"
      className={cn(
        "w-full justify-between text-xs",
        compact ? "h-7 px-2" : "h-8",
        className,
      )}
      onClick={openSelector}
    >
      <span className="truncate">
        {config.versionName || t("launch.versionSelector.selectAGameVersion")}
      </span>
      <ChevronDown className="ml-2 size-3 shrink-0" />
    </Button>
  );
}

export { SELECT_VERSION_PATH };
