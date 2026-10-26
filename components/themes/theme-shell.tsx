"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { PageTransition } from "@/components/page-transition";
import { Sidebar } from "@/components/sidebar";
import { TitleBar } from "@/components/title-bar";
import type { CoreRouteId } from "@/lib/themes/protocol";
import { normalizeAppPathname } from "@/lib/main-navigation-transition";
import { ThemeRoute } from "./theme-route";
import { ThemeRecoveryControl } from "./theme-recovery-control";
import { useThemeRuntime } from "./theme-runtime-provider";
import { ThemeSlot } from "./theme-slot";

function routeIdFromPathname(pathname: string): CoreRouteId | undefined {
  const path = normalizeAppPathname(pathname);
  if (path === "/") return "core.home";
  if (path === "/launch") return "core.launch";
  if (path === "/download/detail") return "core.download.detail";
  if (path === "/download") return "core.download";
  if (path === "/process-list") return "core.process-list";
  if (path === "/tools") return "core.tools";
  if (path === "/settings" || path.startsWith("/settings/")) return "core.settings";
  if (path === "/game-settings") return "core.game-settings";
  const instanceSection = path.match(
    /^\/(?:game-settings|instance-settings)\/(mods|worlds|resources|shaders|screenshots|schematics)/,
  )?.[1];
  if (instanceSection) return `core.instance.${instanceSection}` as CoreRouteId;
  return undefined;
}

export function ThemeShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { routes, slots, snapshot, reportThemeError } = useThemeRuntime();
  const owner = snapshot.activeOwner;

  useEffect(() => {
    const preventContextMenu = (event: MouseEvent) => event.preventDefault();
    document.addEventListener("contextmenu", preventContextMenu);
    return () => document.removeEventListener("contextmenu", preventContextMenu);
  }, []);

  return (
    <>
      <TitleBar />
      <ThemeRecoveryControl />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-hidden [view-transition-name:page-content]">
          <ThemeSlot registry={slots} owner={owner} slotId="page.header" onError={reportThemeError} />
          <ThemeSlot registry={slots} owner={owner} slotId="page.header.actions" onError={reportThemeError} />
          <ThemeSlot registry={slots} owner={owner} slotId="app.content.before" onError={reportThemeError} />
          <ThemeRoute
            registry={routes}
            owner={owner}
            routeId={routeIdFromPathname(pathname)}
            pathname={pathname}
            onError={reportThemeError}
          >
            <PageTransition>{children}</PageTransition>
          </ThemeRoute>
          <ThemeSlot registry={slots} owner={owner} slotId="app.content.after" onError={reportThemeError} />
          <ThemeSlot registry={slots} owner={owner} slotId="page.footer" onError={reportThemeError} />
        </main>
      </div>
    </>
  );
}
