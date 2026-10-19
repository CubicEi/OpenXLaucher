"use client";

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useDownloadManager } from "@/components/download/download-provider";

/**
 * 全局拖放处理组件
 * 支持在任何页面拖入整合包文件进行安装
 */
export function GlobalDragDrop() {
  const [isDragOver, setIsDragOver] = useState(false);
  const { startModpackDownload } = useDownloadManager();

  // 全局拖放处理
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const handleGlobalDrop = async (paths: string[]) => {
      if (!paths || paths.length === 0) return;
      
      for (const path of paths) {
        // 检查是否是整合包文件
        if (path.match(/\.(zip|mrpack|jar)$/i)) {
          try {
            // 从路径中提取文件名作为整合包名称
            const modpackName = path.split(/[\\/]/).pop()?.replace(/\.(zip|mrpack|jar)$/i, "") || "未知整合包";
            
            // 使用下载管理器启动整合包安装，这样会自动添加到下载任务栏
            const taskId: number = await startModpackDownload(modpackName, path);
            
            console.log(`整合包安装任务已启动，ID: ${taskId}`);
          } catch (error) {
            console.error(`整合包安装失败: ${error}`);
          }
        }
      }
    };

    (async () => {
      try {
        const { getCurrentWebviewWindow } = await import(
          "@tauri-apps/api/webviewWindow"
        );
        const w = getCurrentWebviewWindow();
        
        // 监听全局拖放事件
        const fn = await w.onDragDropEvent(async (event) => {
          if (event.payload.type === "over") {
            setIsDragOver(true);
          } else if (event.payload.type === "leave") {
            setIsDragOver(false);
          } else if (event.payload.type === "drop") {
            setIsDragOver(false);
            await handleGlobalDrop(event.payload.paths);
          }
        });
        unlisten = fn;
      } catch {
        // 非 Tauri 环境忽略
      }
    })();

    return () => {
      unlisten?.();
    };
  }, []);

  return (
    <>      
      {/* 全局拖放覆盖层 */}
      {isDragOver && (
        <div className="fixed inset-0 z-50 bg-primary/20 border-4 border-dashed border-primary flex items-center justify-center pointer-events-none">
          <div className="text-center p-8 bg-card rounded-lg shadow-lg">
            <p className="text-lg font-medium mb-2">拖放整合包文件</p>
            <p className="text-sm text-muted-foreground">.zip / .mrpack / .jar 格式</p>
          </div>
        </div>
      )}
    </>
  );
}