"use client";

import React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RemoteVersionsSection } from "@/components/resources/remote-versions-section";
import type { ResourceKindWire } from "@/lib/resource-kind";
export function ResourceRemoteVersionsDialog({
  open,
  onOpenChange,
  fileName,
  displayName,
  instanceDir,
  mcVersion,
  loader,
  resourceKind,
  onInstalled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fileName: string | null;
  displayName: string;
  instanceDir: string;
  mcVersion: string;
  loader: string;
  resourceKind: ResourceKindWire;
  onInstalled: () => void;
}) {
  if (!fileName) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="truncate pr-6">{displayName}</DialogTitle>
        </DialogHeader>
        <RemoteVersionsSection
          fileName={fileName}
          displayName={displayName}
          instanceDir={instanceDir}
          mcVersion={mcVersion}
          loader={loader}
          resourceKind={resourceKind}
          onInstalled={onInstalled}
        />
        <p className="text-xs text-muted-foreground">{fileName}</p>
      </DialogContent>
    </Dialog>
  );
}
