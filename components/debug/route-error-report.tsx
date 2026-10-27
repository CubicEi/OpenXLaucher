"use client";

import { useEffect } from "react";

import { animProbe } from "@/lib/anim-debug";
import { appLog } from "@/lib/runtime-log";

export function RouteErrorReport({
  scope,
  error,
  reset,
}: {
  scope: string;
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const stack = String(error?.stack ?? "").slice(0, 4000);
  const path = typeof window !== "undefined" ? window.location.href : "";

  useEffect(() => {
    const data = {
      scope,
      name: error?.name,
      message: String(error?.message ?? error),
      digest: error?.digest,
      path,
      stack,
    };
    appLog.error("route-error", "client exception", data);
    // #region agent log
    animProbe("F", `route-error:${scope}`, "client exception caught by error boundary", data);
    // #endregion
  }, [scope, error, path, stack]);

  return (
    <div className="h-full overflow-auto p-6 text-sm">
      <h2 className="mb-2 text-base font-semibold text-destructive">
        页面出错（{scope}）
      </h2>
      <p className="mb-1 break-all font-medium">
        {error?.name}: {String(error?.message ?? error)}
      </p>
      <p className="mb-3 break-all text-xs text-muted-foreground">{path}</p>
      <pre className="mb-4 max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">
        {stack || "(no stack)"}
      </pre>
      <button
        type="button"
        className="rounded-md border px-3 py-1.5 text-xs"
        onClick={() => reset()}
      >
        重试
      </button>
    </div>
  );
}
