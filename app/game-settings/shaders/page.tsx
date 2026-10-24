"use client";

import React from "react";
import { Sparkles } from "lucide-react";
import { createResourcePage } from "@/components/resource-page-factory";

export default createResourcePage({
  title: "panel.shaders",
  leftIcon: <Sparkles className="size-5 text-violet-600 dark:text-violet-400" />,
  leftIconBg: "bg-violet-500/10",
  leftIconColor: "text-violet-600 dark:text-violet-400",
  instanceSubdir: "shaderpacks",
  cacheKind: "shaderpack",
  extensions: ["zip", "jar"],
  simplifyName: (name) => name.replace(/\.(zip|jar)$/i, ""),
  enableUpdates: true,
});
