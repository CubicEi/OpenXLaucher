"use client";

import { AppearanceSection } from "@/components/settings/section-appearance";
import { SidebarConfigSection } from "@/components/settings/section-sidebar-config";
import { useAnimRenderTrace } from "@/lib/animation-trace-hooks";

export default function SettingsAppearancePage() {
  useAnimRenderTrace("SettingsAppearancePage");
  return (
    <>
      <AppearanceSection />
      <SidebarConfigSection />
    </>
  );
}
