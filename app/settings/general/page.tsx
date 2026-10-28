"use client";

import { LanguageSection } from "@/components/settings/section-language";
import { UpdateEntrySection } from "@/components/settings/section-update-entry";
import { PageEnterItem } from "@/components/layout/page-enter";

export default function SettingsGeneralPage() {
  return (
    <>
      <PageEnterItem>
        <LanguageSection />
      </PageEnterItem>
      <PageEnterItem>
        <UpdateEntrySection />
      </PageEnterItem>
    </>
  );
}
