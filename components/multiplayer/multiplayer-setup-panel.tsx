"use client";

import { useMemo, useState } from "react";
import { AlertCircle, Power, Server, Users } from "lucide-react";

import { decodeInvite, formatHostAddress } from "@/components/multiplayer/multiplayer-invite";
import type { RunMode } from "@/components/multiplayer/multiplayer-state";
import { useI18n } from "@/components/i18n/use-i18n";
import { Button } from "@/components/ui/button";

type MultiplayerSetupPanelProps = {
  onStartHost: (roomName: string, port: string) => Promise<unknown>;
  onStartJoin: (encodedInvite: string, playerName: string) => Promise<unknown>;
};

export function MultiplayerSetupPanel({
  onStartHost,
  onStartJoin,
}: MultiplayerSetupPanelProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<RunMode>("host");
  const [roomName, setRoomName] = useState("");
  const [port, setPort] = useState("25565");
  const [encodedInvite, setEncodedInvite] = useState("");
  const [playerName, setPlayerName] = useState("");

  const previewInvite = useMemo(
    () => (mode === "join" ? decodeInvite(encodedInvite) : null),
    [encodedInvite, mode]
  );

  const handleStart = async () => {
    try {
      if (mode === "host") {
        const normalizedRoomName = roomName.trim();
        const normalizedPort = port.trim();
        if (!normalizedRoomName || !normalizedPort) return;
        await onStartHost(normalizedRoomName, normalizedPort);
        return;
      }

      const normalizedInvite = encodedInvite.trim();
      const normalizedPlayerName = playerName.trim();
      if (!normalizedInvite || !normalizedPlayerName) return;
      await onStartJoin(normalizedInvite, normalizedPlayerName);
    } catch (error) {
      console.error("启动联机失败:", error);
    }
  };

  return (
    <div className="flex flex-1 flex-col gap-6 rounded-xl border border-border bg-card p-6">
      <div className="flex items-center justify-center gap-2">
        <Button
          type="button"
          variant={mode === "host" ? "default" : "outline"}
          size="sm"
          onClick={() => setMode("host")}
          className="gap-1.5"
        >
          <Server className="size-3.5" />
          <span>{t("multiplayer.setup.hostTab")}</span>
        </Button>
        <Button
          type="button"
          variant={mode === "join" ? "default" : "outline"}
          size="sm"
          onClick={() => setMode("join")}
          className="gap-1.5"
        >
          <Users className="size-3.5" />
          <span>{t("multiplayer.setup.joinTab")}</span>
        </Button>
      </div>

      {mode === "host" ? (
        <form
          className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-5"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            void handleStart();
          }}
        >
          <div className="flex size-16 items-center justify-center rounded-2xl bg-primary/10">
            <Server className="size-8 text-primary" />
          </div>
          <div className="w-full space-y-1 text-center">
            <h2 className="text-base font-semibold text-foreground">
              {t("multiplayer.setup.hostTitle")}
            </h2>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("multiplayer.setup.hostDescription")}
            </p>
          </div>

          <div className="w-full space-y-3">
            <div className="space-y-1.5">
              <label htmlFor="multiplayer-room-name" className="text-xs font-medium text-foreground">
                {t("multiplayer.setup.roomName")}
              </label>
              <input
                id="multiplayer-room-name"
                name="oxl-mp-room-name"
                type="text"
                inputMode="text"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-1p-ignore
                data-lpignore="true"
                data-form-type="other"
                value={roomName}
                onChange={(event) => setRoomName(event.target.value)}
                placeholder={t("multiplayer.setup.roomNamePlaceholder")}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/50"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="multiplayer-port" className="text-xs font-medium text-foreground">
                {t("multiplayer.setup.port")}
              </label>
              <input
                id="multiplayer-port"
                name="oxl-mp-lan-port"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-1p-ignore
                data-lpignore="true"
                data-form-type="other"
                value={port}
                onChange={(event) => setPort(event.target.value)}
                placeholder={t("multiplayer.setup.portPlaceholder")}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/50"
              />
              <p className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
                <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                <span>{t("multiplayer.setup.portHint")}</span>
              </p>
            </div>

            <Button
              type="submit"
              className="mt-2 w-full gap-2"
              disabled={!roomName.trim() || !port.trim()}
            >
              <Power className="size-4" />
              <span>{t("multiplayer.setup.startHost")}</span>
            </Button>
          </div>
        </form>
      ) : (
        <form
          className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-5"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            void handleStart();
          }}
        >
          <div className="flex size-16 items-center justify-center rounded-2xl bg-primary/10">
            <Users className="size-8 text-primary" />
          </div>
          <div className="w-full space-y-1 text-center">
            <h2 className="text-base font-semibold text-foreground">
              {t("multiplayer.setup.joinTitle")}
            </h2>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("multiplayer.setup.joinDescription")}
            </p>
          </div>

          <div className="w-full space-y-3">
            <div className="space-y-1.5">
              <label
                htmlFor="multiplayer-room-code"
                className="text-xs font-medium text-foreground"
              >
                {t("multiplayer.setup.inviteCode")}
              </label>
              <input
                id="multiplayer-room-code"
                name="oxl-mp-invite-code"
                type="text"
                inputMode="text"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-1p-ignore
                data-lpignore="true"
                data-form-type="other"
                value={encodedInvite}
                onChange={(event) => setEncodedInvite(event.target.value)}
                placeholder={t("multiplayer.setup.inviteCodePlaceholder")}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/50"
              />
            </div>

            {previewInvite ? (
              <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-center">
                <p className="text-[11px] text-muted-foreground">
                  {t("multiplayer.setup.previewAddress")}
                </p>
                <p className="mt-1 font-mono text-lg font-semibold tracking-wide text-foreground">
                  {formatHostAddress(previewInvite)}
                </p>
              </div>
            ) : encodedInvite.trim() ? (
              <p className="text-xs text-amber-700 dark:text-amber-300">
                {t("multiplayer.setup.invalidInvite")}
              </p>
            ) : null}

            <div className="space-y-1.5">
              <label
                htmlFor="multiplayer-player-name"
                className="text-xs font-medium text-foreground"
              >
                {t("multiplayer.setup.playerName")}
              </label>
              <input
                id="multiplayer-player-name"
                name="oxl-mp-player-name"
                type="text"
                inputMode="text"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-1p-ignore
                data-lpignore="true"
                data-form-type="other"
                value={playerName}
                onChange={(event) => setPlayerName(event.target.value)}
                placeholder={t("multiplayer.setup.playerNamePlaceholder")}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/50"
              />
            </div>

            <Button
              type="submit"
              className="mt-2 w-full gap-2"
              disabled={!encodedInvite.trim() || !playerName.trim() || !previewInvite}
            >
              <Power className="size-4" />
              <span>{t("multiplayer.setup.startJoin")}</span>
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
