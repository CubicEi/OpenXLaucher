import type { LauncherPathsConfig } from "@/types";

export type JavaInstallationInfo = {
  path: string;
  version: string;
  major_version: number;
  vendor: string;
  architecture: string;
  java_type: string;
};

export function mergeJavaScanIntoPathsConfig(
  pathsCfg: LauncherPathsConfig,
  results: JavaInstallationInfo[],
): LauncherPathsConfig {
  const installations: Record<string, JavaInstallationInfo> = {
    ...(pathsCfg.java_installations ?? {}),
  };

  for (const oldPath of pathsCfg.java_paths) {
    const existing = pathsCfg.java_installations?.[oldPath];
    if (existing) {
      installations[oldPath] = existing as JavaInstallationInfo;
    }
  }

  for (const r of results) {
    if (!pathsCfg.java_paths.includes(r.path) || !pathsCfg.java_installations?.[r.path]) {
      installations[r.path] = r;
    }
  }

  const newPaths = [...new Set([...pathsCfg.java_paths, ...results.map((r) => r.path)])];

  return {
    ...pathsCfg,
    java_paths: newPaths,
    java_installations: installations,
  };
}
