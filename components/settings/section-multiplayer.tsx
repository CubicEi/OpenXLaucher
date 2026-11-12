"use client";

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Globe,
  Loader2,
  RefreshCw,
  Shield,
  Square,
  Trash2,
  Download,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useI18n } from "@/components/i18n/use-i18n";
import { useConfirmDialog } from "@/components/confirm-dialog";

const DEFAULT_PUBLIC_NODE_URL = "tcp://225284.xyz:11010";
const PUBLIC_NODE_STORAGE_KEY = "openxlauncher:multiplayer:publicNodeUrl";

type BusyAction =
  | "refresh"
  | "repair"
  | "privileges"
  | "stop"
  | "uninstall"
  | "savePeer"
  | null;

type ToolStatus = {
  installed: boolean;
  version: string | null;
  path: string | null;
  running: boolean;
};

type MpPaths = {
  directory?: string;
  executable?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function readString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function readBoolean(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return null;
}

function normalizeToolStatus(raw: unknown, fallbackRunning = false, paths?: MpPaths | null): ToolStatus {
  const obj = asRecord(raw);
  const installed = readBoolean(obj?.installed, obj?.is_installed, obj?.isInstalled) ?? false;
  const running =
    readBoolean(obj?.running, obj?.is_running, obj?.isRunning) ?? fallbackRunning;
  const version = readString(obj?.version, obj?.tool_version, obj?.toolVersion);
  const path = readString(
    obj?.path,
    obj?.executable,
    obj?.toolPath,
    obj?.tool_path,
    obj?.executable_path,
    obj?.executablePath,
    paths?.executable,
    paths?.directory,
  );
  return { installed, version, path, running };
}

function normalizePaths(raw: unknown): MpPaths | null {
  const obj = asRecord(raw);
  if (!obj) return null;
  return {
    directory:
      readString(obj.directory, obj.bridgeDir, obj.bridge_dir, obj.dir, obj.tool_dir, obj.toolDir) ??
      undefined,
    executable:
      readString(
        obj.executable,
        obj.toolPath,
        obj.tool_path,
        obj.path,
        obj.exe,
      ) ?? undefined,
  };
}

function readPeerFromSnapshots(...snapshots: unknown[]): string | null {
  for (const snapshot of snapshots) {
    const obj = asRecord(snapshot);
    const peer = readString(obj?.peer, obj?.defaultPeer, obj?.default_peer);
    if (peer) return peer;
  }
  return null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isRetiredOfficialPeer(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.includes("public.easytier.top") || lower.includes("public.easytier.cn");
}

function loadStoredPublicNodeUrl(): string {
  if (typeof window === "undefined") return DEFAULT_PUBLIC_NODE_URL;
  try {
    const stored = localStorage.getItem(PUBLIC_NODE_STORAGE_KEY);
    if (stored && stored.trim()) {
      const trimmed = stored.trim();
      if (isRetiredOfficialPeer(trimmed)) {
        persistPublicNodeUrl(DEFAULT_PUBLIC_NODE_URL);
        return DEFAULT_PUBLIC_NODE_URL;
      }
      return trimmed;
    }
  } catch {
    // ignore storage failures
  }
  return DEFAULT_PUBLIC_NODE_URL;
}

function persistPublicNodeUrl(url: string) {
  try {
    localStorage.setItem(PUBLIC_NODE_STORAGE_KEY, url);
  } catch {
    // ignore storage failures
  }
}

async function emergencyStopProcess(): Promise<void> {
  try {
    await invoke("mp_stop_session");
    return;
  } catch {
    // fall through to force kill when stop_session is unavailable
  }
  await invoke("mp_force_kill_process");
}

export function MultiplayerSection() {
  const { t } = useI18n();
  const { confirm } = useConfirmDialog();

  const [status, setStatus] = useState<ToolStatus | null>(null);
  const [paths, setPaths] = useState<MpPaths | null>(null);
  const [publicNodeUrl, setPublicNodeUrl] = useState(DEFAULT_PUBLIC_NODE_URL);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    setPublicNodeUrl(loadStoredPublicNodeUrl());
  }, []);

  const refresh = useCallback(async (showBusy = true) => {
    if (showBusy) setBusy("refresh");
    setError(null);
    try {
      const [toolStatusRaw, runningRaw, pathsRaw] = await Promise.all([
        invoke<unknown>("mp_get_tool_status").catch(() => null),
        invoke<boolean>("mp_is_running").catch(() => false),
        invoke<unknown>("mp_get_paths").catch(() => null),
      ]);

      const nextPaths = normalizePaths(pathsRaw);
      setPaths(nextPaths);

      const peerFromBackend = readPeerFromSnapshots(toolStatusRaw, pathsRaw);
      if (peerFromBackend) {
        setPublicNodeUrl(peerFromBackend);
        persistPublicNodeUrl(peerFromBackend);
      }

      if (toolStatusRaw == null) {
        setStatus({
          installed: false,
          version: null,
          path: nextPaths?.executable ?? nextPaths?.directory ?? null,
          running: Boolean(runningRaw),
        });
      } else {
        setStatus(normalizeToolStatus(toolStatusRaw, Boolean(runningRaw), nextPaths));
      }
    } catch (e) {
      setError(errorMessage(e) || t("settings.multiplayer.loadFailed"));
    } finally {
      if (showBusy) setBusy(null);
    }
  }, [t]);

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  const runAction = async (
    action: Exclude<BusyAction, "refresh" | null>,
    successKey:
      | "settings.multiplayer.repairSuccess"
      | "settings.multiplayer.privilegesSuccess"
      | "settings.multiplayer.stopSuccess"
      | "settings.multiplayer.uninstallSuccess"
      | "settings.multiplayer.publicNodeSaved",
    work: () => Promise<void>,
  ) => {
    setBusy(action);
    setError(null);
    setSuccess(null);
    try {
      await work();
      setSuccess(t(successKey));
      await refresh(false);
    } catch (e) {
      setError(errorMessage(e) || t("settings.multiplayer.actionFailed"));
    } finally {
      setBusy(null);
    }
  };

  const handleRepair = () =>
    void runAction("repair", "settings.multiplayer.repairSuccess", async () => {
      await invoke("mp_ensure_installed");
    });

  const handlePreparePrivileges = () => {
    void (async () => {
      setBusy("privileges");
      setError(null);
      setSuccess(null);
      try {
        const result = await invoke<{
          ok?: boolean;
          message?: string;
          manualSteps?: string[];
          manual_steps?: string[];
        }>("mp_prepare_privileges");
        const steps = result.manualSteps ?? result.manual_steps ?? [];
        const detail = [result.message, ...steps].filter(Boolean).join("\n");
        if (result.ok === false) {
          setError(detail || t("settings.multiplayer.actionFailed"));
        } else {
          setSuccess(detail || t("settings.multiplayer.privilegesSuccess"));
        }
        await refresh(false);
      } catch (e) {
        setError(errorMessage(e) || t("settings.multiplayer.actionFailed"));
      } finally {
        setBusy(null);
      }
    })();
  };

  const handleEmergencyStop = () =>
    void runAction("stop", "settings.multiplayer.stopSuccess", async () => {
      await emergencyStopProcess();
    });

  const handleUninstall = async () => {
    const accepted = await confirm({
      title: t("settings.multiplayer.uninstallConfirmTitle"),
      description: t("settings.multiplayer.uninstallConfirmDescription"),
      confirmLabel: t("settings.multiplayer.uninstall"),
      cancelLabel: t("common.cancel"),
      destructive: true,
    });
    if (!accepted) return;
    await runAction("uninstall", "settings.multiplayer.uninstallSuccess", async () => {
      await invoke("mp_uninstall_tool");
    });
  };

  const handleSavePublicNode = () =>
    void runAction("savePeer", "settings.multiplayer.publicNodeSaved", async () => {
      const next = publicNodeUrl.trim() || DEFAULT_PUBLIC_NODE_URL;
      const saved = await invoke<string>("mp_set_peer", { peer: next });
      const normalized = (saved && saved.trim()) || next;
      setPublicNodeUrl(normalized);
      persistPublicNodeUrl(normalized);
    });

  const displayPath =
    status?.path ?? paths?.executable ?? paths?.directory ?? t("settings.multiplayer.unknown");
  const displayVersion = status?.version ?? t("settings.multiplayer.unknown");
  const isBusy = busy != null;

  return (
    <div className="space-y-4">
      <Card id="section-multiplayer" className="scroll-mt-4">
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2 text-base">
            <Globe className="size-4 text-primary" />
            {t("settings.multiplayer.title")}
          </CardTitle>
          <CardDescription className="mt-1 text-xs">
            {t("settings.multiplayer.description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {success ? (
            <Alert>
              <AlertDescription>{success}</AlertDescription>
            </Alert>
          ) : null}

          <div className="space-y-2 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-3">
              <Label className="text-sm font-medium">{t("settings.multiplayer.status")}</Label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 gap-1.5"
                disabled={isBusy}
                onClick={() => void refresh(true)}
              >
                {busy === "refresh" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
                {t("common.refresh")}
              </Button>
            </div>
            <dl className="grid gap-2 text-xs sm:grid-cols-2">
              <div className="rounded-md bg-muted/40 px-2.5 py-2">
                <dt className="text-muted-foreground">{t("settings.multiplayer.installed")}</dt>
                <dd className="mt-0.5 font-medium text-foreground">
                  {status
                    ? status.installed
                      ? t("settings.multiplayer.yes")
                      : t("settings.multiplayer.no")
                    : t("common.loading")}
                </dd>
              </div>
              <div className="rounded-md bg-muted/40 px-2.5 py-2">
                <dt className="text-muted-foreground">{t("settings.multiplayer.running")}</dt>
                <dd className="mt-0.5 font-medium text-foreground">
                  {status
                    ? status.running
                      ? t("settings.multiplayer.runningYes")
                      : t("settings.multiplayer.runningNo")
                    : t("common.loading")}
                </dd>
              </div>
              <div className="rounded-md bg-muted/40 px-2.5 py-2">
                <dt className="text-muted-foreground">{t("settings.multiplayer.version")}</dt>
                <dd className="mt-0.5 break-all font-mono text-foreground">{displayVersion}</dd>
              </div>
              <div className="rounded-md bg-muted/40 px-2.5 py-2">
                <dt className="text-muted-foreground">{t("settings.multiplayer.path")}</dt>
                <dd className="mt-0.5 break-all font-mono text-foreground">{displayPath}</dd>
              </div>
            </dl>
          </div>

          <div className="space-y-3 rounded-lg border p-3">
            <div className="space-y-1">
              <Label htmlFor="multiplayer-public-node" className="text-sm font-medium">
                {t("settings.multiplayer.publicNodeUrl")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("settings.multiplayer.publicNodeUrlDescription")}
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="multiplayer-public-node"
                name="oxl-mp-public-node"
                type="text"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-1p-ignore
                data-lpignore="true"
                data-form-type="other"
                value={publicNodeUrl}
                onChange={(e) => setPublicNodeUrl(e.target.value)}
                placeholder={DEFAULT_PUBLIC_NODE_URL}
                className="h-8 font-mono text-xs"
                disabled={isBusy}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0 gap-1.5"
                disabled={isBusy}
                onClick={handleSavePublicNode}
              >
                {busy === "savePeer" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : null}
                {t("settings.multiplayer.savePublicNode")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("settings.multiplayer.publicNodeUrlHint")}</p>
          </div>

          <div className="space-y-2 rounded-lg border p-3">
            <Label className="text-sm font-medium">{t("settings.multiplayer.actions")}</Label>
            <p className="text-xs text-muted-foreground">{t("settings.multiplayer.actionsHint")}</p>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 gap-1.5"
                disabled={isBusy}
                onClick={handleRepair}
              >
                {busy === "repair" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Download className="size-3.5" />
                )}
                {busy === "repair"
                  ? t("settings.multiplayer.repairing")
                  : t("settings.multiplayer.repair")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 gap-1.5"
                disabled={isBusy}
                onClick={handlePreparePrivileges}
              >
                {busy === "privileges" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Shield className="size-3.5" />
                )}
                {busy === "privileges"
                  ? t("settings.multiplayer.preparingPrivileges")
                  : t("settings.multiplayer.preparePrivileges")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 gap-1.5"
                disabled={isBusy}
                onClick={handleEmergencyStop}
              >
                {busy === "stop" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Square className="size-3.5" />
                )}
                {busy === "stop"
                  ? t("settings.multiplayer.stopping")
                  : t("settings.multiplayer.emergencyStop")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                className="h-8 gap-1.5"
                disabled={isBusy}
                onClick={() => void handleUninstall()}
              >
                {busy === "uninstall" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Trash2 className="size-3.5" />
                )}
                {busy === "uninstall"
                  ? t("settings.multiplayer.uninstalling")
                  : t("settings.multiplayer.uninstall")}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
