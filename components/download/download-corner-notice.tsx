"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Loader2, X } from "lucide-react";
import { fadeSlideUp } from "@/lib/motion";

export type DownloadCornerNoticeVariant = "info" | "error";

export interface DownloadCornerNoticeItem {
  id: string;
  message: string;
  variant: DownloadCornerNoticeVariant;
  loading?: boolean;
}

export interface PushDownloadCornerNoticeInput {
  id?: string;
  message: string;
  variant: DownloadCornerNoticeVariant;
  loading?: boolean;
}

interface DownloadCornerNoticeContextValue {
  pushNotice: (input: PushDownloadCornerNoticeInput) => string;
  dismissNotice: (id: string) => void;
}

const DownloadCornerNoticeContext =
  createContext<DownloadCornerNoticeContextValue | null>(null);

const ERROR_AUTO_DISMISS_MS = 5000;

const variantClasses: Record<DownloadCornerNoticeVariant, string> = {
  info:
    "border-blue-500 bg-blue-50 dark:bg-blue-950/40 text-blue-900 dark:text-blue-100",
  error:
    "border-red-500 bg-red-50 dark:bg-red-950/40 text-red-900 dark:text-red-100",
};

function NoticeCard({
  notice,
  onDismiss,
}: {
  notice: DownloadCornerNoticeItem;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (notice.variant !== "error") return;
    const timer = window.setTimeout(onDismiss, ERROR_AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [notice.id, notice.variant, onDismiss]);

  return (
    <motion.div
      layout
      variants={fadeSlideUp}
      initial="initial"
      animate="animate"
      exit="exit"
      className={cn(
        "pointer-events-auto flex w-80 items-start gap-2 rounded-xl border-2 px-3 py-2.5 text-xs shadow-lg",
        variantClasses[notice.variant]
      )}
    >
      {notice.loading ? (
        <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" />
      ) : null}
      <p className="min-w-0 flex-1 leading-snug">{notice.message}</p>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className={cn(
          "size-5 shrink-0",
          notice.variant === "info"
            ? "text-blue-700 hover:bg-blue-100 hover:text-blue-900 dark:text-blue-200 dark:hover:bg-blue-900/50"
            : "text-red-700 hover:bg-red-100 hover:text-red-900 dark:text-red-200 dark:hover:bg-red-900/50"
        )}
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        <X className="size-3" />
      </Button>
    </motion.div>
  );
}

export function DownloadCornerNoticeHost({
  notices,
  dismissNotice,
}: {
  notices: DownloadCornerNoticeItem[];
  dismissNotice: (id: string) => void;
}) {
  if (notices.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col-reverse items-end gap-2"
      aria-live="polite"
    >
      <AnimatePresence initial={false}>
        {notices.map((notice) => (
          <NoticeCard
            key={notice.id}
            notice={notice}
            onDismiss={() => dismissNotice(notice.id)}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}

export function DownloadCornerNoticeProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [notices, setNotices] = useState<DownloadCornerNoticeItem[]>([]);
  const idPrefix = useId();
  const idCounterRef = useRef(0);

  const dismissNotice = useCallback((id: string) => {
    setNotices((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const pushNotice = useCallback(
    (input: PushDownloadCornerNoticeInput): string => {
      const id =
        input.id ??
        `${idPrefix}-notice-${++idCounterRef.current}`;
      const item: DownloadCornerNoticeItem = {
        id,
        message: input.message,
        variant: input.variant,
        loading: input.loading,
      };
      setNotices((prev) => {
        const index = prev.findIndex((n) => n.id === id);
        if (index === -1) return [...prev, item];
        const next = [...prev];
        next[index] = item;
        return next;
      });
      return id;
    },
    [idPrefix]
  );

  return (
    <DownloadCornerNoticeContext.Provider value={{ pushNotice, dismissNotice }}>
      {children}
      <DownloadCornerNoticeHost notices={notices} dismissNotice={dismissNotice} />
    </DownloadCornerNoticeContext.Provider>
  );
}

export function useDownloadCornerNotice() {
  const ctx = useContext(DownloadCornerNoticeContext);
  if (!ctx) {
    throw new Error(
      "useDownloadCornerNotice must be used within DownloadCornerNoticeProvider"
    );
  }
  return ctx;
}
