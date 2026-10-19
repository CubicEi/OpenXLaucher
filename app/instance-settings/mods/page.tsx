"use client";

import React from "react";
import { Puzzle, Package, Folder } from "lucide-react";
import { createResourcePage } from "@/components/resource-page-factory";

export default createResourcePage({
  title: "panel.mods",
  leftIcon: <Puzzle className="size-5 text-emerald-500" />,
  leftIconBg: "bg-emerald-500/10",
  leftIconColor: "text-emerald-500",
  instanceSubdir: "mods",
  cacheKind: "mod",
  needsModLoader: true,
  versionSource: "instance",
  extensions: ["jar", "litemod", "zip"],
  simplifyName: (name) => name.replace(/\.(jar|litemod|zip)$/i, ""),
  rightIcon: <Folder className="size-5 text-sky-500" />,
  rightIconBg: "bg-sky-500/10",
});
