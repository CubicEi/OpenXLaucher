"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { InstanceData } from "@/types";
import { appLog } from "@/lib/runtime-log";

interface UseInstancesReturn {
  instances: InstanceData[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

// 首页卸载与实例详情页挂载之间可能重叠。仅复用进行中的扫描：这样可以
// 消除首次跳转的并发读取，同时不会让之后的版本安装结果被长期缓存。
const inFlightInstanceScans = new Map<string, Promise<InstanceData[]>>();
const cachedInstancesByPath = new Map<string, InstanceData[]>();
const lastInstancesFetchAt = new Map<string, number>();
const INSTANCES_REFETCH_MIN_MS = 3000;

/** 清除实例扫描缓存，下次 refetch 会强制重新扫描 */
export function invalidateInstancesCache(instancesPath?: string) {
  if (instancesPath) {
    cachedInstancesByPath.delete(instancesPath);
    lastInstancesFetchAt.delete(instancesPath);
    inFlightInstanceScans.delete(instancesPath);
  } else {
    cachedInstancesByPath.clear();
    lastInstancesFetchAt.clear();
    inFlightInstanceScans.clear();
  }
}

function loadInstances(instancesPath: string): Promise<InstanceData[]> {
  const pending = inFlightInstanceScans.get(instancesPath);
  if (pending) return pending;

  const request = invoke<InstanceData[]>("vm_scan_instances", {
    instancesPath,
  });
  inFlightInstanceScans.set(instancesPath, request);

  void request.then(
    () => {
      if (inFlightInstanceScans.get(instancesPath) === request) {
        inFlightInstanceScans.delete(instancesPath);
      }
    },
    () => {
      if (inFlightInstanceScans.get(instancesPath) === request) {
        inFlightInstanceScans.delete(instancesPath);
      }
    },
  );

  return request;
}

/**
 * 扫描 instances 目录，返回所有实例的结构化信息。
 *
 * @param instancesPath  instances 目录的绝对路径（如 `<minecraftPath>/instance`）。
 *                       为空字符串或 undefined 时不发起请求。
 */
export function useInstances(instancesPath?: string): UseInstancesReturn {
  const [instances, setInstances] = useState<InstanceData[]>(() =>
    instancesPath ? cachedInstancesByPath.get(instancesPath) ?? [] : [],
  );
  const [loading, setLoading] = useState(() =>
    instancesPath ? !cachedInstancesByPath.has(instancesPath) : false,
  );
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const fetch = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (!instancesPath) {
      setInstances([]);
      setLoading(false);
      setError(null);
      return;
    }

    const hasCached = cachedInstancesByPath.has(instancesPath);
    const lastFetchAt = lastInstancesFetchAt.get(instancesPath) ?? 0;
    if (hasCached && Date.now() - lastFetchAt < INSTANCES_REFETCH_MIN_MS) {
      setInstances(cachedInstancesByPath.get(instancesPath) ?? []);
      setLoading(false);
      setError(null);
      return;
    }
    if (!hasCached) {
      setLoading(true);
    }
    setError(null);
    lastInstancesFetchAt.set(instancesPath, Date.now());
    try {
      const data = await loadInstances(instancesPath);
      cachedInstancesByPath.set(instancesPath, data);
      if (requestId === requestIdRef.current) {
        setInstances(data);
      }
    } catch (e) {
      appLog.error("instances", "vm_scan_instances failed", {
        instancesPath,
        error: String(e),
      });
      if (requestId === requestIdRef.current) {
        setError(String(e));
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [instancesPath]);

  useEffect(() => {
    void fetch();
    return () => {
      requestIdRef.current += 1;
    };
  }, [fetch]);

  return {
    instances,
    loading,
    error,
    refetch: () => {
      void fetch();
    },
  };
}
