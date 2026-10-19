"use client";

import React from "react";
import { Sun } from "lucide-react";
import { createResourcePage } from "@/components/resource-page-factory";

export default createResourcePage({
  title: "panel.shaders",
  leftIcon: <Sun className="size-5 text-amber-500" />,
  leftIconBg: "bg-amber-500/10",
  leftIconColor: "text-amber-500",
  instanceSubdir: "shaderpacks",
  cacheKind: "shaderpack",
  extensions: ["zip", "jar"],
  simplifyName: (name) => name.replace(/\.(zip|jar)$/i, ""),
});
