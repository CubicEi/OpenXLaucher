"use client";

import { AppearanceSection } from "@/components/settings/section-appearance";
import { SidebarConfigSection } from "@/components/settings/section-sidebar-config";
import { PageEnterItem } from "@/components/layout/page-enter";

export default function SettingsAppearancePage() {
  return (
    <>
      <PageEnterItem>
        <AppearanceSection />
      </PageEnterItem>
      <PageEnterItem>
        <SidebarConfigSection />
      </PageEnterItem>
    </>
  );
}
