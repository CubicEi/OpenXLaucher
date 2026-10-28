"use client";

import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { motion, type HTMLMotionProps } from "framer-motion";

import {
  pageEnterBlock,
  pageEnterContainer,
  pageEnterItem,
  prefersReducedMotion,
} from "@/lib/motion";
import { consumeSkipSectionChrome } from "@/lib/section-chrome-enter";
import { cn } from "@/lib/utils";

type PageEnterProps = {
  children: ReactNode;
  className?: string;
  /** Remount / re-run enter when this changes (e.g. pathname). */
  enterKey?: string | number;
  /** When true, stagger PageEnterItem children; otherwise float as one block. */
  stagger?: boolean;
  /**
   * Fill parent with absolute inset motion layer so translateY cannot expand
   * scroll height or break percentage-height / mt-auto descendants.
   * Use for full-pane shells (PageTransition, section content).
   */
  fill?: boolean;
} & Omit<HTMLMotionProps<"div">, "children" | "variants" | "initial" | "animate">;

/**
 * Route/content enter: CSS-hidden until layout settles, then bottom-up float
 * (optional stagger for PageEnterItem children).
 */
export function PageEnter({
  children,
  className,
  enterKey,
  stagger = true,
  fill = false,
  ...rest
}: PageEnterProps) {
  const [ready, setReady] = useState(false);
  const [reduce, setReduce] = useState(false);

  useLayoutEffect(() => {
    const reduced = prefersReducedMotion();
    setReduce(reduced);
    setReady(false);
    if (reduced) {
      setReady(true);
      return;
    }
    let cancelled = false;
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!cancelled) setReady(true);
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(id);
    };
  }, [enterKey]);

  if (reduce) {
    if (fill) {
      return (
        <div
          key={enterKey}
          className={cn("relative h-full min-h-0 overflow-hidden", className)}
        >
          <div
            data-page-enter=""
            data-enter-ready=""
            className="absolute inset-0 min-h-0"
          >
            {children}
          </div>
        </div>
      );
    }
    return (
      <div
        data-page-enter=""
        data-enter-ready=""
        className={cn(className)}
        key={enterKey}
      >
        {children}
      </div>
    );
  }

  const motionProps = {
    "data-page-enter": "" as const,
    ...(ready ? { "data-enter-ready": "" as const } : {}),
    variants: stagger ? pageEnterContainer : pageEnterBlock,
    initial: "initial" as const,
    animate: (ready ? "animate" : "initial") as "animate" | "initial",
    inherit: false as const,
    ...rest,
  };

  if (fill) {
    return (
      <div
        key={enterKey}
        className={cn("relative h-full min-h-0 overflow-hidden", className)}
      >
        <motion.div className="absolute inset-0 min-h-0" {...motionProps}>
          {children}
        </motion.div>
      </div>
    );
  }

  return (
    <motion.div key={enterKey} className={cn(className)} {...motionProps}>
      {children}
    </motion.div>
  );
}

/** null = not under chrome; true = play stagger; false = static (tab remount). */
const PageEnterChromeContext = createContext<boolean | null>(null);

type PageEnterItemProps = {
  children: ReactNode;
  className?: string;
} & Omit<HTMLMotionProps<"div">, "children" | "variants" | "initial" | "animate">;

/** Stagger child for PageEnter — place around cards / nav chips. */
export function PageEnterItem({
  children,
  className,
  ...rest
}: PageEnterItemProps) {
  const chromePlay = useContext(PageEnterChromeContext);
  const reduce = prefersReducedMotion();

  if (reduce || chromePlay === false) {
    return <div className={cn(className)}>{children}</div>;
  }

  // Under animating chrome: inherit parent stagger (no own animate).
  if (chromePlay === true) {
    return (
      <motion.div
        variants={pageEnterItem}
        className={cn(className)}
        {...rest}
      >
        {children}
      </motion.div>
    );
  }

  return (
    <motion.div
      variants={pageEnterItem}
      initial="initial"
      animate="animate"
      inherit={false}
      className={cn(className)}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

type PageEnterChromeProps = {
  children: ReactNode;
  className?: string;
  /** Shared-layout key from getPageTransitionKey (e.g. "/game-settings"). */
  sectionKey: string;
};

/** One-shot chrome stagger (tabs L→R or nav T→B) on section enter only. */
export function PageEnterChrome({
  children,
  className,
  sectionKey,
}: PageEnterChromeProps) {
  const [play] = useState(() => {
    if (typeof window === "undefined") return false;
    if (prefersReducedMotion()) return false;
    return !consumeSkipSectionChrome(sectionKey);
  });

  if (!play) {
    return (
      <PageEnterChromeContext.Provider value={false}>
        <div className={cn(className)} suppressHydrationWarning>
          {children}
        </div>
      </PageEnterChromeContext.Provider>
    );
  }

  return (
    <PageEnterChromeContext.Provider value={true}>
      <motion.div
        variants={pageEnterContainer}
        initial="initial"
        animate="animate"
        inherit={false}
        className={cn(className)}
        suppressHydrationWarning
      >
        {children}
      </motion.div>
    </PageEnterChromeContext.Provider>
  );
}
