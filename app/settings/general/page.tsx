"use client";

import { LanguageSection } from "@/components/settings/section-language";
import { UpdateEntrySection } from "@/components/settings/section-update-entry";
import { useAnimRenderTrace } from "@/lib/animation-trace-hooks";

export default function SettingsGeneralPage() {
  useAnimRenderTrace("SettingsGeneralPage");
  return (
    <>
      <LanguageSection />
      <UpdateEntrySection />
    </>
  );
}
