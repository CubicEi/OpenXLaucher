"use client";

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ExternalLink } from "lucide-react";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { isTauriRuntime } from "@/lib/tauri-runtime";
import { Button } from "@/components/ui/button";

interface RuntimeDependency {
  id: string;
  name: string;
  description: string;
  download_url: string;
}

interface RuntimeDependencyReport {
  ready: boolean;
  missing: RuntimeDependency[];
}

export function StartupRuntimeDependencyNotifier() {
  const [missing, setMissing] = useState<RuntimeDependency[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!isTauriRuntime()) return;

    let active = true;
    const check = async () => {
      try {
        const report = await invoke<RuntimeDependencyReport>("check_runtime_dependencies");
        if (!active || report.ready || report.missing.length === 0) return;
        const effectiveMissing = report.missing.filter((dep) => dep.id !== "webview2");
        if (effectiveMissing.length === 0) return;
        setMissing(effectiveMissing);
        setOpen(true);
      } catch (error) {
        console.error("运行时依赖检查失败:", error);
      }
    };

    void check();
    return () => {
      active = false;
    };
  }, []);

  const openDownload = async (url: string) => {
    try {
      await invoke("open_external", { url });
    } catch (error) {
      console.error("打开下载链接失败:", error);
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      title="缺少运行依赖"
      className="!max-w-lg"
      actions={[
        {
          label: "我知道了",
          variant: "primary",
          onClick: () => setOpen(false),
        },
      ]}
    >
      <p>
        当前为便携/免安装模式，以下组件需单独安装。安装完成后请重新启动 OpenXLauncher。
      </p>
      <ul className="mt-3 space-y-3">
        {missing.map((dep) => (
          <li
            key={dep.id}
            className="rounded-lg border border-border bg-muted/30 p-3 text-sm"
          >
            <p className="font-medium text-foreground">{dep.name}</p>
            <p className="mt-1 text-xs leading-relaxed">{dep.description}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2 gap-1.5"
              onClick={() => void openDownload(dep.download_url)}
            >
              <ExternalLink className="size-3.5" />
              打开下载页面
            </Button>
          </li>
        ))}
      </ul>
    </ConfirmDialog>
  );
}
