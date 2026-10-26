"use client";

import { AppearanceSection } from "@/components/settings/section-appearance";
import { SidebarConfigSection } from "@/components/settings/section-sidebar-config";

export default function SettingsAppearancePage() {
  return (
    <>
      <AppearanceSection />
      <SidebarConfigSection />
    </>
  );
}
