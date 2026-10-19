"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { blobToBase64 } from "@/lib/file-utils";

export interface ModDependency {
  mod_id: string;
  version_range?: string | null;
  mandatory: boolean;
  ordering?: string | null;
  side?: string | null;
}

export interface ModInfo {
  file_name: string;
  mod_id: string;
  name: string;
  version: string;
  description?: string | null;
  authors: string[];
  license?: string | null;
  icon?: string | null;
  source?: string | null;
  homepage?: string | null;
  issues?: string | null;
  minecraft_version?: string | null;
  mod_loader?: string | null;
  dependencies: ModDependency[];
  optional_dependencies: ModDependency[];
  incompatible_dependencies: ModDependency[];
}

type ResourceEntry = {
  name: string;
  is_dir: boolean;
  extension: string;
  size: number;
};

export type ResourceFile = {
  name: string;
  size: number;
  isDir?: boolean;
};

function isMissingDirectoryError(error: unknown) {
  const message = String(error).toLowerCase();
  return message.includes("not found") || message.includes("系统找不到");
}

/**
 * 通用的资源管理 hook - 管理两列资源
 *
 * 左列：当前实例中的文件
 * 右列：cache 中对应版本/加载器的文件（未加入实例）
 *
 * @param instanceDir 实例目录绝对路径
 * @param instanceSubdir 实例子目录名（如 "mods"、"resourcepacks"）
 * @param cacheKind cache 资源类型标识（如 "mod"、"resourcepack"、"shaderpack"、"world"、"datapack"）
 * @param mcVersion 当前实例的 Minecraft 版本
 * @param modLoader 当 cacheKind === "mod" 时需要传加载器类型
 * @param extensions 文件扩展名过滤（小写，不含点）
 */
export function useResourceManager(
  instanceDir: string | undefined,
  instanceSubdir: string,
  cacheKind: string,
  mcVersion: string | undefined,
  modLoader: string | undefined,
  extensions: string[] = [],
  directoryNavigation = false,
): {
  // 实例中的文件
  instanceFiles: ResourceFile[];
  instanceLoading: boolean;
  instanceError: string | null;

  // cache 中的文件（对应当前版本/加载器）
  cacheFiles: ResourceFile[];
  cacheLoading: boolean;
  cacheError: string | null;

  // 模组元数据缓存（文件名 -> ModInfo）
  instanceModInfo: Map<string, ModInfo>;
  cacheModInfo: Map<string, ModInfo>;
  modsParsing: boolean;

  // 操作
  addToInstance: (fileName: string) => Promise<void>;
  removeFromInstance: (fileName: string) => Promise<void>;
  deleteFromInstance: (fileName: string) => Promise<void>;
  deleteFromCache: (fileName: string) => Promise<void>;
  renameInInstance: (oldName: string, newName: string) => Promise<void>;
  uploadFiles: () => Promise<void>;
  refresh: () => void;
  openInstanceDirectory: (directoryName: string) => void;
  goToParentInstanceDirectory: () => void;
  instanceDirectoryPath: string[];

  // 搜索
  instanceSearch: string;
  setInstanceSearch: (s: string) => void;
  cacheSearch: string;
  setCacheSearch: (s: string) => void;

  // 过滤后的结果
  filteredInstanceFiles: ResourceFile[];
  filteredCacheFiles: ResourceFile[];
} {
  // 页面配置通常以字面量数组传入扩展名。根据内容稳定化它，避免该数组的
  // 新引用让读取回调在每次 state 更新后发生变化。
  const extensionsKey = extensions.join(",");
  const stableExtensions = useMemo(
    () => (extensionsKey ? extensionsKey.split(",") : []),
    [extensionsKey],
  );

  // 实例中的文件 - 使用 vm_list_dir
  const directoryRootKey = `${instanceDir ?? ""}\u0000${instanceSubdir}`;
  const [directoryLocation, setDirectoryLocation] = useState<{
    rootKey: string;
    segments: string[];
  }>({ rootKey: directoryRootKey, segments: [] });
  const instanceDirectoryPath = directoryLocation.rootKey === directoryRootKey
    ? directoryLocation.segments
    : [];
  const currentInstanceSubdir = [instanceSubdir, ...instanceDirectoryPath].join("/");

  // 实例中的文件
  const [instanceFiles, setInstanceFiles] = useState<ResourceFile[]>([]);
  const [instanceLoading, setInstanceLoading] = useState(false);
  const [instanceError, setInstanceError] = useState<string | null>(null);

  // 使用 ref 来存储最新的 instanceFiles，避免依赖循环
  const instanceFilesRef = useRef(instanceFiles);
  useEffect(() => {
    instanceFilesRef.current = instanceFiles;
  }, [instanceFiles]);

  // cache 中的文件
  const [cacheFiles, setCacheFiles] = useState<ResourceFile[]>([]);
  const [cacheLoading, setCacheLoading] = useState(false);
  const [cacheError, setCacheError] = useState<string | null>(null);

  // 模组元数据缓存
  const [instanceModInfo, setInstanceModInfo] = useState<Map<string, ModInfo>>(new Map());
  const [cacheModInfo, setCacheModInfo] = useState<Map<string, ModInfo>>(new Map());
  const [modsParsing, setModsParsing] = useState(false);

  // 搜索
  const [instanceSearch, setInstanceSearch] = useState("");
  const [cacheSearch, setCacheSearch] = useState("");
  const instanceRequestIdRef = useRef(0);

  const parseModMetadata = useCallback(
    async (
      fileNames: string[],
      dirBase: string,
    ): Promise<Map<string, ModInfo>> => {
      if (!cacheKind || fileNames.length === 0) {
        return new Map();
      }
      try {
        const paths = fileNames.map((n) => `${dirBase}/${n}`);
        const results: [string, ModInfo | null][] = await invoke("parse_mods", {
          files: paths,
        });
        const map = new Map<string, ModInfo>();
        for (const [path, info] of results) {
          if (info) {
            // 从完整路径提取文件名作为 key
            const fileName = path.split(/[\\/]/).pop() || path;
            map.set(fileName, info);
          }
        }
        return map;
      } catch (e) {
        console.warn("解析模组元数据失败:", e);
        return new Map();
      }
    },
    [cacheKind],
  );

  const fetchInstanceFiles = useCallback(async () => {
    const requestId = ++instanceRequestIdRef.current;
    if (!instanceDir) {
      setInstanceFiles([]);
      return;
    }
    setInstanceLoading(true);
    setInstanceError(null);
    try {
      const dir = `${instanceDir}/${currentInstanceSubdir}`;
      const entries: ResourceEntry[] =
        await invoke("vm_list_dir", { dirPath: dir, extensionsFilter: stableExtensions });
      // 存档本身是目录；支持目录导航的页面也需要保留目录条目。
      const filtered = cacheKind === "world" || directoryNavigation
        ? entries
        : entries.filter((e) => !e.is_dir);
      const sorted = filtered
        .map((e) => ({ name: e.name, size: e.size, isDir: e.is_dir }))
        .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
      if (requestId !== instanceRequestIdRef.current) return;
      setInstanceFiles(sorted);

      // 当是模组目录时，批量解析元数据（任何 ZIP 格式的文件都能解析：.jar / .litemod / .zip）
      if (cacheKind === "mod" && sorted.length > 0) {
        setModsParsing(true);
        try {
          const modFiles = sorted.filter((f) => {
            const lower = f.name.toLowerCase();
            return lower.endsWith(".jar") || lower.endsWith(".litemod") || lower.endsWith(".zip");
          });
          const infoMap = await parseModMetadata(
            modFiles.map((f) => f.name),
            dir.replace(/\\/g, "/"),
          );
          if (requestId === instanceRequestIdRef.current) {
            setInstanceModInfo(infoMap);
          }
        } finally {
          setModsParsing(false);
        }
      }
    } catch (error: unknown) {
      if (isMissingDirectoryError(error)) {
        if (requestId === instanceRequestIdRef.current) {
          setInstanceFiles([]);
        }
      } else {
        if (requestId === instanceRequestIdRef.current) {
          setInstanceError(String(error));
          setInstanceFiles([]);
        }
      }
    } finally {
      if (requestId === instanceRequestIdRef.current) {
        setInstanceLoading(false);
      }
    }
  }, [
    instanceDir,
    currentInstanceSubdir,
    stableExtensions,
    cacheKind,
    directoryNavigation,
    parseModMetadata,
  ]);

  const fetchCacheFiles = useCallback(async () => {
    if (!mcVersion) {
      setCacheFiles([]);
      return;
    }
    setCacheLoading(true);
    setCacheError(null);
    try {
      let names: string[] = [];
      let cacheDirBase: string | null = null;

      if (cacheKind === "mod") {
        const loader = modLoader || "forge";
        names = await invoke("list_cached_mods", {
          mcVersion: mcVersion,
          modLoader: loader,
        });
        // 通过命令获取 cache 根目录
        try {
          const root: string = await invoke("get_mod_cache_dir_cmd", {
            mcVersion: mcVersion,
            modLoader: loader,
          });
          cacheDirBase = root.replace(/\\/g, "/");
        } catch {
          cacheDirBase = null;
        }
      } else {
        names = await invoke("list_cached_files", {
          kind: cacheKind,
          mcVersion: mcVersion,
        });
      }

      // 过滤掉已存在于实例中的文件 - 使用 ref 来获取最新的 instanceFiles
      setCacheFiles(() => {
        const instanceNames = new Set(instanceFilesRef.current.map((f) => f.name));
        const unique = names.filter((n) => !instanceNames.has(n));
        const sorted = unique
          .map((n) => ({ name: n, size: 0 }))
          .sort((a, b) => a.name.localeCompare(b.name));

        // 当是模组目录时，批量解析元数据（任何 ZIP 格式的文件都能解析：.jar / .litemod / .zip）
        if (cacheKind === "mod" && sorted.length > 0 && cacheDirBase) {
          setModsParsing(true);
          (async () => {
            try {
              const modFiles = sorted.filter((f) => {
                const lower = f.name.toLowerCase();
                return lower.endsWith(".jar") || lower.endsWith(".litemod") || lower.endsWith(".zip");
              });
              const infoMap = await parseModMetadata(
                modFiles.map((f) => f.name),
                cacheDirBase,
              );
              setCacheModInfo(infoMap);
            } finally {
              setModsParsing(false);
            }
          })();
        }

        return sorted;
      });
    } catch (error: unknown) {
      if (isMissingDirectoryError(error)) {
        setCacheFiles([]);
      } else {
        setCacheError(String(error));
        setCacheFiles([]);
      }
    } finally {
      setCacheLoading(false);
    }
  }, [cacheKind, mcVersion, modLoader, parseModMetadata]);

  // 使用 ref 来存储 fetch 函数，避免依赖循环
  const fetchInstanceFilesRef = useRef(fetchInstanceFiles);
  const fetchCacheFilesRef = useRef(fetchCacheFiles);

  useEffect(() => {
    fetchInstanceFilesRef.current = fetchInstanceFiles;
  }, [fetchInstanceFiles]);

  useEffect(() => {
    fetchCacheFilesRef.current = fetchCacheFiles;
  }, [fetchCacheFiles]);

  const addToInstance = useCallback(
    async (fileName: string) => {
      if (!instanceDir || !mcVersion) return;
      await invoke("cache_to_instance", {
        kind: cacheKind,
        mcVersion: mcVersion,
        modLoader: cacheKind === "mod" ? (modLoader || null) : null,
        fileName: fileName,
        instanceDir: instanceDir,
        instanceSubdir: currentInstanceSubdir,
      });
      fetchInstanceFilesRef.current();
      fetchCacheFilesRef.current();
    },
    [instanceDir, mcVersion, cacheKind, modLoader, currentInstanceSubdir],
  );

  const removeFromInstance = useCallback(
    async (fileName: string) => {
      if (!instanceDir || !mcVersion) return;
      await invoke("instance_to_cache", {
        kind: cacheKind,
        mcVersion: mcVersion,
        modLoader: cacheKind === "mod" ? (modLoader || null) : null,
        fileName: fileName,
        instanceDir: instanceDir,
        instanceSubdir: currentInstanceSubdir,
      });
      fetchInstanceFilesRef.current();
      fetchCacheFilesRef.current();
    },
    [instanceDir, mcVersion, cacheKind, modLoader, currentInstanceSubdir],
  );

  const deleteFromInstance = useCallback(
    async (fileName: string) => {
      if (!instanceDir) return;
      const dir = `${instanceDir}/${currentInstanceSubdir}`;
      await invoke("vm_delete_file", { dirPath: dir, fileName });
      fetchInstanceFilesRef.current();
    },
    [instanceDir, currentInstanceSubdir],
  );

  const deleteFromCache = useCallback(
    async (fileName: string) => {
      if (!mcVersion) return;
      await invoke("vm_delete_cached_file", {
        kind: cacheKind,
        mcVersion: mcVersion,
        modLoader: cacheKind === "mod" ? (modLoader || null) : null,
        fileName,
      });
      fetchCacheFilesRef.current();
    },
    [cacheKind, mcVersion, modLoader],
  );

  const renameInInstance = useCallback(
    async (oldName: string, newName: string) => {
      if (!instanceDir) return;
      const dir = `${instanceDir}/${currentInstanceSubdir}`;
      await invoke("vm_rename_file", { dirPath: dir, oldName, newName });
      fetchInstanceFilesRef.current();
    },
    [instanceDir, currentInstanceSubdir],
  );

  const uploadFiles = useCallback(async () => {
    if (!instanceDir) return;
    
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    if (stableExtensions.length > 0) {
      input.accept = stableExtensions.map(e => `.${e}`).join(',');
    }
    input.style.display = 'none';
    
    document.body.appendChild(input);
    
    return new Promise<void>((resolve, reject) => {
      input.addEventListener('change', async (e) => {
        const files = (e.target as HTMLInputElement).files;
        if (!files || files.length === 0) {
          document.body.removeChild(input);
          resolve();
          return;
        }

        try {
          const targetDir = `${instanceDir}/${currentInstanceSubdir}`;
          for (const file of Array.from(files)) {
            const base64 = await blobToBase64(file);
            await invoke("vm_write_file_base64", {
              dirPath: targetDir,
              fileName: file.name,
              contentBase64: base64,
            });
          }

          fetchInstanceFilesRef.current();
          fetchCacheFilesRef.current();
          resolve();
        } catch (error) {
          reject(error);
        } finally {
          document.body.removeChild(input);
        }
      });
      
      input.click();
    });
  }, [instanceDir, currentInstanceSubdir, stableExtensions]);

  const refresh = useCallback(() => {
    fetchInstanceFilesRef.current();
    fetchCacheFilesRef.current();
  }, []);

  const openInstanceDirectory = useCallback(
    (directoryName: string) => {
      if (!directoryNavigation) return;
      setDirectoryLocation((current) => {
        const segments = current.rootKey === directoryRootKey ? current.segments : [];
        return { rootKey: directoryRootKey, segments: [...segments, directoryName] };
      });
      setInstanceSearch("");
    },
    [directoryNavigation, directoryRootKey],
  );

  const goToParentInstanceDirectory = useCallback(() => {
    if (!directoryNavigation) return;
    setDirectoryLocation((current) => {
      const segments = current.rootKey === directoryRootKey ? current.segments : [];
      return { rootKey: directoryRootKey, segments: segments.slice(0, -1) };
    });
    setInstanceSearch("");
  }, [directoryNavigation, directoryRootKey]);

  // 初始化加载 - 使用 ref 避免依赖循环
  useEffect(() => {
    if (instanceDir) {
      void fetchInstanceFilesRef.current();
    }
  }, [instanceDir, currentInstanceSubdir]);

  useEffect(() => {
    if (mcVersion) {
      void fetchCacheFilesRef.current();
    }
  }, [mcVersion]);

  // 过滤结果 - 同时搜索文件名和模组名称
  const filteredInstanceFiles = useMemo(() => {
    if (!instanceSearch) return instanceFiles;
    const q = instanceSearch.toLowerCase();
    return instanceFiles.filter((f) => {
      if (f.name.toLowerCase().includes(q)) return true;
      const info = instanceModInfo.get(f.name);
      if (info && (info.name.toLowerCase().includes(q) || info.mod_id.toLowerCase().includes(q))) {
        return true;
      }
      return false;
    });
  }, [instanceFiles, instanceSearch, instanceModInfo]);

  const filteredCacheFiles = useMemo(() => {
    if (!cacheSearch) return cacheFiles;
    const q = cacheSearch.toLowerCase();
    return cacheFiles.filter((f) => {
      if (f.name.toLowerCase().includes(q)) return true;
      const info = cacheModInfo.get(f.name);
      if (info && (info.name.toLowerCase().includes(q) || info.mod_id.toLowerCase().includes(q))) {
        return true;
      }
      return false;
    });
  }, [cacheFiles, cacheSearch, cacheModInfo]);

  return {
    instanceFiles,
    instanceLoading,
    instanceError,
    cacheFiles,
    cacheLoading,
    cacheError,
    instanceModInfo,
    cacheModInfo,
    modsParsing,
    addToInstance,
    removeFromInstance,
    deleteFromInstance,
    deleteFromCache,
    renameInInstance,
    uploadFiles,
    refresh,
    openInstanceDirectory,
    goToParentInstanceDirectory,
    instanceDirectoryPath,
    instanceSearch,
    setInstanceSearch,
    cacheSearch,
    setCacheSearch,
    filteredInstanceFiles,
    filteredCacheFiles,
  };
}
