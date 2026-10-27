"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { useI18n, type TranslationKey } from "@/components/i18n/use-i18n";
import { Settings, Sparkles, Download, SlidersHorizontal } from "lucide-react";
import { SectionContentMotion } from "@/components/layout/section-content-motion";
import { useAnimRenderTrace } from "@/lib/animation-trace-hooks";
import {
  createInAppLinkHandler,
  normalizeAppPathname,
  onInAppLinkPointerDown,
  toAppHref,
} from "@/lib/main-navigation-transition";

interface NavItem {
  href: string;
  label: TranslationKey;
  icon: React.ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  {
    href: "/settings/general",
    label: "settings.page.general",
    icon: <SlidersHorizontal className="size-4" />,
  },
  {
    href: "/settings/download",
    label: "settings.page.download",
    icon: <Download className="size-4" />,
  },
  {
    href: "/settings/appearance",
    label: "settings.page.appearance",
    icon: <Sparkles className="size-4" />,
  },
];

const PAGE_COPY = {
  title: "settings.page.title",
  description: "settings.page.description",
  category: "settings.page.categories",
} as const;

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const pathname = usePathname();
  const router = useRouter();
  const currentPath = normalizeAppPathname(pathname);
  useAnimRenderTrace("SettingsLayout", { currentPath });

  useEffect(() => {
    for (const item of NAV_ITEMS) {
      router.prefetch(toAppHref(item.href));
    }
  }, [router]);

  return (
    <div className="relative h-full overflow-hidden">
      <div className="border-b border-border bg-background/60 px-5 py-3 backdrop-blur">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Settings className="size-3.5" />
          </div>
          <div>
            <h1 className="text-sm font-semibold leading-tight">{t(PAGE_COPY.title)}</h1>
            <p className="text-xs text-muted-foreground">{t(PAGE_COPY.description)}</p>
          </div>
        </div>
      </div>

      <div className="flex h-[calc(100%-54px)]">
        <nav className="hidden w-52 shrink-0 border-r border-border bg-background/30 p-3 md:block">
          <div className="sticky top-0 space-y-1">
            <div className="px-2 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {t(PAGE_COPY.category)}
            </div>
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
                  "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors",
                  currentPath === normalizeAppPathname(item.href)
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-foreground/80 hover:bg-accent/40",
                )}
              >
                {item.icon}
                <span>{t(item.label)}</span>
              </Link>
            ))}
          </div>
        </nav>

        <main className="flex h-full min-h-0 flex-1 flex-col overflow-hidden px-4 py-4 md:px-6">
          <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col overflow-y-auto">
            <SectionContentMotion segment="settings" className="space-y-4">
              {children}
            </SectionContentMotion>
          </div>
        </main>
      </div>
    </div>
  );
}
