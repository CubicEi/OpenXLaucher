"use client";

import React from "react";
import { Image as ImageIcon } from "lucide-react";
import { createResourcePage } from "@/components/resource-page-factory";
import {
  GAME_SETTINGS_RESOURCES_ICON_BG,
  GAME_SETTINGS_RESOURCES_ICON_TEXT,
} from "@/constants/index";

export default createResourcePage({
  title: "panel.resourcePacks",
  leftIcon: <ImageIcon className={`size-5 ${GAME_SETTINGS_RESOURCES_ICON_TEXT}`} />,
  leftIconBg: GAME_SETTINGS_RESOURCES_ICON_BG,
  leftIconColor: GAME_SETTINGS_RESOURCES_ICON_TEXT,
  instanceSubdir: "resourcepacks",
  cacheKind: "resourcepack",
  extensions: ["zip", "jar"],
  simplifyName: (name) => name.replace(/\.(zip|jar)$/i, ""),
  enableUpdates: true,
});
