"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { invoke } from "@tauri-apps/api/core";
import {
  CheckCircle2,
  Loader2,
  PackageOpen,
  RefreshCw,
  UserPlus,
} from "lucide-react";

import { useAccountContext } from "@/components/accounts/account-provider";
import { useDownloadManager } from "@/components/download/download-provider";
import { useI18n } from "@/components/i18n/use-i18n";
import { useLaunchContext } from "@/components/launch/launch-provider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { shouldHideVersionDuringInstall } from "@/lib/installing-version-filter";
import { navigateWithMainTransition } from "@/lib/main-navigation-transition";
import {
  clearOnboardingResume,
  getOnboardingResume,
  isOnboardingComplete,
  markOnboardingComplete,
  setOnboardingResume,
} from "@/lib/onboarding";
import {
  parsedVersionFromInstance,
  versionToLaunchConfig,
  type ParsedVersion,
} from "@/lib/parsed-version";
import { readMigratedLocalStorage } from "@/lib/storage-migrate";
import { cn } from "@/lib/utils";
import type { InstanceData } from "@/types";

type Step = "welcome" | "account" | "instance";

const ACCOUNT_STORAGE_KEY = "openx_accounts";
const ACCOUNT_LEGACY_KEYS = ["rtl_accounts"] as const;

function hasStoredAccounts(): boolean {
  try {
    const raw = readMigratedLocalStorage(ACCOUNT_STORAGE_KEY, ACCOUNT_LEGACY_KEYS);
    if (!raw) return false;
    const list = JSON.parse(raw) as unknown[];
    return Array.isArray(list) && list.length > 0;
  } catch {
    return false;
  }
}

export function StartupOnboarding() {
  const { t } = useI18n();
  const router = useRouter();
  const {
    selectedProfile,
    profiles,
    setManualLoginOpen,
    manualLoginOpen,
  } = useAccountContext();
  const { config, configLoaded, updateConfig } = useLaunchContext();
  const { tasks } = useDownloadManager();

  const [bootstrapped, setBootstrapped] = useState(false);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("welcome");
  const [bannerVisible, setBannerVisible] = useState(false);

  const [versions, setVersions] = useState<ParsedVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);

  const finish = useCallback(() => {
    markOnboardingComplete();
    clearOnboardingResume();
    setOpen(false);
    setBannerVisible(false);
  }, []);

  // 首次挂载：决定是否展示 / 自动完成 / 从下载恢复
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isOnboardingComplete()) {
      setBootstrapped(true);
      return;
    }
    if (hasStoredAccounts()) {
      // 已有账户（含旧版迁来）：不打扰，直接标记完成
      markOnboardingComplete();
      setBootstrapped(true);
      return;
    }
    const resume = getOnboardingResume();
    if (resume === "instance") {
      setStep("instance");
      setBannerVisible(true);
      setBootstrapped(true);
      return;
    }
    setStep("welcome");
    setOpen(true);
    setBootstrapped(true);
  }, []);

  // 账户登录成功 → 进入实例步
  useEffect(() => {
    if (!bootstrapped || isOnboardingComplete()) return;
    if (!selectedProfile && profiles.length === 0) return;
    if (step === "welcome" || step === "account") {
      setStep("instance");
      if (!open && !bannerVisible) {
        setOpen(true);
      }
    }
  }, [bootstrapped, selectedProfile, profiles.length, step, open, bannerVisible]);

  // 用户在其它页面自行选好版本后，自动结束开箱
  useEffect(() => {
    if (!bootstrapped || isOnboardingComplete()) return;
    if (!(selectedProfile || profiles.length > 0)) return;
    if (!config.versionName) return;
    finish();
  }, [bootstrapped, selectedProfile, profiles.length, config.versionName, finish]);

  // 若在实例步且已有 versionName，仍展示「完成」即可（不自动强制关闭，让用户点完成或跳过）
  const loadVersions = useCallback(async () => {
    if (!config.minecraftPath) {
      setVersions([]);
      return;
    }
    try {
      setVersionsLoading(true);
      const versionsPath = `${config.minecraftPath}/versions`;
      const instances = await invoke<InstanceData[]>("vm_scan_instances", {
        instancesPath: versionsPath,
      });
      setVersions(instances.map(parsedVersionFromInstance));
    } catch (error) {
      console.error("[onboarding] Failed to load versions:", error);
      setVersions([]);
    } finally {
      setVersionsLoading(false);
    }
  }, [config.minecraftPath]);

  useEffect(() => {
    if (!open || step !== "instance") return;
    if (!configLoaded) return;
    void loadVersions();
  }, [open, step, configLoaded, loadVersions, tasks]);

  const handleSelectVersion = (version: ParsedVersion) => {
    updateConfig(versionToLaunchConfig(version));
    finish();
  };

  const handleGoDownload = () => {
    setOnboardingResume("instance");
    setOpen(false);
    setBannerVisible(true);
    navigateWithMainTransition(router, "/download");
  };

  const handleSkipRemaining = () => {
    finish();
  };

  const visibleVersions = versions.filter(
    (v) => !shouldHideVersionDuringInstall(v.name, tasks),
  );

  const stepIndex = step === "welcome" ? 1 : step === "account" ? 2 : 3;
  // 登录窗打开时隐藏向导，避免挡住 LoginDialog（同为 z-50）
  const dialogOpen = open && !manualLoginOpen;

  if (!bootstrapped) return null;

  return (
    <>
      {bannerVisible && !open && !isOnboardingComplete() && (
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
          <div className="pointer-events-auto flex max-w-lg items-center gap-3 rounded-xl border border-border bg-background/95 px-4 py-3 shadow-lg backdrop-blur">
            <p className="min-w-0 flex-1 text-sm text-muted-foreground">
              {t("onboarding.resumeBanner")}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setStep("instance");
                setOpen(true);
                setBannerVisible(false);
              }}
            >
              {t("onboarding.resumeContinue")}
            </Button>
            <Button size="sm" variant="ghost" onClick={handleSkipRemaining}>
              {t("onboarding.resumeSkip")}
            </Button>
          </div>
        </div>
      )}

      <Dialog
        open={dialogOpen}
        onOpenChange={(next) => {
          // 欢迎 / 账户步不可整段关闭；实例步可用「跳过」结束
          if (!next) {
            if (step === "instance" && (selectedProfile || profiles.length > 0)) {
              return;
            }
            return;
          }
          setOpen(next);
        }}
      >
        <DialogContent
          className="max-w-lg [&>button]:hidden"
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <DialogHeader className="flex-col items-start gap-1">
            <DialogTitle>{t("onboarding.title")}</DialogTitle>
            <p className="text-xs text-muted-foreground">
              {t("onboarding.stepOf", {
                current: String(stepIndex),
                total: "3",
              })}
            </p>
          </DialogHeader>

          <div className="space-y-4 px-5 pb-5">
            <div className="flex gap-2">
              {(["welcome", "account", "instance"] as const).map((s, i) => {
                const active = step === s;
                const done =
                  (s === "welcome" && step !== "welcome") ||
                  (s === "account" && step === "instance");
                return (
                  <div
                    key={s}
                    className={cn(
                      "h-1.5 flex-1 rounded-full transition-colors",
                      active || done ? "bg-primary" : "bg-muted",
                    )}
                    title={
                      i === 0
                        ? t("onboarding.stepWelcome")
                        : i === 1
                          ? t("onboarding.stepAccount")
                          : t("onboarding.stepInstance")
                    }
                  />
                );
              })}
            </div>

            {step === "welcome" && (
              <div className="space-y-4">
                <div>
                  <h3 className="text-base font-semibold">
                    {t("home.announcement.welcomeToOpenXLauncher")}
                  </h3>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {t(
                      "home.announcement.aModernMinecraftLauncherWithAPolishedSmoothExperience",
                    )}
                  </p>
                </div>
                <Button className="w-full" onClick={() => setStep("account")}>
                  {t("onboarding.startSetup")}
                </Button>
              </div>
            )}

            {step === "account" && (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  {t("onboarding.addAccountHint")}
                </p>
                {selectedProfile || profiles.length > 0 ? (
                  <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
                    <CheckCircle2 className="size-4 shrink-0 text-green-500" />
                    <span className="truncate">
                      {t("onboarding.accountReady", {
                        name: selectedProfile?.name ?? profiles[0]?.name ?? "",
                      })}
                    </span>
                  </div>
                ) : manualLoginOpen ? (
                  <p className="text-sm text-muted-foreground">
                    {t("onboarding.waitingForLogin")}
                  </p>
                ) : null}
                <div className="flex flex-col gap-2">
                  <Button
                    className="w-full gap-2"
                    onClick={() => setManualLoginOpen(true)}
                    disabled={Boolean(selectedProfile) || profiles.length > 0}
                  >
                    <UserPlus className="size-4" />
                    {t("onboarding.addAccount")}
                  </Button>
                  {(selectedProfile || profiles.length > 0) && (
                    <>
                      <Button
                        className="w-full"
                        variant="default"
                        onClick={() => setStep("instance")}
                      >
                        {t("onboarding.continueToInstance")}
                      </Button>
                      <Button
                        className="w-full"
                        variant="ghost"
                        onClick={handleSkipRemaining}
                      >
                        {t("onboarding.skipRemaining")}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            )}

            {step === "instance" && (
              <div className="space-y-4">
                <div>
                  <h3 className="text-base font-semibold">
                    {t("onboarding.instanceTitle")}
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t("onboarding.instanceHint")}
                  </p>
                </div>

                {config.versionName ? (
                  <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
                    <CheckCircle2 className="size-4 shrink-0 text-green-500" />
                    <span className="truncate">
                      {t("onboarding.versionAlreadySelected", {
                        name: config.versionName,
                      })}
                    </span>
                  </div>
                ) : null}

                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => void loadVersions()}
                    disabled={versionsLoading}
                  >
                    {versionsLoading ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="size-3.5" />
                    )}
                    {t("onboarding.refreshVersions")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={handleGoDownload}
                  >
                    <PackageOpen className="size-3.5" />
                    {t("onboarding.goDownload")}
                  </Button>
                </div>

                <div className="max-h-56 space-y-1.5 overflow-y-auto rounded-lg border border-border p-2">
                  {versionsLoading && visibleVersions.length === 0 ? (
                    <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                      <Loader2 className="size-4 animate-spin" />
                      {t("common.loading")}
                    </div>
                  ) : visibleVersions.length === 0 ? (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                      {t("onboarding.noVersions")}
                    </p>
                  ) : (
                    visibleVersions.map((version) => (
                        <button
                          key={version.name}
                          type="button"
                          className={cn(
                            "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm",
                            "hover:bg-muted/80 transition-colors",
                            config.versionName === version.name && "bg-primary/10",
                          )}
                          onClick={() => handleSelectVersion(version)}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-medium">{version.name}</div>
                            <div className="truncate text-xs text-muted-foreground">
                              {version.mcVersion} · {version.loaderType}
                            </div>
                          </div>
                          <span className="shrink-0 text-xs text-primary">
                            {t("onboarding.selectVersion")}
                          </span>
                        </button>
                      ))
                  )}
                </div>

                <div className="flex flex-col gap-2">
                  {config.versionName ? (
                    <Button className="w-full" onClick={finish}>
                      {t("onboarding.finish")}
                    </Button>
                  ) : null}
                  <Button
                    className="w-full"
                    variant="ghost"
                    onClick={handleSkipRemaining}
                  >
                    {t("onboarding.skipRemaining")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
