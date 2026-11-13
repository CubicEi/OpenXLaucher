"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Boxes,
  Loader2,
  Play,
  User,
  UserPlus,
  Users,
} from "lucide-react";
import { HOME_QUICK_ACCESS_ACTIONS } from "@/constants";
import { SkinViewer3D } from "@/components/accounts/skin-viewer-3d";
import { useAccountContext } from "@/components/accounts/account-provider";
import { LaunchStatusBadge } from "@/components/launch/launch-status-badge";
import { useLaunchContext } from "@/components/launch/launch-provider";
import {
  SELECT_VERSION_PATH,
  VersionSelectorDialog,
} from "@/components/launch/version-selector-dialog";
import { PageEnter, PageEnterItem } from "@/components/layout/page-enter";
import { useSettings } from "@/components/settings/settings-provider";
import { useI18n } from "@/components/i18n/use-i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useInstancePath } from "@/hooks/use-instance-path";
import type { Account } from "@/types";
import {
  createInAppLinkHandler,
  navigateWithMainTransition,
  onInAppLinkPointerDown,
} from "@/lib/main-navigation-transition";

/** 首页：简约布局或经典仪表盘（由外观 → 主页模式决定）。 */
export default function Home() {
  const router = useRouter();
  const { selectedProfile } = useAccountContext();
  const {
    config,
    configLoaded,
    status,
    launchGame,
    cancelLaunch,
  } = useLaunchContext();
  const {
    selectedInstance,
    loading: instanceLoading,
  } = useInstancePath();
  const { settings } = useSettings();
  const { t } = useI18n();
  const homeMode = settings.appearance.homeMode;

  const isLaunchActive =
    status === "preparing" || status === "launching" || status === "running";
  const canLaunch = Boolean(
    config.minecraftPath &&
      config.javaPath &&
      config.versionName &&
      selectedProfile,
  );
  // 是否已在启动配置中选定版本；未选定时与启动设置界面保持一致，不展示任何实例
  const hasSelectedVersion = Boolean(config.versionName || config.loadName);
  const versionName = selectedInstance?.minecraft_version || config.versionName || t("launch.noVersionSelected");
  const loaderName = !hasSelectedVersion
    ? t("launch.noVersionSelected")
    : selectedInstance?.loader || (config.loadType === "0" ? "Vanilla" : t("home.modLoader"));

  // 获取显示的整合包名称
  const displayInstanceName = config.loadName || config.versionName || t("launch.noVersionSelected");

  // 获取MC版本号（优先从selectedInstance获取，如果没有则从config获取）
  const displayMcVersion = selectedInstance?.minecraft_version || versionName;
  const profileStatusMap: Record<string, string> = {
    "LittleSkin 登录": t("account.littleSkinSignIn"),
    "第三方登录": t("account.thirdPartySignIn"),
    "离线登录": t("account.offlineSignIn"),
    "正版登录": t("account.microsoftSignIn"),
  };
  const profileStatus = selectedProfile?.status
    ? profileStatusMap[selectedProfile.status] ?? selectedProfile.status
    : t("home.addAnAccountToLaunchTheGame");

  const openProfilesPage = () => {
    navigateWithMainTransition(router, "/profiles");
  };

  const handlePrimaryAction = async () => {
    if (isLaunchActive) {
      await cancelLaunch();
      return;
    }
    await launchGame();
  };

  const primaryActionLabel = isLaunchActive
    ? status === "running"
      ? t("launch.stopGame")
      : t("home.cancelLaunch")
    : t("home.launchNow");

  const simplePrimaryActionLabel = isLaunchActive
    ? primaryActionLabel
    : t("home.launchGame");

  const simpleVersionTitle = instanceLoading
    ? null
    : selectedInstance?.name || displayInstanceName;

  const openSelectVersionPage = () => {
    navigateWithMainTransition(router, SELECT_VERSION_PATH);
  };

  return (
    <div className="h-full overflow-y-auto">
      <PageEnter
        stagger
        className={`mx-auto flex min-h-full max-w-[1600px] flex-col p-4 md:p-5 ${
          homeMode === "simple" ? "gap-0" : "gap-4"
        }`}
      >
        {homeMode === "full" && (
          <PageEnterItem>
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-primary">OpenXLauncher</p>
              <h1 className="mt-1 text-xl font-semibold tracking-tight">
                {t("home.welcomeBack")}{selectedProfile?.name ?? t("home.adventurer")}
              </h1>
            </div>
            <LaunchStatusBadge status={status} className="mt-1" />
          </header>
          </PageEnterItem>
        )}

        {homeMode === "simple" ? (
          <>
            <PageEnterItem className="flex flex-col items-start text-left">
              <p className="text-xs font-medium text-primary">OpenXLauncher</p>
              <h1 className="mt-1 text-xl font-semibold tracking-tight">
                {t("home.welcomeBack")}
                {selectedProfile?.name ?? t("home.adventurer")}
              </h1>
              <h2 className="mt-4 max-w-full truncate text-4xl font-semibold tracking-tight sm:text-5xl md:text-6xl">
                {instanceLoading ? (
                  <span className="inline-flex items-center justify-start gap-2 text-3xl sm:text-4xl md:text-5xl">
                    <Loader2 className="size-6 shrink-0 animate-spin" />
                    {t("home.loadingVersion")}
                  </span>
                ) : (
                  simpleVersionTitle
                )}
              </h2>
            </PageEnterItem>

            <PageEnterItem className="mt-auto flex flex-col items-end gap-2 pt-8">
              <div className="flex w-full max-w-xs flex-col items-stretch gap-2 sm:max-w-sm">
                {isLaunchActive || canLaunch ? (
                  <Button
                    size="lg"
                    className="gap-2"
                    disabled={!configLoaded}
                    onClick={() => void handlePrimaryAction()}
                  >
                    {isLaunchActive ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Play className="size-4" />
                    )}
                    {simplePrimaryActionLabel}
                  </Button>
                ) : null}
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-9 min-h-9 flex-1"
                    onClick={openSelectVersionPage}
                  >
                    {t("home.selectInstance")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-9 min-h-9 flex-1"
                    onClick={openProfilesPage}
                  >
                    {t("home.manageAccounts")}
                  </Button>
                </div>
              </div>
            </PageEnterItem>
          </>
        ) : (
          <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_320px] items-start gap-4">
            <section className="flex min-w-0 flex-col gap-4">
              <PageEnterItem>
                <Card className="relative min-h-[280px] overflow-hidden border-primary/20 bg-gradient-to-br from-primary/12 via-card to-card shadow-sm">
                    <div className="pointer-events-none absolute -right-12 -top-16 size-52 rounded-full bg-primary/10 blur-3xl" />
                    <CardContent className="relative flex h-full min-h-[280px] flex-col p-5 sm:p-6">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="mb-3 flex flex-wrap items-center gap-2">
                            {instanceLoading ? (
                              <Badge variant="outline" className="gap-1.5">
                                <Loader2 className="size-3 animate-spin" />
                                {t("home.loadingVersion")}
                              </Badge>
                            ) : (
                              <Badge variant="outline">
                                {selectedInstance
                                  ? t("home.currentInstance")
                                  : hasSelectedVersion
                                    ? t("home.noInstanceSelected")
                                    : t("launch.noVersionSelected")}
                              </Badge>
                            )}
                            <Badge variant="outline" className="text-muted-foreground">
                              {loaderName}
                            </Badge>
                          </div>
                          <h2 className="truncate text-2xl font-semibold tracking-tight">
                            {selectedInstance?.name || displayInstanceName}
                          </h2>
                          <p className="mt-2 text-sm text-muted-foreground">
                            {selectedInstance ? (
                              <>
                                Minecraft {selectedInstance.minecraft_version} · {t("home.modsCountModsInstalled", { modsCount: selectedInstance.mods_count })}
                              </>
                            ) : (
                              <>
                                Minecraft {displayMcVersion}
                              </>
                            )}
                          </p>
                        </div>
                        <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
                          <Boxes className="size-5" />
                        </div>
                      </div>

                      <div className="mt-auto mb-8">
                        <div className="flex flex-wrap items-center gap-2">
                          {isLaunchActive || canLaunch ? (
                            <Button
                              size="lg"
                              className="gap-2"
                              disabled={!configLoaded}
                              onClick={() => void handlePrimaryAction()}
                            >
                              {isLaunchActive ? (
                                <Loader2 className="size-4 animate-spin" />
                              ) : (
                                <Play className="size-4" />
                              )}
                              {primaryActionLabel}
                            </Button>
                          ) : null}
                          <div className="order-3 w-full sm:order-none sm:min-w-0 sm:w-auto sm:flex-1">
                            <VersionSelectorDialog compact />
                          </div>
                          <Button variant="outline" size="lg" asChild>
                            <Link href="/launch" className="gap-2">
                              {t("home.viewLaunchDetails")}
                              <ArrowRight className="size-4" />
                            </Link>
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                </Card>
              </PageEnterItem>

              <PageEnterItem>
              <Card size="sm" className="shadow-sm">
                <CardHeader className="pb-1">
                  <CardTitle>{t("home.quickAccess")}</CardTitle>
                  <CardDescription>{t("home.accessCommonFeaturesWithoutNavigatingMultipleMenus")}</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(min(200px,100%),1fr))]">
                    {HOME_QUICK_ACCESS_ACTIONS.map(({ href, titleKey, descriptionKey, icon: Icon, iconClassName }) => (
                      <Link
                        key={href}
                        href={href}
                        onPointerDown={onInAppLinkPointerDown}
                        onClick={createInAppLinkHandler(router, href)}
                        className="group flex min-w-0 items-center gap-3 rounded-xl border border-transparent p-3 transition-colors hover:border-border hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${iconClassName}`}>
                          <Icon className="size-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium">{t(titleKey)}</span>
                          <span className="block truncate text-xs text-muted-foreground">{t(descriptionKey)}</span>
                        </span>
                        <ArrowRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                      </Link>
                    ))}
                  </div>
                </CardContent>
              </Card>
              </PageEnterItem>
            </section>

            <PageEnterItem className="sticky top-0 w-[320px] shrink-0">
              <Card className="overflow-hidden border shadow-sm">
                <CardHeader className="pb-2">
                  <CardTitle>{t("home.accountsAndCharacters")}</CardTitle>
                  <CardDescription>{t("home.chooseAPlayerAndManageSkinsAndCapes")}</CardDescription>
                </CardHeader>
                <CardContent className="flex min-h-[270px] items-center justify-center pt-0">
                  <SkinPreviewLarge profile={selectedProfile} />
                </CardContent>

                <div className="border-t border-border">
                  <CardContent className="py-4">
                    <HomeAccountSummary
                      selectedProfile={selectedProfile}
                      profileStatus={profileStatus}
                      onManageProfiles={openProfilesPage}
                    />
                  </CardContent>
                </div>
              </Card>
            </PageEnterItem>
          </div>
        )}
      </PageEnter>
    </div>
  );
}

function HomeAccountSummary({
  selectedProfile,
  profileStatus,
  onManageProfiles,
}: {
  selectedProfile: Account | null;
  profileStatus: string;
  onManageProfiles: () => void;
}) {
  const { t } = useI18n();

  return (
    <div className="flex items-center gap-3">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-base font-semibold text-muted-foreground">
        {selectedProfile ? (
          selectedProfile.name.charAt(0).toUpperCase()
        ) : (
          <User className="size-5" />
        )}
      </div>
      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate text-sm font-medium leading-snug">
          {selectedProfile?.name ?? t("home.notSignedIn")}
        </p>
        <p className="truncate text-xs leading-snug text-muted-foreground">
          {profileStatus}
        </p>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            onClick={onManageProfiles}
            aria-label={t("home.manageAccounts")}
          >
            <Users className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{t("home.manageAccounts")}</TooltipContent>
      </Tooltip>
    </div>
  );
}

function SkinPreviewLarge({ profile }: { profile: Account | null }) {
  const { t } = useI18n();
  const hasSkin = Boolean(profile?.skinUrl);
  const displayName = profile?.name ?? t("home.notSignedIn");

  return (
    <div className="flex w-full flex-col items-center justify-center gap-3">
      {hasSkin ? (
        <div className="overflow-hidden rounded-2xl bg-muted/40">
          <SkinViewer3D
            key={`skin-${profile?.id}-${profile?.skinUrl?.slice(-12)}-${profile?.variant ?? "classic"}`}
            skinSrc={profile!.skinUrl!}
            modelType={profile!.variant === "slim" ? "slim" : "classic"}
            width={250}
            height={290}
          />
        </div>
      ) : profile ? (
        <div className="flex flex-col items-center gap-3 text-center">
          <div key={`avatar-${profile?.id}`} className="flex size-24 items-center justify-center rounded-3xl bg-muted text-3xl font-semibold text-muted-foreground shadow-sm">
            {displayName.charAt(0).toUpperCase()}
          </div>
          <p className="text-xs text-muted-foreground">{t("home.thisAccountHasNoPreviewableSkin")}</p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 text-center text-muted-foreground">
          <div key="no-profile-avatar" className="flex size-24 items-center justify-center rounded-3xl bg-muted shadow-sm">
            <UserPlus className="size-10" />
          </div>
          <p className="text-sm">{t("home.signInToPreviewA3DSkin")}</p>
        </div>
      )}
    </div>
  );
}