"use client";

import { RouteErrorReport } from "@/components/debug/route-error-report";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="zh-CN">
      <body>
        <RouteErrorReport scope="global" error={error} reset={reset} />
      </body>
    </html>
  );
}
