"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useAccountContext } from "@/components/accounts/account-provider";
import { SkinCapeManager } from "@/components/accounts/skin-cape-manager";
import { SkinFaceAvatar } from "@/components/accounts/skin-face-avatar";
import { SkinViewer3D } from "@/components/accounts/skin-viewer-3d";
import { PageEnter, PageEnterItem } from "@/components/layout/page-enter";
import {
  Check,
  Plus,
  Trash2,
  RefreshCw,
  ArrowLeft,
  UserPlus,
  User,
  Shirt,
} from "lucide-react";
import { cn, getAvatarColor, getAvatarInitials } from "@/lib/utils";
import { overlayFade, scaleIn } from "@/lib/motion";
import type { Account } from "@/types";
import {
  fetchTextureImageBase64,
  msGetSkinsAndCapes,
  redownloadLittleSkinSkin,
  redownloadYggdrasilSkin,
  getSkinBase64,
} from "@/lib/auth";
import { useI18n } from "@/components/i18n/use-i18n";
import { useRouter } from "next/navigation";
import { navigateWithMainTransition } from "@/lib/main-navigation-transition";

function normalizeTextureUrl(url?: string | null): string | null {
  if (!url) return null;
  if (url.startsWith("http://")) return `https://${url.slice(7)}`;
  return url;
}

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setSize({
        width: Math.max(0, Math.floor(rect.width)),
        height: Math.max(0, Math.floor(rect.height)),
      });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { ref, size };
}

/** 官方 creeper.png 面部 UV 提取后重着色为 #EF323D（透明底） */
const CREEPER_FACE_RED_SRC =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAABRUlEQVR4nO3cwQ2DMBAAQROlAVrJP9Xnn1YogRQBkmPtTAEIS6v74GMMAAAAAAAAAAAAAAAAAAAA4N9tVx9wvN7nmGj/fi6foXz+x32vwooEECeAOAHECSBOAHECiBNAnADiBBAngDgBxAkgTgBxAogTQJwA4gQQJ4A4AcQJIE4AcQKIE0CcAOIEECeAOAHECSBOAHECiJu6W3+H1ffzZzMB4gQQJ4A4AcQJIE4AcQKIE0CcAOIEECeAOAHECSBOAHECiNvq3/Nnm32fwASIE0CcAOIEECeAOAHECSBOAHECiBNAnADiBBAngDgBxAkgTgBxAogTQJwA4gQQJ4A4AcQJIE4AcQKIE0CcAOIEECeAOAHECSDuORY3e7/+WPz/BiZAnADiBBAngDgBxAkgTgBxAogTQJwA4gQQJ4A4AcQJIE4AcT+llhTALQQ0kwAAAABJRU5ErkJggg==";

function canManageSkinsAndCapes(profile: Account): boolean {
  return profile.authType === "microsoft" && Boolean(profile.accessToken);
}

function canRedownloadSkin(profile: Account): boolean {
  if (!profile.uuid) return false;
  if (profile.authType === "littleskin") return true;
  if (profile.authType === "third_party") {
    return Boolean(profile.yggdrasilUrl?.trim());
  }
  return false;
}

/** 选中态底色 / 勾选色（按登录类型，低透明度以保证易读） */
function selectedAuthTone(authType: Account["authType"]): {
  bg: string;
  check: string;
} {
  switch (authType) {
    case "microsoft":
      return { bg: "bg-[#EF323D]/20", check: "text-[#EF323D]" };
    case "littleskin":
      return { bg: "bg-amber-400/25", check: "text-amber-600 dark:text-amber-400" };
    case "third_party":
      return { bg: "bg-emerald-500/20", check: "text-emerald-600 dark:text-emerald-400" };
    case "offline":
      return { bg: "bg-sky-500/20", check: "text-sky-600 dark:text-sky-400" };
    default:
      return { bg: "bg-accent", check: "text-primary" };
  }
}

function ProfileDetailPanel({ profile }: { profile: Account }) {
  const { t } = useI18n();
  const { updateProfile } = useAccountContext();
  const [capeSrc, setCapeSrc] = useState<string | null>(null);
  const [capeEpoch, setCapeEpoch] = useState(0);
  const [skinManagerOpen, setSkinManagerOpen] = useState(false);
  const [refreshingSkin, setRefreshingSkin] = useState(false);
  const preview = useElementSize<HTMLDivElement>();

  useEffect(() => {
    let cancelled = false;
    setCapeSrc(null);

    async function loadCape() {
      if (profile.authType !== "microsoft" || !profile.accessToken) return;
      try {
        const data = await msGetSkinsAndCapes(profile.accessToken);
        const active = data.capes?.find((c) => c.state === "ACTIVE");
        const url = normalizeTextureUrl(active?.url);
        if (!url || cancelled) return;
        try {
          const b64 = await fetchTextureImageBase64(url);
          if (!cancelled) setCapeSrc(b64);
        } catch {
          if (!cancelled) setCapeSrc(url);
        }
      } catch {
        /* no cape */
      }
    }

    void loadCape();
    return () => {
      cancelled = true;
    };
  }, [profile.id, profile.authType, profile.accessToken, capeEpoch]);

  const hasSkin = Boolean(profile.skinUrl);
  const modelType = profile.variant === "slim" ? "slim" : "classic";
  const showSkinCapeButton = canManageSkinsAndCapes(profile);
  const showSkinRefreshButton = canRedownloadSkin(profile);

  const handleRefreshSkin = () => {
    if (!profile.uuid || refreshingSkin) return;
    const pid = profile.id;
    const puuid = profile.uuid;
    setRefreshingSkin(true);
    void (async () => {
      try {
        if (profile.authType === "littleskin") {
          await redownloadLittleSkinSkin(puuid);
        } else if (profile.authType === "third_party" && profile.yggdrasilUrl) {
          await redownloadYggdrasilSkin(puuid, profile.yggdrasilUrl);
        } else {
          return;
        }
        const skinSrc = await getSkinBase64(puuid);
        updateProfile(pid, { skinUrl: skinSrc });
      } catch (err) {
        console.warn("刷新皮肤失败:", err);
      } finally {
        setRefreshingSkin(false);
      }
    })();
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      <div className="flex shrink-0 items-center gap-4">
        <div className="shrink-0 overflow-hidden rounded-2xl shadow-[0_8px_20px_-6px_rgba(80,60,120,0.35)]">
          {hasSkin ? (
            <SkinFaceAvatar
              key={`face-${profile.id}-${profile.skinUrl?.slice(-12)}`}
              skinSrc={profile.skinUrl!}
              size={96}
            />
          ) : (
            <div className="flex size-[96px] items-center justify-center bg-muted text-2xl font-semibold text-muted-foreground">
              {profile.name.charAt(0).toUpperCase()}
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="truncate text-lg font-semibold leading-tight">{profile.name}</p>
          <div className="space-y-0.5">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
              UUID
            </p>
            <p className="break-all font-mono text-xs text-muted-foreground">
              {profile.uuid || t("common.notSet")}
            </p>
          </div>
          <p className="text-xs text-muted-foreground">{profile.status}</p>
        </div>
      </div>

      <div
        ref={preview.ref}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
      >
        {(showSkinCapeButton || showSkinRefreshButton) && (
          <div className="absolute right-1 top-1 z-10 flex flex-col gap-1.5">
            {showSkinCapeButton && (
              <Button
                type="button"
                variant="secondary"
                size="icon-sm"
                className="touch-manipulation shadow-sm"
                title={t("home.skinsAndCapes")}
                aria-label={t("home.skinsAndCapes")}
                onClick={() => setSkinManagerOpen(true)}
              >
                <Shirt className="size-3.5" />
              </Button>
            )}
            {showSkinRefreshButton && (
              <Button
                type="button"
                variant="secondary"
                size="icon-sm"
                disabled={refreshingSkin}
                className="touch-manipulation shadow-sm"
                title={t("common.refresh")}
                aria-label={t("common.refresh")}
                onClick={handleRefreshSkin}
              >
                <RefreshCw
                  className={cn("size-3.5", refreshingSkin && "animate-spin")}
                />
              </Button>
            )}
          </div>
        )}
        {hasSkin && preview.size.width > 40 && preview.size.height > 40 ? (
          <SkinViewer3D
            key={`body-${profile.id}-${profile.skinUrl?.slice(-12)}-${capeSrc?.slice(-12) ?? "none"}-${capeEpoch}`}
            skinSrc={profile.skinUrl!}
            capeSrc={capeSrc ?? undefined}
            modelType={modelType}
            autoRotate
            frameless
            width={Math.min(preview.size.width, Math.round(preview.size.height * 0.72))}
            height={preview.size.height}
          />
        ) : hasSkin ? null : (
          <div className="flex flex-col items-center gap-2 px-6 text-center text-muted-foreground">
            <User className="size-10 opacity-50" />
            <p className="text-sm">{t("home.thisAccountHasNoPreviewableSkin")}</p>
          </div>
        )}
      </div>

      {skinManagerOpen && (
        <SkinCapeManager
          account={profile}
          onClose={() => {
            setSkinManagerOpen(false);
            setCapeEpoch((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}

/** 档案管理页主体 */
export function ProfileManager() {
  const router = useRouter();
  const { t } = useI18n();
  const {
    profiles,
    selectedProfile,
    selectProfile,
    removeProfile,
    setManualLoginOpen,
  } = useAccountContext();
  const [deleteTarget, setDeleteTarget] = useState<Account | null>(null);

  return (
    <>
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <PageEnter
          stagger
          className="mx-auto flex h-full min-h-0 w-full max-w-[1600px] flex-col gap-4 p-4 md:p-5"
        >
          <PageEnterItem className="flex shrink-0 items-center gap-3">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0 touch-manipulation"
              onClick={() => navigateWithMainTransition(router, "/")}
              aria-label={t("common.back")}
            >
              <ArrowLeft className="size-4" />
            </Button>
            <div className="min-w-0 flex-1">
              <h1 className="text-lg font-semibold leading-none">
                {t("profiles.title")}
              </h1>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {t("profiles.description")}
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              className="shrink-0 gap-1.5"
              onClick={() => setManualLoginOpen(true)}
            >
              <Plus className="size-3.5" />
              {t("profiles.add")}
            </Button>
          </PageEnterItem>

          <PageEnterItem className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row md:items-stretch">
            <Card className="flex min-h-0 w-full flex-col overflow-hidden shadow-sm md:w-[40%] md:shrink-0">
              <CardContent className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2 sm:p-3">
                {profiles.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-3 py-12 text-center text-muted-foreground">
                    <div className="flex size-14 items-center justify-center rounded-2xl bg-muted">
                      <UserPlus className="size-7" />
                    </div>
                    <p className="text-sm">{t("profiles.empty")}</p>
                    <Button
                      type="button"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => setManualLoginOpen(true)}
                    >
                      <Plus className="size-3.5" />
                      {t("profiles.add")}
                    </Button>
                  </div>
                ) : (
                  profiles.map((profile) => {
                    const isSelected = selectedProfile?.id === profile.id;
                    const isMicrosoftSelected =
                      isSelected && profile.authType === "microsoft";
                    const tone = isSelected
                      ? selectedAuthTone(profile.authType)
                      : null;

                    return (
                    <div
                      key={profile.id}
                      className={cn(
                        "group relative flex w-full items-center gap-3 overflow-hidden rounded-xl p-3 transition-colors",
                        tone ? tone.bg : "hover:bg-accent",
                      )}
                    >
                      {isMicrosoftSelected && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={CREEPER_FACE_RED_SRC}
                          alt=""
                          aria-hidden
                          className="pointer-events-none absolute bottom-1.5 right-1.5 size-10 select-none opacity-50 [image-rendering:pixelated]"
                          draggable={false}
                        />
                      )}
                      <button
                        type="button"
                        className="relative z-[1] flex min-w-0 flex-1 items-center gap-3 text-left"
                        onClick={() => selectProfile(profile)}
                      >
                        <Avatar>
                          <AvatarFallback
                            className={cn(
                              getAvatarColor(profile.name),
                              "text-white font-medium",
                            )}
                          >
                            {getAvatarInitials(profile.name)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{profile.name}</p>
                          <p className="text-xs text-muted-foreground">{profile.status}</p>
                        </div>
                        {isSelected && tone && (
                          <Check className={cn("size-4 shrink-0", tone.check)} />
                        )}
                      </button>

                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="relative z-[1] opacity-0 transition-opacity touch-manipulation group-hover:opacity-100"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteTarget(profile);
                        }}
                        title={t("profiles.delete")}
                      >
                        <Trash2 className="size-3.5 text-muted-foreground" />
                      </Button>
                    </div>
                    );
                  })
                )}
              </CardContent>
            </Card>

            <Card className="flex min-h-[18rem] min-w-0 flex-1 flex-col overflow-hidden shadow-sm md:min-h-0">
              {selectedProfile ? (
                <ProfileDetailPanel
                  key={selectedProfile.id}
                  profile={selectedProfile}
                />
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
                  <div className="flex size-14 items-center justify-center rounded-2xl bg-muted">
                    <User className="size-7" />
                  </div>
                  <p className="text-sm">{t("profiles.selectHint")}</p>
                </div>
              )}
            </Card>
          </PageEnterItem>
        </PageEnter>
      </div>

      <AnimatePresence>
        {deleteTarget && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center">
            <motion.div
              variants={overlayFade}
              initial="initial"
              animate="animate"
              exit="exit"
              className="absolute inset-0 bg-black/50 backdrop-blur-sm"
              onClick={() => setDeleteTarget(null)}
            />
            <motion.div
              variants={scaleIn}
              initial="initial"
              animate="animate"
              exit="exit"
              className="relative z-10 mx-4 w-full max-w-xs"
            >
              <Card className="shadow-2xl">
                <CardHeader>
                  <CardTitle className="text-base">{t("profiles.deleteTitle")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <p className="text-sm text-muted-foreground">
                    {t("profiles.deleteConfirm", { name: deleteTarget.name })}
                  </p>
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDeleteTarget(null)}
                    >
                      {t("common.cancel")}
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => {
                        removeProfile(deleteTarget.id);
                        setDeleteTarget(null);
                      }}
                    >
                      {t("profiles.delete")}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

    </>
  );
}
