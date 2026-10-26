"use client";

import { LanguageSection } from "@/components/settings/section-language";
import { UpdateEntrySection } from "@/components/settings/section-update-entry";

export default function SettingsGeneralPage() {
  return (
    <>
      <LanguageSection />
      <UpdateEntrySection />
    </>
  );
}
