"use client";

import { RouteErrorReport } from "@/components/debug/route-error-report";

export default function SettingsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteErrorReport scope="settings" error={error} reset={reset} />;
}
