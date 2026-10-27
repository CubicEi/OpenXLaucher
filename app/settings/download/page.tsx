"use client";

import { DownloadSection } from "@/components/settings/section-download";
import { useAnimRenderTrace } from "@/lib/animation-trace-hooks";

export default function SettingsDownloadPage() {
  useAnimRenderTrace("SettingsDownloadPage");
  return <DownloadSection />;
}
