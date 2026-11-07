"use client";

import { LanguageSection } from "@/components/settings/section-language";
import { NetworkProxySection } from "@/components/settings/section-network-proxy";
import { UpdateEntrySection } from "@/components/settings/section-update-entry";
import { PageEnterItem } from "@/components/layout/page-enter";

export default function SettingsGeneralPage() {
  return (
    <>
      <PageEnterItem>
        <LanguageSection />
      </PageEnterItem>
      <PageEnterItem>
        <NetworkProxySection />
      </PageEnterItem>
      <PageEnterItem>
        <UpdateEntrySection />
      </PageEnterItem>
    </>
  );
}
