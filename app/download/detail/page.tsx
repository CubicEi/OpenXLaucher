"use client";

import ModDetailContent from "./ModDetailContent";
import { Suspense, useEffect, useState } from "react";
import { useI18n } from "@/components/i18n/use-i18n";

function ModDetailInner() {
  const { t } = useI18n();
  const [modId, setModId] = useState<string>("");

  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const mod = params.get("mod") || "";
      if (mod) setModId(mod);
    }
  }, []);

  if (!modId) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <p>{t("download.detail.selectModFirst")}</p>
      </div>
    );
  }
  return <ModDetailContent modId={modId} />;
}

export default function ModDetailPage() {
  const { t } = useI18n();
  return (
    <Suspense fallback={<div className="flex flex-1 items-center justify-center text-muted-foreground"><p>{t("download.detail.loadingPage")}</p></div>}>
      <ModDetailInner />
    </Suspense>
  );
}