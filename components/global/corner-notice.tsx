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
import { createPortal } from "react-dom";
import { AnimatePresence, motion, type Variants } from "framer-motion";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Loader2, X } from "lucide-react";

/** 启动器统一右下角通知（顶层 portal，切换页面不丢失）。 */
export type CornerNoticeVariant = "info" | "success" | "error";

export interface CornerNoticeItem {
  id: string;
  message: string;
  variant: CornerNoticeVariant;
  loading?: boolean;
  durationMs?: number;
}

export interface PushCornerNoticeInput {
  id?: string;
  message: string;
  variant: CornerNoticeVariant;
  loading?: boolean;
  /** 自动关闭毫秒；loading 中忽略。默认 5000。 */
  durationMs?: number;
}

interface CornerNoticeContextValue {
  pushNotice: (input: PushCornerNoticeInput) => string;
  dismissNotice: (id: string) => void;
}

const CornerNoticeContext = createContext<CornerNoticeContextValue | null>(null);

const DEFAULT_DISMISS_MS = 5000;

/** 自下而上浮入；旧弹窗靠 layout 被顶上去 */
const cornerNoticeFloatUp: Variants = {
  initial: { opacity: 0, y: 36, scale: 0.98 },
  animate: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { duration: 0.32, ease: [0.22, 1, 0.36, 1] },
  },
  exit: {
    opacity: 0,
    y: 12,
    scale: 0.98,
    transition: { duration: 0.18, ease: "easeIn" },
  },
};

const cornerNoticeLayoutTransition = {
  type: "spring" as const,
  stiffness: 420,
  damping: 32,
  mass: 0.8,
};

const variantClasses: Record<CornerNoticeVariant, string> = {
  info:
    "border-blue-500 bg-blue-50 dark:bg-blue-950/40 text-blue-900 dark:text-blue-100",
  success:
    "border-green-500 bg-green-50 dark:bg-green-950/40 text-green-900 dark:text-green-100",
  error:
    "border-red-500 bg-red-50 dark:bg-red-950/40 text-red-900 dark:text-red-100",
};

const dismissButtonClasses: Record<CornerNoticeVariant, string> = {
  info:
    "text-blue-700 hover:bg-blue-100 hover:text-blue-900 dark:text-blue-200 dark:hover:bg-blue-900/50",
  success:
    "text-green-700 hover:bg-green-100 hover:text-green-900 dark:text-green-200 dark:hover:bg-green-900/50",
  error:
    "text-red-700 hover:bg-red-100 hover:text-red-900 dark:text-red-200 dark:hover:bg-red-900/50",
};

function NoticeCard({
  notice,
  onDismiss,
}: {
  notice: CornerNoticeItem;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (notice.loading) return;
    const ms = notice.durationMs ?? DEFAULT_DISMISS_MS;
    if (ms <= 0) return;
    const timer = window.setTimeout(onDismiss, ms);
    return () => window.clearTimeout(timer);
  }, [notice.id, notice.loading, notice.durationMs, onDismiss]);

  return (
    <motion.div
      layout="position"
      variants={cornerNoticeFloatUp}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={{ layout: cornerNoticeLayoutTransition }}
      className={cn(
        "pointer-events-auto flex w-80 items-center gap-1.5 rounded-md border-2 px-2 py-1 text-xs shadow-lg",
        variantClasses[notice.variant]
      )}
    >
      {notice.loading ? (
        <Loader2 className="size-3 shrink-0 animate-spin" />
      ) : notice.variant === "success" ? (
        <CheckCircle2 className="size-3 shrink-0 text-green-600 dark:text-green-400" />
      ) : null}
      <p className="min-w-0 flex-1 leading-none">{notice.message}</p>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className={cn("-mr-0.5 size-3.5 shrink-0", dismissButtonClasses[notice.variant])}
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        <X className="size-2.5" />
      </Button>
    </motion.div>
  );
}

function CornerNoticeHost({
  notices,
  dismissNotice,
}: {
  notices: CornerNoticeItem[];
  dismissNotice: (id: string) => void;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[200] flex flex-col items-end justify-end gap-1.5"
      aria-live="polite"
    >
      {/* 数组末尾是最新：贴底出现，旧项 layout 上移 */}
      <AnimatePresence initial={false} mode="popLayout">
        {notices.map((notice) => (
          <NoticeCard
            key={notice.id}
            notice={notice}
            onDismiss={() => dismissNotice(notice.id)}
          />
        ))}
      </AnimatePresence>
    </div>,
    document.body
  );
}

export function CornerNoticeProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [notices, setNotices] = useState<CornerNoticeItem[]>([]);
  const idPrefix = useId();
  const idCounterRef = useRef(0);

  const dismissNotice = useCallback((id: string) => {
    setNotices((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const pushNotice = useCallback(
    (input: PushCornerNoticeInput): string => {
      const id =
        input.id ?? `${idPrefix}-notice-${++idCounterRef.current}`;
      const item: CornerNoticeItem = {
        id,
        message: input.message,
        variant: input.variant,
        loading: input.loading,
        durationMs: input.durationMs,
      };
      setNotices((prev) => {
        // 同内容（或同 id）的旧弹窗先关掉，再显示新的，便于重新播入场动画
        const next = prev.filter(
          (n) => n.id !== id && n.message !== item.message
        );
        return [...next, item];
      });
      return id;
    },
    [idPrefix]
  );

  useEffect(() => {
    const w = window as Window & { __rt_toast?: (value: string) => void };
    const previous = w.__rt_toast;
    w.__rt_toast = (message: string) => {
      const text = String(message ?? "").trim();
      if (!text) return;
      pushNotice({ message: text, variant: "info" });
    };
    return () => {
      if (w.__rt_toast && previous) w.__rt_toast = previous;
      else delete w.__rt_toast;
    };
  }, [pushNotice]);

  return (
    <CornerNoticeContext.Provider value={{ pushNotice, dismissNotice }}>
      {children}
      <CornerNoticeHost notices={notices} dismissNotice={dismissNotice} />
    </CornerNoticeContext.Provider>
  );
}

export function useCornerNotice() {
  const ctx = useContext(CornerNoticeContext);
  if (!ctx) {
    throw new Error("useCornerNotice must be used within CornerNoticeProvider");
  }
  return ctx;
}
