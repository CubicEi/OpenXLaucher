"use client";

import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@/lib/tauri-runtime";
import { mergeJavaScanIntoPathsConfig, type JavaInstallationInfo } from "@/lib/java-scan-merge";
import type { LauncherPathsConfig } from "@/types";

export function StartupJavaScan() {
  useEffect(() => {
    if (!isTauriRuntime()) return;

    const run = async () => {
      try {
        const results = await invoke<JavaInstallationInfo[]>("search_java_installations");
        const pathsCfg = await invoke<LauncherPathsConfig>("get_launcher_paths_config");
        const merged = mergeJavaScanIntoPathsConfig(pathsCfg, results);
        await invoke("save_launcher_paths_config", { config: merged });
      } catch {
        /* 静默扫描，失败不打扰用户 */
      }
    };

    void run();
  }, []);

  return null;
}
