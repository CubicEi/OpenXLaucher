"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Loader2 } from "lucide-react";

import { DialogShell } from "@/components/dialog-shell";
import { useI18n } from "@/components/i18n/use-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export type ConfirmDialogActionVariant = "primary" | "outline" | "destructive";

export type ConfirmDialogAction = {
  label: string;
  variant?: ConfirmDialogActionVariant;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
};

export type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  actions: ConfirmDialogAction[];
  /** 为 true 时禁止点遮罩关闭（进行中等） */
  lockDismiss?: boolean;
  className?: string;
};

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  children,
  actions,
  lockDismiss = false,
  className,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (lockDismiss && !next) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        hideClose
        className={cn("!max-w-md p-0 overflow-hidden", className)}
        onPointerDownOutside={(e) => {
          if (lockDismiss) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (lockDismiss) e.preventDefault();
        }}
      >
        <DialogShell
          title={title}
          footer={
            <>
              {actions.map((action, index) => (
                <Button
                  key={`${action.label}-${index}`}
                  type="button"
                  size="sm"
                  variant={
                    action.variant === "destructive"
                      ? "destructive"
                      : action.variant === "primary"
                        ? "default"
                        : "outline"
                  }
                  disabled={action.disabled || action.loading}
                  onClick={action.onClick}
                  className="min-w-[4.5rem]"
                >
                  {action.loading ? (
                    <Loader2 className="size-3.5 animate-spin mr-1.5" />
                  ) : null}
                  {action.label}
                </Button>
              ))}
            </>
          }
        >
          <div className="text-foreground/90 space-y-2">{children}</div>
        </DialogShell>
      </DialogContent>
    </Dialog>
  );
}

// ---- 命令式 confirm / alert（主题、更新检查等） ----

export type ConfirmPromptOptions = {
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
};

export type AlertPromptOptions = {
  title: string;
  description: ReactNode;
  confirmLabel?: string;
};

type PendingPrompt =
  | {
      kind: "confirm";
      options: ConfirmPromptOptions;
      resolve: (accepted: boolean) => void;
    }
  | {
      kind: "alert";
      options: AlertPromptOptions;
      resolve: () => void;
    };

type ConfirmDialogContextValue = {
  confirm: (options: ConfirmPromptOptions) => Promise<boolean>;
  alert: (options: AlertPromptOptions) => Promise<void>;
};

const ConfirmDialogContext = createContext<ConfirmDialogContextValue | null>(null);

let globalConfirmApi: ConfirmDialogContextValue | null = null;

export function getGlobalConfirmDialogApi(): ConfirmDialogContextValue | null {
  return globalConfirmApi;
}

export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [queue, setQueue] = useState<PendingPrompt[]>([]);
  const active = queue[0] ?? null;
  const open = active != null;

  const enqueue = useCallback((item: PendingPrompt) => {
    setQueue((prev) => [...prev, item]);
  }, []);

  const dequeue = useCallback(() => {
    setQueue((prev) => (prev.length <= 1 ? [] : prev.slice(1)));
  }, []);

  const confirm = useCallback(
    (options: ConfirmPromptOptions) =>
      new Promise<boolean>((resolve) => {
        enqueue({ kind: "confirm", options, resolve });
      }),
    [enqueue]
  );

  const alert = useCallback(
    (options: AlertPromptOptions) =>
      new Promise<void>((resolve) => {
        enqueue({ kind: "alert", options, resolve: () => resolve() });
      }),
    [enqueue]
  );

  const api = useRef<ConfirmDialogContextValue>({ confirm, alert });
  api.current = { confirm, alert };

  useEffect(() => {
    globalConfirmApi = api.current;
    return () => {
      globalConfirmApi = null;
    };
  }, [confirm, alert]);

  const finishConfirm = (accepted: boolean) => {
    if (active?.kind === "confirm") {
      active.resolve(accepted);
      dequeue();
    }
  };

  const finishAlert = () => {
    if (active?.kind === "alert") {
      active.resolve();
      dequeue();
    }
  };

  const title = active?.options.title ?? "";
  const body = active?.options.description ?? null;

  const actions: ConfirmDialogAction[] =
    active?.kind === "alert"
      ? [
          {
            label: active.options.confirmLabel ?? t("common.confirm"),
            variant: "primary",
            onClick: finishAlert,
          },
        ]
      : active?.kind === "confirm"
        ? [
            {
              label: active.options.cancelLabel ?? t("common.cancel"),
              variant: "outline",
              onClick: () => finishConfirm(false),
            },
            {
              label: active.options.confirmLabel ?? t("common.confirm"),
              variant: active.options.destructive ? "destructive" : "primary",
              onClick: () => finishConfirm(true),
            },
          ]
        : [];

  return (
    <ConfirmDialogContext.Provider value={api.current}>
      {children}
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          if (!next && active?.kind === "confirm") finishConfirm(false);
          else if (!next && active?.kind === "alert") finishAlert();
        }}
        title={title}
        actions={actions}
      >
        {body}
      </ConfirmDialog>
    </ConfirmDialogContext.Provider>
  );
}

export function useConfirmDialog(): ConfirmDialogContextValue {
  const ctx = useContext(ConfirmDialogContext);
  if (!ctx) {
    throw new Error("useConfirmDialog must be used within ConfirmDialogProvider");
  }
  return ctx;
}

/** 在非 React 回调中弹出 alert（无 Provider 时回退 window.alert） */
export async function showAlertDialog(options: AlertPromptOptions): Promise<void> {
  const api = globalConfirmApi;
  if (api) {
    await api.alert(options);
    return;
  }
  const text =
    typeof options.description === "string"
      ? options.description
      : options.title;
  window.alert(text);
}
