"use client";

import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { Account, AuthType } from "@/types";
import {
  loginLittleSkin,
  loginLittleSkinWithCredentials,
  loginThirdParty,
  msRequestDeviceCode,
  msPollAndLogin,
  msCancelLogin,
  getSkinBase64,
  redownloadLittleSkinSkin,
  msSilentRefreshAccount,
  msHasAccountInDb,
  deleteCachedSkin,
  isMicrosoftTokenTransientError,
  normalizeSkinVariant,
  type LittleSkinAccount,
  type ThirdPartyAccountList,
  type DeviceCodeInfo,
} from "@/lib/auth";
import { readMigratedLocalStorage } from "@/lib/storage-migrate";
import { LoginDialog } from "@/components/accounts/login-dialog";

type LoginState = "idle" | "loading" | "error";

type AccountContextType = {
  profiles: Account[];
  selectedProfile: Account | null;
  selectProfile: (acc: Account) => void;
  removeProfile: (id: string) => void;
  /** 更新单个账户信息（例如刷新皮肤URL） */
  updateProfile: (id: string, patch: Partial<Account>) => void;
  /** LittleSkin OAuth 登录 */
  loginWithLittleSkin: () => Promise<void>;
  /** LittleSkin 账号密码登录（PCL2 风格，无需浏览器），返回玩家列表 */
  loginWithLittleSkinCredentials: (
    username: string,
    password: string
  ) => Promise<LittleSkinAccount[]>;
  /** 选择 LittleSkin 角色后添加账户 */
  addLittleSkinAccount: (account: LittleSkinAccount) => void;
  /** 第三方 Yggdrasil 登录 */
  loginWithThirdParty: (
    url: string,
    user: string,
    pwd: string
  ) => Promise<ThirdPartyAccountList>;
  /** 添加离线账户 */
  addOfflineAccount: (name: string) => void;
  /** 选择第三方角色后添加账户 */
  addThirdPartyAccount: (
    profile: { id: string; name: string },
    accessToken: string,
    yggdrasilUrl: string,
  ) => void;
  /** 微软正版登录 —— 返回 DeviceCodeInfo 后由前端展示，后台继续轮询 */
  loginWithMicrosoft: () => Promise<DeviceCodeInfo>;
  /** 取消微软正版登录（用户关闭对话框时调用） */
  cancelMicrosoftLogin: () => void;
  loginState: LoginState;
  loginError: string | null;
  /** 以正版启动游戏时触发的微软设备码登录（见 prepareMicrosoftAccountForLaunch） */
  forcedMicrosoftDeviceCode: DeviceCodeInfo | null;
  /** 启动游戏前无法取得 Minecraft 令牌时提示重新登录（可关闭，默认锁定正版 tab） */
  forcedMicrosoftLoginMode: boolean;
  /** 强制登录的原因说明（展示给玩家） */
  forcedMicrosoftLoginMessage: string | null;
  /** 清理强制微软登录的 DeviceCode 状态（登录对话框关闭时调用）*/
  clearForcedMicrosoftDeviceCode: () => void;
  /** 手动打开登录对话框（AccountSwitcher 里"添加账户"按钮点下时设为 true；关闭时设为 false） */
  manualLoginOpen: boolean;
  setManualLoginOpen: (open: boolean) => void;
  /** 正版账号启动游戏前：刷新或引导重新登录以取得 Minecraft 令牌 */
  prepareMicrosoftAccountForLaunch: (profile: Account) => Promise<MicrosoftLaunchPrepResult>;
};

const AccountContext = createContext<AccountContextType | undefined>(undefined);

const AUTH_TYPE_LABELS: Record<AuthType, string> = {
  littleskin: "LittleSkin 登录",
  third_party: "第三方登录",
  offline: "离线登录",
  microsoft: "正版登录",
};

const STORAGE_KEY_PROFILES = "openx_accounts";
const STORAGE_KEY_SELECTED = "openx_selected_account_id";
const LEGACY_STORAGE_KEY_PROFILES = ["rtl_accounts"] as const;
const LEGACY_STORAGE_KEY_SELECTED = ["rtl_selected_account_id"] as const;

function loadProfiles(): Account[] {
  try {
    const raw = readMigratedLocalStorage(STORAGE_KEY_PROFILES, LEGACY_STORAGE_KEY_PROFILES);
    if (raw) {
      const list = JSON.parse(raw) as Account[];
      return list.map((p) => ({
        ...p,
        variant: normalizeSkinVariant(p.variant) ?? p.variant,
      }));
    }
  } catch {}
  return [];
}

function loadSelectedId(): string | null {
  try {
    return readMigratedLocalStorage(STORAGE_KEY_SELECTED, LEGACY_STORAGE_KEY_SELECTED);
  } catch {}
  return null;
}

function withTimeout<T>(p: Promise<T>, ms: number, tag: string): Promise<T> {
  return Promise.race<T>([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${tag}_TIMEOUT`)), ms)),
  ]);
}

/** 以正版账号启动游戏前的令牌准备结果 */
export type MicrosoftLaunchPrepResult =
  | { ok: true; accessToken: string }
  | { ok: false; reason: "cancelled" | "network" | "credentials" };

export function AccountProvider({ children }: { children: React.ReactNode }) {
  const [profiles, setProfiles] = useState<Account[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<Account | null>(null);
  const [loginState, setLoginState] = useState<LoginState>("idle");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [forcedMicrosoftDeviceCode, setForcedMicrosoftDeviceCode] = useState<DeviceCodeInfo | null>(null);
  const [forcedMicrosoftLoginMode, setForcedMicrosoftLoginMode] = useState<boolean>(false);
  const [forcedMicrosoftLoginMessage, setForcedMicrosoftLoginMessage] = useState<string | null>(null);
  // 手动打开的登录对话框（点"添加账户"按钮时）—— 统一由 Provider 控制对话框是否显示
  const [manualLoginOpen, setManualLoginOpen] = useState<boolean>(false);
  // 微软登录的"取消标志"：每次调用 loginWithMicrosoft 时递增，
  // 如果用户在途中调用 cancelMicrosoftLogin，这个计数器会递增，
  // 使得后续的 .then/.catch 回调不更新状态（避免关闭对话框后仍显示"登录中"）
  const msLoginVersionRef = React.useRef<number>(0);
  /** 以正版启动游戏时，等待重新登录完成或用户关闭弹窗 */
  const microsoftLaunchGateRef = React.useRef<((accessToken: string | null) => void) | null>(null);

  const applyMicrosoftRefresh = useCallback(
    async (
      pid: string,
      puuid: string,
      pName: string,
      refreshed: { access_token: string; name?: string; variant?: string | null }
    ) => {
      let avatarSrc: string | undefined;
      try {
        avatarSrc = (await getSkinBase64(puuid)) || undefined;
      } catch {
        /* 皮肤非必需 */
      }
      const refreshedVariant = normalizeSkinVariant(refreshed.variant);
      setProfiles((prev) =>
        prev.map((p) =>
          p.id === pid
            ? {
                ...p,
                name: refreshed.name || pName,
                accessToken: refreshed.access_token,
                skinUrl: avatarSrc ?? p.skinUrl,
                ...(refreshedVariant ? { variant: refreshedVariant } : {}),
              }
            : p
        )
      );
      setSelectedProfile((current) =>
        current?.id === pid
          ? {
              ...current,
              name: refreshed.name || pName,
              accessToken: refreshed.access_token,
              skinUrl: avatarSrc ?? current.skinUrl,
              ...(refreshedVariant ? { variant: refreshedVariant } : {}),
            }
          : current
      );
    },
    []
  );

  const runForcedMicrosoftRelogin = useCallback(
    (pName: string, tokenErrorMsg: string): Promise<string | null> => {
      return new Promise((resolve) => {
        const finish = (accessToken: string | null) => {
          if (microsoftLaunchGateRef.current) {
            microsoftLaunchGateRef.current = null;
          }
          resolve(accessToken);
        };
        microsoftLaunchGateRef.current = finish;

        void (async () => {
          try {
            const currentVersion = ++msLoginVersionRef.current;
            setLoginState("loading");
            setLoginError(null);
            setForcedMicrosoftLoginMode(true);
            setForcedMicrosoftLoginMessage(
              `检测到你的微软正版账号「${pName}」无法获取 Minecraft 登录令牌（${tokenErrorMsg || "凭据已失效"}）。` +
                `请完成下方的微软正版登录后再启动游戏；也可先关闭此窗口。`
            );
            setForcedMicrosoftDeviceCode(null);

            let codeInfo: DeviceCodeInfo | null = null;
            try {
              codeInfo = await withTimeout(msRequestDeviceCode(), 10000, "DEVICE_CODE_REQUEST");
            } catch (reqErr) {
              const msg = reqErr instanceof Error ? reqErr.message : String(reqErr);
              if (msLoginVersionRef.current === currentVersion) {
                setLoginError(
                  `获取验证码失败（${msg.includes("TIMEOUT") ? "网络超时" : msg}），请检查网络连接或稍后重试。`
                );
                setLoginState("error");
              }
              finish(null);
              return;
            }

            if (msLoginVersionRef.current !== currentVersion) {
              finish(null);
              return;
            }
            setForcedMicrosoftDeviceCode(codeInfo);

            try {
              const info = await msPollAndLogin(codeInfo.device_code, codeInfo.interval);
              if (msLoginVersionRef.current !== currentVersion) {
                finish(null);
                return;
              }
              let avatarSrc: string | null = null;
              if (info.uuid) {
                try {
                  avatarSrc = await getSkinBase64(info.uuid);
                } catch {
                  /* ignore */
                }
              }
              if (msLoginVersionRef.current !== currentVersion) {
                finish(null);
                return;
              }
              const newAccount: Account = {
                id: `ms-${info.uuid}`,
                name: info.name,
                uuid: info.uuid,
                authType: "microsoft",
                status: AUTH_TYPE_LABELS.microsoft,
                accessToken: info.access_token,
                skinUrl: avatarSrc ?? undefined,
                variant: normalizeSkinVariant(info.variant),
              };
              setProfiles((prev) => {
                const filtered = prev.filter(
                  (p) => !(p.uuid === info.uuid && p.authType === "microsoft")
                );
                return [...filtered, newAccount];
              });
              setSelectedProfile(newAccount);
              setLoginState("idle");
              setForcedMicrosoftLoginMode(false);
              setForcedMicrosoftLoginMessage(null);
              setForcedMicrosoftDeviceCode(null);
              finish(info.access_token);
            } catch (e: unknown) {
              if (msLoginVersionRef.current !== currentVersion) {
                finish(null);
                return;
              }
              const msg = e instanceof Error ? e.message : String(e);
              if (!msg.includes("已取消登录")) {
                setLoginError(msg);
                setLoginState("error");
              } else {
                setLoginState("idle");
                setLoginError(null);
              }
              finish(null);
            }
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            setLoginError(msg);
            setLoginState("error");
            finish(null);
          }
        })();
      });
    },
    []
  );

  const prepareMicrosoftAccountForLaunch = useCallback(
    async (profile: Account): Promise<MicrosoftLaunchPrepResult> => {
      if (profile.authType !== "microsoft" || !profile.uuid) {
        const token = profile.accessToken?.trim();
        return token ? { ok: true, accessToken: token } : { ok: false, reason: "credentials" };
      }

      const puuid = profile.uuid;
      let tokenErrorMsg = "";
      try {
        const refreshed = await withTimeout(msSilentRefreshAccount(puuid), 20000, "MC_TOKEN_REFRESH");
        if (refreshed?.access_token) {
          await applyMicrosoftRefresh(profile.id, puuid, profile.name, refreshed);
          return { ok: true, accessToken: refreshed.access_token };
        }
        tokenErrorMsg = "MC_TOKEN_REFRESH_EMPTY";
      } catch (e: unknown) {
        tokenErrorMsg = e instanceof Error ? e.message : String(e);
      }

      if (isMicrosoftTokenTransientError(tokenErrorMsg)) {
        const existing = profile.accessToken?.trim();
        return existing ? { ok: true, accessToken: existing } : { ok: false, reason: "network" };
      }

      if (tokenErrorMsg.includes("NO_REFRESH_TOKEN") && profile.accessToken?.trim()) {
        return { ok: true, accessToken: profile.accessToken.trim() };
      }

      const newToken = await runForcedMicrosoftRelogin(profile.name, tokenErrorMsg);
      if (newToken) {
        return { ok: true, accessToken: newToken };
      }
      return { ok: false, reason: "cancelled" };
    },
    [applyMicrosoftRefresh, runForcedMicrosoftRelogin]
  );

  // 客户端挂载后从 localStorage 恢复数据，避免 SSR hydration 不匹配
  // 同时刷新 LittleSkin 账户的皮肤；微软账号仅静默刷新令牌（不弹登录窗）
  useEffect(() => {
    const all = loadProfiles();
    const id = loadSelectedId();
    const selected = all.find((p) => p.id === id) ?? all[0] ?? null;
    setProfiles(all);
    setSelectedProfile(selected);

    // 挂载后异步刷新所有 LittleSkin 账户的皮肤
    // 确保用户在 LittleSkin 网站更换皮肤后，重新打开启动器能看到最新皮肤
    all.forEach((profile) => {
      if (profile.authType === "littleskin" && profile.uuid) {
        const pid = profile.id;
        const puuid = profile.uuid;
        (async () => {
          try {
            // 先尝试重新下载皮肤（用户可能在网站上换了皮肤）
            await redownloadLittleSkinSkin(puuid);
            // 下载成功后，读取并更新皮肤显示
            const skinSrc = await getSkinBase64(puuid);
            setProfiles((prev) =>
              prev.map((p) =>
                p.id === pid ? { ...p, skinUrl: skinSrc } : p
              )
            );
          } catch {
            // 刷新失败不影响，保持原来的皮肤（如果有的话）
          }
        })();
      }
    });

    all.forEach((profile) => {
      if (profile.authType !== "microsoft" || !profile.uuid) return;
      const pid = profile.id;
      const puuid = profile.uuid;
      const pName = profile.name;

      (async () => {
        // 1) 先确认 official.rs 数据库是否真的有这个账号（用户要求：只有数据库记载的才做试探）
        console.log(
          `[正版检测-前端] ========== 开始检测微软正版账号：${pName} (UUID=${puuid}) ==========`
        );
        let inDb = false;
        try {
          inDb = await withTimeout(msHasAccountInDb(puuid), 1500, "DB_CHECK");
        } catch (e) {
          console.log(
            `[正版检测-前端] 步骤1：✗ 查询数据库异常:`,
            e instanceof Error ? e.message : String(e)
          );
          return;
        }
        if (!inDb) {
          console.log(
            `[正版检测-前端] 步骤1：✗ official.rs 数据库中未记载该账号（可能已被删除/失效），正在清理残留的皮肤文件和前端账号记录...`
          );
          // 先清理本地磁盘上的皮肤缓存文件
          try {
            const deletedSkinFiles = await deleteCachedSkin(puuid);
            console.log(
              `[正版检测-前端] 步骤1：✓ 清理磁盘皮肤缓存完成，共删除 ${deletedSkinFiles} 个皮肤文件`
            );
          } catch (skinErr) {
            console.log(
              `[正版检测-前端] 步骤1：清理皮肤文件出错（非致命，继续）:`,
              skinErr instanceof Error ? skinErr.message : String(skinErr)
            );
          }
          // 从 profiles 中删除这个残留的微软账号（皮肤信息也是跟着 profile 走的，一并清理）
          setProfiles((prev) => {
            const next = prev.filter((p) => p.id !== pid);
            // 如果删除的是当前选中的账号，把 selectedProfile 切到第一个或 null
            if (selectedProfile?.id === pid) {
              setSelectedProfile(next[0] ?? null);
            }
            if (next.length !== prev.length) {
              console.log(
                `[正版检测-前端] 步骤1：✓ 已从前端移除残留的微软账号：${pName} (${pid})，共 ${prev.length - next.length} 条记录`
              );
            }
            return next;
          });
          return;
        }
        console.log(
          `[正版检测-前端] 步骤1：✓ official.rs 数据库中存在该账号记录`
        );

        console.log(
          `[正版检测-前端] 步骤2：尝试静默刷新 Minecraft 登录令牌（msSilentRefreshAccount）...`
        );
        let tokenErrorMsg = "";
        try {
          const refreshed = await withTimeout(
            msSilentRefreshAccount(puuid),
            20000,
            "MC_TOKEN_REFRESH"
          );
          if (refreshed?.access_token) {
            await applyMicrosoftRefresh(pid, puuid, pName, refreshed);
            console.log(
              `[正版检测-前端] 步骤2：✓ Minecraft 令牌刷新成功，玩家名=${refreshed.name || pName}`
            );
          }
        } catch (e: unknown) {
          tokenErrorMsg = e instanceof Error ? e.message : String(e);
          console.log(
            `[正版检测-前端] 步骤2：静默刷新未成功（启动游戏时会再试）→`,
            tokenErrorMsg
          );
        }
      })();
    });
  }, [applyMicrosoftRefresh]);

  const clearForcedMicrosoftDeviceCode = useCallback(() => {
    setForcedMicrosoftDeviceCode(null);
    setForcedMicrosoftLoginMode(false);
    setForcedMicrosoftLoginMessage(null);
  }, []);

  // 持久化
  useEffect(() => {
    if (profiles.length === 0) return;
    try {
      localStorage.setItem(STORAGE_KEY_PROFILES, JSON.stringify(profiles));
    } catch {}
  }, [profiles]);

  useEffect(() => {
    try {
      if (selectedProfile) {
        localStorage.setItem(STORAGE_KEY_SELECTED, selectedProfile.id);
      } else {
        localStorage.removeItem(STORAGE_KEY_SELECTED);
      }
    } catch {}
  }, [selectedProfile]);

  const selectProfile = useCallback((acc: Account) => {
    setSelectedProfile(acc);
    if (acc.uuid && !acc.skinUrl && (acc.authType === "microsoft" || acc.authType === "littleskin")) {
      const pid = acc.id;
      const puuid = acc.uuid;
      const pAuthType = acc.authType;
      (async () => {
        try {
          if (pAuthType === "littleskin") {
            await redownloadLittleSkinSkin(puuid);
          }
          const skinSrc = await getSkinBase64(puuid);
          setProfiles((prev) =>
            prev.map((p) => (p.id === pid ? { ...p, skinUrl: skinSrc } : p))
          );
          setSelectedProfile((curr) => (curr && curr.id === pid ? { ...curr, skinUrl: skinSrc } : curr));
        } catch {
          // 皮肤获取失败，静默忽略
        }
      })();
    }
  }, []);

  const removeProfile = useCallback(
    (id: string) => {
      setProfiles((prev) => {
        const next = prev.filter((p) => p.id !== id);
        if (selectedProfile?.id === id) {
          setSelectedProfile(next[0] ?? null);
        }
        return next;
      });
    },
    [selectedProfile]
  );

  const updateProfile = useCallback(
    (id: string, patch: Partial<Account>) => {
      setProfiles((prev) => {
        const updated = prev.map((p) => (p.id === id ? { ...p, ...patch } : p));
        // 如果更新的是当前选中的账户，也同步更新 selectedProfile
        if (selectedProfile?.id === id) {
          setSelectedProfile((curr) => (curr ? { ...curr, ...patch } : curr));
        }
        return updated;
      });
    },
    [selectedProfile]
  );

  // ---- LittleSkin 账号密码登录（PCL2 风格，无需浏览器）----
  const loginWithLittleSkinCredentials = useCallback(
    async (username: string, password: string) => {
      setLoginState("loading");
      setLoginError(null);
      try {
        const accounts = await loginLittleSkinWithCredentials(username, password);
        setLoginState("idle");
        return accounts;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setLoginError(msg);
        setLoginState("error");
        throw e;
      }
    },
    []
  );

  const addLittleSkinAccount = useCallback((account: LittleSkinAccount) => {
    const newAccount: Account = {
      id: `ls-${account.uuid}`,
      name: account.name,
      uuid: account.uuid,
      authType: "littleskin",
      status: "LittleSkin 登录",
      accessToken: account.access_token,
      yggdrasilUrl: "https://littleskin.cn/api/yggdrasil",
      skinUrl: account.skin_url ?? undefined,
      variant: normalizeSkinVariant(account.variant),
    };
    setProfiles((prev) => {
      const filtered = prev.filter((p) => p.uuid !== account.uuid || p.authType !== "littleskin");
      return [...filtered, newAccount];
    });
    setSelectedProfile(newAccount);
    // 异步获取皮肤 base64（皮肤已经下载到本地）
    if (account.skin_url) {
      const accountId = `ls-${account.uuid}`;
      const skinUrlKey = account.skin_url;
      const accountUuid = account.uuid;
      // 使用 IIFE 包裹，避免 .catch(async fn) 反模式
      (async () => {
        try {
          const skinSrc = await getSkinBase64(skinUrlKey);
          setProfiles((prev) =>
            prev.map((p) => (p.id === accountId ? { ...p, skinUrl: skinSrc } : p))
          );
        } catch {
          // 第一次失败：尝试重新下载皮肤
          try {
            await redownloadLittleSkinSkin(accountUuid);
            const skinSrc = await getSkinBase64(skinUrlKey);
            setProfiles((prev) =>
              prev.map((p) => (p.id === accountId ? { ...p, skinUrl: skinSrc } : p))
            );
          } catch {
            // 重新下载也失败，静默忽略
          }
        }
      })();
    }
  }, []);

  // ---- LittleSkin OAuth 登录 ----
  const loginWithLittleSkin = useCallback(async () => {
    setLoginState("loading");
    setLoginError(null);
    try {
      const info = await loginLittleSkin();
      const newAccount: Account = {
        id: `ls-${info.uuid}`,
        name: info.name,
        uuid: info.uuid,
        authType: "littleskin",
        status: "LittleSkin 登录",
        accessToken: info.access_token,
        yggdrasilUrl: "https://littleskin.cn/api/yggdrasil",
        skinUrl: info.skin_url ?? undefined,
        variant: normalizeSkinVariant(info.variant),
      };
      setProfiles((prev) => {
        const filtered = prev.filter(
          (p) => !(p.uuid === info.uuid && p.authType === "littleskin")
        );
        return [...filtered, newAccount];
      });
      setSelectedProfile(newAccount);
      // 异步获取皮肤 base64
      if (info.skin_url) {
        const accountId = `ls-${info.uuid}`;
        const skinUrlKey = info.skin_url;
        const accountUuid = info.uuid;
        (async () => {
          try {
            const skinSrc = await getSkinBase64(skinUrlKey);
            setProfiles((prev) =>
              prev.map((p) => (p.id === accountId ? { ...p, skinUrl: skinSrc } : p))
            );
          } catch {
            // 第一次失败：尝试重新下载皮肤
            try {
              await redownloadLittleSkinSkin(accountUuid);
              const skinSrc = await getSkinBase64(skinUrlKey);
              setProfiles((prev) =>
                prev.map((p) => (p.id === accountId ? { ...p, skinUrl: skinSrc } : p))
              );
            } catch {
              // 重新下载也失败，静默忽略
            }
          }
        })();
      }
      setLoginState("idle");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setLoginError(msg);
      setLoginState("error");
    }
  }, []);

  // ---- 第三方 Yggdrasil 登录 (先获取角色列表) ----
  const loginWithThirdParty = useCallback(
    async (url: string, user: string, pwd: string) => {
      setLoginState("loading");
      setLoginError(null);
      try {
        const result = await loginThirdParty(url, user, pwd);
        setLoginState("idle");
        return result;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setLoginError(msg);
        setLoginState("error");
        throw e;
      }
    },
    []
  );

  // ---- 选择第三方角色后添加账户 ----
  const addThirdPartyAccount = useCallback(
    (
      profile: { id: string; name: string },
      accessToken: string,
      yggdrasilUrl: string,
    ) => {
      const newAccount: Account = {
        id: `tp-${profile.id}`,
        name: profile.name,
        uuid: profile.id,
        authType: "third_party",
        status: AUTH_TYPE_LABELS.third_party,
        accessToken,
        yggdrasilUrl,
      };
      setProfiles((prev) => {
        const filtered = prev.filter(
          (p) => !(p.uuid === profile.id && p.authType === "third_party")
        );
        return [...filtered, newAccount];
      });
      setSelectedProfile(newAccount);
      // 异步下载并获取皮肤 base64
      if (profile.id) {
        getSkinBase64(profile.id)
          .then((skinSrc) => {
            setProfiles((prev) =>
              prev.map((p) =>
                p.id === `tp-${profile.id}` ? { ...p, skinUrl: skinSrc } : p
              )
            );
          })
          .catch(() => {
            // 静默失败
          });
      }
    },
    []
  );

  // ---- 离线登录 ----
  const addOfflineAccount = useCallback((name: string) => {
    const id = `offline-${Date.now()}`;
    // 基于玩家名生成稳定的 UUID v3（离线认证不需要真实 token）
    const hashStr = `OfflinePlayer:${name}`;
    let h1 = 0xdeadbeef ^ hashStr.length;
    let h2 = 0x41c6ce57 ^ hashStr.length;
    for (let i = 0; i < hashStr.length; i++) {
      const ch = hashStr.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 = Math.imul(h1 ^ (h2 >>> 13), 3266489909);
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    const hex = (n: number, len: number) => (n >>> 0).toString(16).padStart(len, "0");
    const generatedUuid = `${hex(h1, 8)}-${hex(h2 >>> 16, 4)}-${hex((h2 & 0x0fff) | 0x3000, 4)}-${hex((h2 >>> 8) & 0xffff, 4)}-${hex(h1 & 0xffffffff, 8)}${hex(h2, 8)}`.substring(0, 36);
    const newAccount: Account = {
      id,
      name,
      uuid: generatedUuid,
      authType: "offline",
      status: AUTH_TYPE_LABELS.offline,
      accessToken: "0",
    };
    setProfiles((prev) => [...prev, newAccount]);
    setSelectedProfile(newAccount);
  }, []);

  // ---- 微软正版登录 ----
  const loginWithMicrosoft = useCallback(async (): Promise<DeviceCodeInfo> => {
    // 每次重新开始微软登录时递增版本号
    const currentVersion = ++msLoginVersionRef.current;
    setLoginState("loading");
    setLoginError(null);
    try {
      // 第一步：获取设备代码
      const codeInfo = await msRequestDeviceCode();

      // 第二步：后台轮询 (不阻塞 UI, 异步等后端返回)
      msPollAndLogin(codeInfo.device_code, codeInfo.interval)
        .then(async (info) => {
          // 如果在等待期间用户已取消（版本号不同），忽略这次结果
          if (msLoginVersionRef.current !== currentVersion) return;
          // info.skin_url 现在是 uuid（本地皮肤文件标识）
          let avatarSrc: string | null = null;
          if (info.uuid) {
            try {
              avatarSrc = await getSkinBase64(info.uuid);
            } catch {
              // 皮肤获取失败不影响登录
            }
          }
          // 再次检查取消状态（皮肤获取可能需要时间）
          if (msLoginVersionRef.current !== currentVersion) return;
          const newAccount: Account = {
            id: `ms-${info.uuid}`,
            name: info.name,
            uuid: info.uuid,
            authType: "microsoft",
            status: AUTH_TYPE_LABELS.microsoft,
            accessToken: info.access_token,
            skinUrl: avatarSrc ?? undefined,
            variant: normalizeSkinVariant(info.variant),
          };
          setProfiles((prev) => {
            const filtered = prev.filter(
              (p) => !(p.uuid === info.uuid && p.authType === "microsoft")
            );
            return [...filtered, newAccount];
          });
          setSelectedProfile(newAccount);
          setLoginState("idle");
        })
        .catch((e: unknown) => {
          // 用户主动取消时不更新状态（不显示错误）
          if (msLoginVersionRef.current !== currentVersion) return;
          const msg = e instanceof Error ? e.message : String(e);
          // "已取消登录" 是用户主动操作，不设为 error 状态
          if (msg.includes("已取消登录")) {
            setLoginState("idle");
            setLoginError(null);
            return;
          }
          setLoginError(msg);
          setLoginState("error");
        });

      // 立即返回设备代码给 UI 展示
      return codeInfo;
    } catch (e: unknown) {
      // 如果用户在第一步（获取 device_code）时就已取消，不设置 error 状态
      if (msLoginVersionRef.current !== currentVersion) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      setLoginError(msg);
      setLoginState("error");
      throw e;
    }
  }, []);

  // ---- 取消微软正版登录（用户关闭对话框时调用）----
  const cancelMicrosoftLogin = useCallback(() => {
    // 递增版本号：让之前的 then/catch 回调识别到"已被取消"
    msLoginVersionRef.current++;
    if (microsoftLaunchGateRef.current) {
      const gate = microsoftLaunchGateRef.current;
      microsoftLaunchGateRef.current = null;
      gate(null);
    }
    // 设置状态恢复为 idle，不再显示"登录中"
    setLoginState("idle");
    setLoginError(null);
    // 清理强制登录 DeviceCode + 强制模式
    setForcedMicrosoftDeviceCode(null);
    setForcedMicrosoftLoginMode(false);
    setForcedMicrosoftLoginMessage(null);
    // 通知后端：停止轮询循环
    msCancelLogin().catch(() => {
      // 静默失败
    });
  }, []);

  return (
    <AccountContext.Provider
      value={{
        profiles,
        selectedProfile,
        selectProfile,
        removeProfile,
        updateProfile,
        loginWithLittleSkin,
        loginWithLittleSkinCredentials,
        addLittleSkinAccount,
        loginWithThirdParty,
        addOfflineAccount,
        addThirdPartyAccount,
        loginWithMicrosoft,
        cancelMicrosoftLogin,
        loginState,
        loginError,
        forcedMicrosoftDeviceCode,
        forcedMicrosoftLoginMode,
        forcedMicrosoftLoginMessage,
        clearForcedMicrosoftDeviceCode,
        manualLoginOpen,
        setManualLoginOpen,
        prepareMicrosoftAccountForLaunch,
      }}
    >
      {children}
      {/*
        🔴 关键修复：LoginDialog 直接放在 AccountProvider 内全局渲染，
        不再依赖 AccountSwitcher 是否被用户打开过！
        - forcedMicrosoftLoginMode=true → 正版启动前令牌失效提示（锁定 microsoft tab，可关闭）
        - manualLoginOpen=true         → 用户点了"添加账户"按钮的普通模式
        两者只要有一个是 true，就显示 LoginDialog。
      */}
      <LoginDialog
        open={forcedMicrosoftLoginMode || manualLoginOpen}
        onClose={() => {
          setManualLoginOpen(false);
        }}
        forcedDeviceCode={forcedMicrosoftDeviceCode}
        onForcedDeviceCodeConsumed={clearForcedMicrosoftDeviceCode}
        forcedMode={forcedMicrosoftLoginMode}
        forcedMessage={forcedMicrosoftLoginMessage}
      />
    </AccountContext.Provider>
  );
}

export function useAccountContext() {
  const ctx = useContext(AccountContext);
  if (!ctx)
    throw new Error("useAccountContext must be used within AccountProvider");
  return ctx;
}
