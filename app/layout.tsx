import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { SettingsProvider } from "@/components/settings/settings-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AccountProvider } from "@/components/accounts/account-provider";
import { DownloadProvider } from "@/components/download/download-provider";
import { RetargetInstallListener } from "@/components/download/retarget-install-listener";
import { FlyToProcessListOverlay } from "@/components/process-list/fly-to-process-list";
import { LaunchProvider } from "@/components/launch/launch-provider";
import { DeferredGlobalFeatures } from "@/components/global/deferred-global-features";
import { StartupRuntimeDependencyNotifier } from "@/components/settings/startup-runtime-dependency-notifier";
import { UIConfigProvider } from "@/components/ui-config/ui-config-provider";
import { ThemeRuntimeProvider } from "@/components/themes/theme-runtime-provider";
import { ThemeShell } from "@/components/themes/theme-shell";
import { StartupUpdateNotifier } from "@/components/settings/startup-update-notifier";
import { StartupJavaScan } from "@/components/settings/startup-java-scan";
import { JavaIncompatibleDialog } from "@/components/launch/java-incompatible-dialog";
import { GameExitErrorDialog } from "@/components/launch/game-exit-error-dialog";
import { APPEARANCE_BOOTSTRAP_SCRIPT } from "@/lib/appearance-bootstrap-script";

export const metadata: Metadata = {
  title: "OpenXLauncher",
  description: "OpenXLauncher Desktop App",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{ __html: APPEARANCE_BOOTSTRAP_SCRIPT }}
        />
      </head>
      <body className="antialiased h-screen flex flex-col overflow-hidden bg-background">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <UIConfigProvider>
            <SettingsProvider>
              <AccountProvider>
                <LaunchProvider>
                    <DownloadProvider>
                      <RetargetInstallListener />
                      <TooltipProvider>
                        <ThemeRuntimeProvider>
                          <DeferredGlobalFeatures />
                          <StartupRuntimeDependencyNotifier />
                          <StartupUpdateNotifier />
                          <StartupJavaScan />
                          <JavaIncompatibleDialog />
                          <GameExitErrorDialog />
                          <ThemeShell>{children}</ThemeShell>
                          <FlyToProcessListOverlay />
                        </ThemeRuntimeProvider>
                      </TooltipProvider>
                    </DownloadProvider>
                </LaunchProvider>
              </AccountProvider>
            </SettingsProvider>
          </UIConfigProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
