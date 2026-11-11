"use client";

import ModDetailContent from "./ModDetailContent";
import { Suspense, useEffect, useState } from "react";
import { useI18n } from "@/components/i18n/use-i18n";
import { parseModDetailProjectQuery } from "@/lib/mod-detail-query";

function ModDetailInner() {
  const { t } = useI18n();
  const [query, setQuery] = useState<ReturnType<typeof parseModDetailProjectQuery> | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined") {
      setQuery(parseModDetailProjectQuery(window.location.search));
    }
  }, []);

  if (!query) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <p>{t("download.detail.loadingPage")}</p>
      </div>
    );
  }

  if (!query.mod) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <p>{t("download.detail.selectModFirst")}</p>
      </div>
    );
  }

  return (
    <ModDetailContent
      modId={query.mod}
      source={query.source}
      mrProjectId={query.mrProjectId}
      cfProjectId={query.cfProjectId}
    />
  );
}

export default function ModDetailPage() {
  const { t } = useI18n();
  return (
    <Suspense fallback={<div className="flex flex-1 items-center justify-center text-muted-foreground"><p>{t("download.detail.loadingPage")}</p></div>}>
      <ModDetailInner />
    </Suspense>
  );
}
