"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import type { SidebarTabConfig, UIConfig } from "@/types";

/** 默认侧边栏标签页配置 */
const DEFAULT_SIDEBAR_TABS: SidebarTabConfig[] = [
  { id: "home", name: "首页", visible: true, canHide: false, order: 0 },
  { id: "game-settings", name: "游戏设置", visible: true, canHide: true, order: 1 },
  { id: "launch", name: "启动", visible: true, canHide: false, order: 2 },
  { id: "download", name: "下载", visible: true, canHide: true, order: 3 },
  { id: "multiplayer", name: "联机", visible: true, canHide: true, order: 4 },
  { id: "tools", name: "工具", visible: true, canHide: true, order: 5 },
  { id: "settings", name: "设置", visible: true, canHide: false, order: 6 },
];

/** 默认UI配置 */
const DEFAULT_UI_CONFIG: UIConfig = {
  sidebarTabs: DEFAULT_SIDEBAR_TABS,
};

interface UIConfigContextValue {
  /** UI配置 */
  config: UIConfig;
  /** 更新UI配置 */
  updateConfig: (patch: Partial<UIConfig>) => void;
  /** 更新标签页可见性 */
  updateTabVisibility: (tabId: string, visible: boolean) => void;
  /** 重置配置 */
  resetConfig: () => void;
  /** 配置是否已加载完成 */
  configLoaded: boolean;
}

const UIConfigContext = createContext<UIConfigContextValue | null>(null);

export function useUIConfigContext() {
  const ctx = useContext(UIConfigContext);
  if (!ctx) {
    throw new Error("useUIConfigContext must be used within UIConfigProvider");
  }
  return ctx;
}

export function UIConfigProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = useState<UIConfig>(DEFAULT_UI_CONFIG);
  const [configLoaded, setConfigLoaded] = useState(false);

  // 从 localStorage 加载配置
  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      try {
        const saved = localStorage.getItem("rtl-ui-config");
        if (saved) {
          const parsed = JSON.parse(saved);
          if (parsed.sidebarTabs && Array.isArray(parsed.sidebarTabs)) {
            // 合并默认配置和保存的配置，确保新增的标签页被包含
            const mergedTabs = DEFAULT_SIDEBAR_TABS.map(defaultTab => {
              const savedTab = parsed.sidebarTabs.find((t: SidebarTabConfig) => t.id === defaultTab.id);
              // 强制确保不可隐藏的标签页始终可见
              if (!defaultTab.canHide) {
                return { ...defaultTab, visible: true };
              }
              return savedTab ? { ...defaultTab, ...savedTab } : defaultTab;
            });
            parsed.sidebarTabs = mergedTabs;
          }
          if (!cancelled) {
            setConfig({ ...DEFAULT_UI_CONFIG, ...parsed });
          }
        }
      } catch (error) {
        console.error("Failed to load UI config:", error);
      } finally {
        if (!cancelled) {
          setConfigLoaded(true);
        }
      }
    };
    init();
    return () => { cancelled = true; };
  }, []);

  const updateConfig = useCallback((patch: Partial<UIConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...patch };
      // 持久化到 localStorage
      try {
        localStorage.setItem("rtl-ui-config", JSON.stringify(next));
      } catch (error) {
        console.error("Failed to save UI config:", error);
      }
      return next;
    });
  }, []);

  const updateTabVisibility = useCallback((tabId: string, visible: boolean) => {
    setConfig((prev) => {
      const next = {
        ...prev,
        sidebarTabs: prev.sidebarTabs.map(tab =>
          tab.id === tabId ? { ...tab, visible } : tab
        ),
      };
      // 持久化到 localStorage
      try {
        localStorage.setItem("rtl-ui-config", JSON.stringify(next));
      } catch (error) {
        console.error("Failed to save UI config:", error);
      }
      return next;
    });
  }, []);

  const resetConfig = useCallback(() => {
    setConfig(DEFAULT_UI_CONFIG);
    try {
      localStorage.setItem("rtl-ui-config", JSON.stringify(DEFAULT_UI_CONFIG));
    } catch (error) {
      console.error("Failed to reset UI config:", error);
    }
  }, []);

  return (
    <UIConfigContext.Provider
      value={{
        config,
        updateConfig,
        updateTabVisibility,
        resetConfig,
        configLoaded,
      }}
    >
      {children}
    </UIConfigContext.Provider>
  );
}