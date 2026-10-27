"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { useI18n, type Translation } from "@/components/i18n/use-i18n";
import {
  GAME_SETTINGS_CORE_HREF,
  GAME_SETTINGS_FEATURE_NAV,
} from "./feature-nav";
import { SharedSectionRouteTransition } from "@/components/layout/shared-section-route-transition";
import {
  createInAppLinkHandler,
  normalizeAppPathname,
  onInAppLinkPointerDown,
  toAppHref,
} from "@/lib/main-navigation-transition";

const NAV_ITEMS: { href: string; label: Translation }[] = [
  { href: GAME_SETTINGS_CORE_HREF, label: "gameSettings.coreSettings" },
  ...GAME_SETTINGS_FEATURE_NAV.map((item) => ({
    href: item.href,
    label: item.label,
  })),
];

export default function GameSettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const currentPath = normalizeAppPathname(pathname);
  const { t } = useI18n();

  useEffect(() => {
    for (const item of NAV_ITEMS) {
      router.prefetch(toAppHref(item.href));
    }
  }, [router]);

  return (
    <div className="h-full flex flex-col">
      {/* 顶部导航栏 */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b bg-background/80 backdrop-blur-sm">
        {/* 子页面 Tab 导航 */}
        <div className="flex gap-0.5 overflow-x-auto">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={toAppHref(item.href)}
              onPointerDown={onInAppLinkPointerDown}
              onClick={createInAppLinkHandler(router, item.href, {
                skipIfSamePath: true,
              })}
              suppressHydrationWarning
              className={cn(
                "px-3 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap",
                currentPath === normalizeAppPathname(item.href)
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
              )}
            >
              {t(item.label)}
            </Link>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        <SharedSectionRouteTransition debugSegment="game-settings" className="h-full w-full">
          {children}
        </SharedSectionRouteTransition>
      </div>
    </div>
  );
}
