"use client";

import { RouteErrorReport } from "@/components/debug/route-error-report";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteErrorReport scope="app" error={error} reset={reset} />;
}
