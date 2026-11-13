"use client";

import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { Check, Copy, Loader2, Power, ScrollText, Server, Users } from "lucide-react";

import {
  formatHostAddress,
  type DecodedInvite,
} from "@/components/multiplayer/multiplayer-invite";
import type { RunMode } from "@/components/multiplayer/multiplayer-state";
import { useI18n } from "@/components/i18n/use-i18n";
import { Button } from "@/components/ui/button";

type MultiplayerRunningPanelProps = {
  runMode: RunMode | null;
  roomInfo: string | null;
  decodedInvite: DecodedInvite | null;
  logText: string;
  toolDirectory?: string;
  onStop: () => void | Promise<void>;
  onClearLog: () => void;
};

export function MultiplayerRunningPanel({
  runMode,
  roomInfo,
  decodedInvite,
  logText,
  onStop,
  onClearLog,
}: MultiplayerRunningPanelProps) {
  const { t } = useI18n();
  const [autoScroll, setAutoScroll] = useState(true);
  const [copiedInvite, setCopiedInvite] = useState(false);
  const [copiedAddress, setCopiedAddress] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const copyTimerRef = useRef<number | null>(null);
  const addressTimerRef = useRef<number | null>(null);

  const hostAddress = useMemo(
    () => (decodedInvite ? formatHostAddress(decodedInvite) : null),
    [decodedInvite]
  );

  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [autoScroll, logText]);

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      if (addressTimerRef.current !== null) window.clearTimeout(addressTimerRef.current);
    },
    []
  );

  const copyText = async (
    value: string,
    setCopied: (next: boolean) => void,
    timerRef: MutableRefObject<number | null>
  ) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 2_000);
    } catch (error) {
      console.error("复制失败:", error);
    }
  };

  const runningModeLabel =
    runMode === "host"
      ? t("multiplayer.running.modeHost")
      : runMode === "join"
        ? t("multiplayer.running.modeJoin")
        : t("multiplayer.running.modeBackground");

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-muted/30 px-4 py-3">
        <div className="flex items-center gap-2 text-sm text-foreground">
          <div className="size-2 animate-pulse rounded-full bg-green-500" />
          <span className="font-medium">
            {t("multiplayer.running.header", { mode: runningModeLabel })}
          </span>
        </div>
        <Button variant="destructive" size="sm" onClick={() => void onStop()} className="gap-1.5">
          <Power className="size-3.5" />
          <span>{t("multiplayer.running.stop")}</span>
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
        <div className="flex flex-col items-center justify-center gap-5 overflow-auto border-border p-6 lg:w-[45%] lg:border-r">
          <div className="flex size-20 shrink-0 items-center justify-center rounded-2xl bg-green-500/10">
            {runMode === "host" ? (
              <Server className="size-10 text-green-600 dark:text-green-400" />
            ) : (
              <Users className="size-10 text-green-600 dark:text-green-400" />
            )}
          </div>

          <div className="max-w-md space-y-2 text-center">
            <h2 className="text-lg font-semibold text-foreground">
              {runMode === "host"
                ? t("multiplayer.running.hostReady")
                : runMode === "join"
                  ? t("multiplayer.running.joinReady")
                  : t("multiplayer.running.sessionRunning")}
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {t("multiplayer.running.sessionHint")}
            </p>
          </div>

          {runMode === "join" && hostAddress ? (
            <div className="w-full max-w-lg space-y-3">
              <div className="space-y-2 rounded-xl border border-primary/40 bg-primary/5 px-4 py-5 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-primary">
                  {t("multiplayer.running.directConnectTitle")}
                </p>
                <button
                  type="button"
                  onClick={() =>
                    void copyText(hostAddress, setCopiedAddress, addressTimerRef)
                  }
                  className="mx-auto block w-full rounded-lg bg-background/80 px-3 py-3 font-mono text-2xl font-bold tracking-wide text-foreground transition-colors hover:bg-background"
                  title={t("multiplayer.running.copyAddress")}
                >
                  {hostAddress}
                </button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void copyText(hostAddress, setCopiedAddress, addressTimerRef)
                  }
                  className="gap-1.5"
                >
                  {copiedAddress ? (
                    <Check className="size-3.5 text-green-600" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                  <span>
                    {copiedAddress
                      ? t("multiplayer.common.copied")
                      : t("multiplayer.running.copyAddress")}
                  </span>
                </Button>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t("multiplayer.running.directConnectHint")}
                </p>
              </div>
            </div>
          ) : null}

          {runMode === "host" && hostAddress ? (
            <div className="w-full max-w-lg space-y-2 rounded-lg border border-border bg-background/50 px-3 py-3 text-center">
              <p className="text-xs text-muted-foreground">
                {t("multiplayer.running.hostAddressHint")}
              </p>
              <p className="font-mono text-base font-semibold text-foreground">{hostAddress}</p>
            </div>
          ) : null}

          {runMode === "host" && roomInfo ? (
            <div className="w-full max-w-lg space-y-2">
              <div className="text-center text-xs text-muted-foreground">
                {t("multiplayer.running.shareInvite")}
              </div>
              <div className="flex items-center gap-2 rounded-lg border border-border bg-background/50 px-3 py-2">
                <code className="flex-1 break-all font-mono text-xs text-foreground">
                  {roomInfo}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void copyText(roomInfo, setCopiedInvite, copyTimerRef)}
                  className="shrink-0 gap-1.5"
                >
                  {copiedInvite ? (
                    <Check className="size-3.5 text-green-600" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                  <span>
                    {copiedInvite
                      ? t("multiplayer.common.copied")
                      : t("multiplayer.common.copy")}
                  </span>
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex min-h-0 flex-1 flex-col border-t border-border lg:border-t-0">
          <div className="flex shrink-0 items-center justify-between bg-muted/20 px-4 py-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <ScrollText className="size-3.5" />
              <span className="font-medium">{t("multiplayer.running.logs")}</span>
            </div>
            <div className="flex items-center gap-2">
              <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={autoScroll}
                  onChange={(event) => setAutoScroll(event.target.checked)}
                  className="rounded border-border"
                />
                {t("multiplayer.running.autoScroll")}
              </label>
              <Button
                variant="ghost"
                size="sm"
                onClick={onClearLog}
                className="h-6 px-2 text-[10px]"
              >
                {t("common.clear")}
              </Button>
            </div>
          </div>
          <div
            ref={logRef}
            className="min-h-0 flex-1 overflow-auto bg-[#071a2e] p-3 font-mono text-[11px] leading-relaxed dark:bg-[#061322]"
          >
            {logText ? (
              <pre className="whitespace-pre-wrap break-all text-green-400/90 dark:text-green-300/90">
                {logText}
              </pre>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-400">
                <Loader2 className="size-4 animate-spin" />
                <p className="text-[11px]">{t("multiplayer.running.waitingLogs")}</p>
                <p className="text-[10px]">{t("multiplayer.running.waitingLogsHint")}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
