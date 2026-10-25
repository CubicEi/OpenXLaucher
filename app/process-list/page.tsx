"use client";

import { ProcessListView } from "@/components/process-list/process-list-view";

export default function ProcessListPage() {
  return (
    <div className="h-full overflow-hidden" data-page-transition-root>
      <ProcessListView />
    </div>
  );
}
