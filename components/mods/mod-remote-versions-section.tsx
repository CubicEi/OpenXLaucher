"use client";

import React from "react";
import { RemoteVersionsSection } from "@/components/resources/remote-versions-section";
import type { ModInfo } from "@/components/resource-panel";

export function ModRemoteVersionsSection({
  fileName,
  info,
  instanceDir,
  modCacheDir,
  fileSide = "instance",
  mcVersion,
  modLoader,
  onInstalled,
}: {
  fileName: string;
  info: ModInfo;
  instanceDir: string;
  modCacheDir?: string;
  fileSide?: "instance" | "cache";
  mcVersion: string;
  modLoader: string;
  onInstalled: () => void;
}) {
  const storageRoot = fileSide === "cache" ? (modCacheDir || "") : instanceDir;
  const storageSubdir = fileSide === "cache" ? "" : undefined;

  return (
    <RemoteVersionsSection
      fileName={fileName}
      displayName={info.name || fileName}
      modId={info.mod_id}
      currentVersion={info.version}
      instanceDir={storageRoot}
      storageSubdir={storageSubdir}
      mcVersion={mcVersion}
      loader={modLoader}
      resourceKind="mod"
      onInstalled={onInstalled}
    />
  );
}
