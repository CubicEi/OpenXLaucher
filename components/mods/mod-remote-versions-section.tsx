"use client";

import React from "react";
import { RemoteVersionsSection } from "@/components/resources/remote-versions-section";
import type { ModInfo } from "@/components/resource-panel";

export function ModRemoteVersionsSection({
  fileName,
  info,
  instanceDir,
  mcVersion,
  modLoader,
  onInstalled,
}: {
  fileName: string;
  info: ModInfo;
  instanceDir: string;
  mcVersion: string;
  modLoader: string;
  onInstalled: () => void;
}) {
  return (
    <RemoteVersionsSection
      fileName={fileName}
      displayName={info.name || fileName}
      modId={info.mod_id}
      currentVersion={info.version}
      instanceDir={instanceDir}
      mcVersion={mcVersion}
      loader={modLoader}
      resourceKind="mod"
      onInstalled={onInstalled}
    />
  );
}
