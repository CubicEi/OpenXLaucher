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
import {
  PageEnter,
  PageEnterChrome,
  PageEnterItem,
} from "@/components/layout/page-enter";
import {
  createInAppLinkHandler,
  getPageTransitionKey,
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
      {/* Top bar + border-b fixed; tab chips L→R float once on section enter */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b bg-background/80 backdrop-blur-sm">
        <PageEnterChrome
          sectionKey={getPageTransitionKey(currentPath)}
          className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto overflow-y-hidden no-scrollbar"
        >
          {NAV_ITEMS.map((item) => (
            <PageEnterItem key={item.href} className="shrink-0">
              <Link
                href={toAppHref(item.href)}
                onPointerDown={onInAppLinkPointerDown}
                onClick={createInAppLinkHandler(router, item.href, {
                  skipIfSamePath: true,
                })}
                suppressHydrationWarning
                className={cn(
                  "px-3 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap block",
                  currentPath === normalizeAppPathname(item.href)
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
                )}
              >
                {t(item.label)}
              </Link>
            </PageEnterItem>
          ))}
        </PageEnterChrome>
      </div>
      <div data-section-content className="flex-1 min-h-0 overflow-hidden">
        <PageEnter
          enterKey={currentPath}
          stagger={false}
          fill
          className="h-full w-full"
        >
          {children}
        </PageEnter>
      </div>
    </div>
  );
}
