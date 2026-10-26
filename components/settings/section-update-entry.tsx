"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Package } from "lucide-react";
import {
  createInAppLinkHandler,
  onInAppLinkPointerDown,
  toAppHref,
} from "@/lib/main-navigation-transition";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/i18n/use-i18n";

const COPY = {
  title: "settings.about.updates",
  description: "settings.general.updateDescription",
  version: "settings.about.version",
  manage: "settings.general.manageUpdates",
} as const;

const CHECK_UPDATE_HREF = "/check-update";

export function UpdateEntrySection() {
  const { t } = useI18n();
  const router = useRouter();
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        const v = await getVersion();
        const m = /^(\d+)\.(\d+)\.\d+-beta$/i.exec(v.trim());
        setVersion(m ? `beta ${m[1]}.${m[2]}` : v);
      } catch {
        setVersion("dev");
      }
    })();
  }, []);

  return (
    <Card className="scroll-mt-4">
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2 text-base">
          <Package className="size-4 text-primary" />
          {t(COPY.title)}
        </CardTitle>
        <CardDescription className="mt-1 text-xs">{t(COPY.description)}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
          <p className="text-sm text-muted-foreground">
            {t(COPY.version)}{" "}
            <span className="font-mono text-foreground">{version ?? "—"}</span>
          </p>
          <Button size="sm" variant="outline" className="h-8" asChild>
            <Link
              href={toAppHref(CHECK_UPDATE_HREF)}
              onPointerDown={onInAppLinkPointerDown}
              onClick={createInAppLinkHandler(router, CHECK_UPDATE_HREF)}
            >
              {t(COPY.manage)}
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
