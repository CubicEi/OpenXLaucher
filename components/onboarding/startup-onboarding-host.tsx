"use client";

import dynamic from "next/dynamic";

/** 客户端动态加载，避免根 layout 静态图过大导致 Windows 构建栈溢出。 */
const StartupOnboarding = dynamic(
  () =>
    import("@/components/onboarding/startup-onboarding").then((m) => m.StartupOnboarding),
  { ssr: false, loading: () => null },
);

export function StartupOnboardingHost() {
  return <StartupOnboarding />;
}
