"use client";

import React, { useState, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Globe, Search, RefreshCw, Map, Folder,
  ChevronRight, Dices, ShieldCheck, Flame, Wand2, Terminal, ArrowLeft, Plus,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { fadeSlideUp, staggerContainer, staggerItem } from "@/lib/motion";
import { useInstancePath } from "@/hooks/use-instance-path";
import { useWorldInfo } from "@/hooks/use-world-info";

interface WorldFolder {
  name: string;
  is_dir: boolean;
  extension: string;
  size: number;
}

/* ------------------------------------------------------------------ */
/* 单条游戏规则开关行                                                     */
/* ------------------------------------------------------------------ */
function RuleRow({
  icon: Icon,
  label,
  description,
  value,
  disabled,
  onToggle,
  saving,
}: {
  icon: React.ElementType;
  label: string;
  description: string;
  value: boolean;
  disabled: boolean;
  onToggle: () => void;
  saving?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 py-2.5">
      <div className="size-8 rounded-lg bg-amber-50 dark:bg-amber-900/20 flex items-center justify-center shrink-0">
        <Icon className="size-4 text-amber-600 dark:text-amber-400" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <button
        role="switch"
        aria-checked={value}
        disabled={disabled || saving}
        onClick={onToggle}
        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${
          value ? "bg-amber-500" : "bg-input"
        }`}
      >
        <span
          className={`pointer-events-none inline-block size-4 rounded-full bg-white shadow-lg transition-transform ${
            value ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 存档设置面板                                                           */
/* ------------------------------------------------------------------ */
function WorldSettingsPanel({
  world,
  savesDir,
  onBack,
}: {
  world: WorldFolder;
  savesDir: string;
  onBack: () => void;
}) {
  const worldPath = `${savesDir}/${world.name}`;
  const { info, loading, error, refetch, modifyGameRule } = useWorldInfo(worldPath);
  const [saving, setSaving] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleToggle = async (
    key: "keepInventory" | "mobGriefing" | "doFireTick" | "allowCommands",
    current: boolean
  ) => {
    setSaving(key);
    setSaveError(null);
    try {
      await modifyGameRule(key, !current);
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(null);
    }
  };

  return (
    <motion.div
      key="settings"
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 24 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="flex flex-col h-full"
    >
      <div className="flex items-center gap-2 shrink-0 mb-4">
        <Button variant="ghost" size="icon" className="size-8" onClick={onBack}>
          <ArrowLeft className="size-4" />
        </Button>
        <div className="size-8 rounded-lg bg-amber-50 dark:bg-amber-900/20 flex items-center justify-center">
          <Folder className="size-4 text-amber-600 dark:text-amber-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold leading-tight truncate">{world.name}</h2>
          <p className="text-xs text-muted-foreground truncate">游戏规则设置</p>
        </div>
        <Button variant="ghost" size="icon" className="size-8" onClick={refetch}>
          <RefreshCw className="size-3.5" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="space-y-2">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-14 rounded-lg bg-muted/50 animate-pulse" />
            ))}
          </div>
        ) : error ? (
          <motion.div
            variants={fadeSlideUp}
            initial="initial"
            animate="animate"
            className="flex flex-col items-center justify-center gap-2 pt-8 text-center"
          >
            <p className="text-sm text-destructive">读取失败</p>
            <p className="text-xs text-muted-foreground">{error}</p>
          </motion.div>
        ) : info ? (
          <motion.div variants={staggerContainer} initial="initial" animate="animate" className="space-y-2">
            <div className="rounded-xl border p-4 bg-card">
              <div className="flex items-center gap-3 mb-2">
                <Map className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium">世界信息</span>
              </div>
              <div className="grid grid-cols-1 gap-1 text-xs">
                <div className="flex items-center justify-between py-1">
                  <span className="text-muted-foreground">种子</span>
                  <span className="font-mono">{info.seed}</span>
                </div>
              </div>
            </div>

            <RuleRow
              icon={ShieldCheck}
              label="死亡后保留物品"
              description="玩家死亡时背包中的物品不会掉落"
              value={info.keep_inventory}
              disabled={false}
              onToggle={() => handleToggle("keepInventory", info.keep_inventory)}
              saving={saving === "keepInventory"}
            />
            <RuleRow
              icon={Flame}
              label="火焰蔓延"
              description="火焰可以在可燃物上扩散"
              value={info.do_fire_tick}
              disabled={false}
              onToggle={() => handleToggle("doFireTick", info.do_fire_tick)}
              saving={saving === "doFireTick"}
            />
            <RuleRow
              icon={Dices}
              label="生物破坏方块"
              description="苦力怕等生物可以破坏地形"
              value={info.mob_griefing}
              disabled={false}
              onToggle={() => handleToggle("mobGriefing", info.mob_griefing)}
              saving={saving === "mobGriefing"}
            />
            <RuleRow
              icon={Terminal}
              label="允许作弊指令"
              description="开启后可以在游戏内使用 /give、/gamemode 等指令"
              value={info.allow_commands}
              disabled={false}
              onToggle={() => handleToggle("allowCommands", info.allow_commands)}
              saving={saving === "allowCommands"}
            />
            {saveError && (
              <motion.p variants={fadeSlideUp} initial="initial" animate="animate" className="text-xs text-destructive mt-2">
                {saveError}
              </motion.p>
            )}
          </motion.div>
        ) : null}
      </div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* 主页面                                                                  */
/* ------------------------------------------------------------------ */
export default function WorldsPage() {
  const { instanceDir, selectedInstance, minecraftPath, configLoaded } = useInstancePath();
  const [selectedWorld, setSelectedWorld] = useState<WorldFolder | null>(null);
  const [instanceSearch, setInstanceSearch] = useState("");
  const [cacheSearch, setCacheSearch] = useState("");
  const [instanceWorlds, setInstanceWorlds] = useState<WorldFolder[]>([]);
  const [cacheWorlds, setCacheWorlds] = useState<WorldFolder[]>([]);
  const [instanceLoading, setInstanceLoading] = useState(false);
  const [cacheLoading, setCacheLoading] = useState(false);
  const [instanceError, setInstanceError] = useState<string | null>(null);
  const [cacheError, setCacheError] = useState<string | null>(null);

  const mcVersion = selectedInstance?.minecraft_version;
  const savesDir = instanceDir ? `${instanceDir}/saves` : undefined;

  const fetchInstanceWorlds = useCallback(async (): Promise<WorldFolder[]> => {
    if (!savesDir) return [];
    setInstanceLoading(true);
    setInstanceError(null);
    try {
      const entries: WorldFolder[] = await invoke("vm_list_dir", {
        dirPath: savesDir,
        extensionsFilter: [],
      });
      const folders = entries.filter((e) => e.is_dir);
      folders.sort((a, b) => a.name.localeCompare(b.name));
      setInstanceWorlds(folders);
      return folders;
    } catch (e: any) {
      const msg = String(e).toLowerCase();
      if (msg.includes("not found") || msg.includes("系统找不到")) {
        setInstanceWorlds([]);
      } else {
        setInstanceError(String(e));
        setInstanceWorlds([]);
      }
      return [];
    } finally {
      setInstanceLoading(false);
    }
  }, [savesDir]);

  const fetchCacheWorlds = useCallback(async (currentInstanceWorlds: WorldFolder[]) => {
    if (!mcVersion) return;
    setCacheLoading(true);
    setCacheError(null);
    try {
      const names: string[] = await invoke("list_cached_files", {
        kind: "world",
        mcVersion: mcVersion,
      });
      const instanceNames = new Set(currentInstanceWorlds.map((f) => f.name));
      const folders = names
        .filter((n) => !instanceNames.has(n))
        .map((n) => ({ name: n, is_dir: true, extension: "", size: 0 }));
      folders.sort((a, b) => a.name.localeCompare(b.name));
      setCacheWorlds(folders);
    } catch (e: any) {
      const msg = String(e).toLowerCase();
      if (msg.includes("not found") || msg.includes("系统找不到")) {
        setCacheWorlds([]);
      } else {
        setCacheError(String(e));
        setCacheWorlds([]);
      }
    } finally {
      setCacheLoading(false);
    }
  }, [mcVersion]);

  const refreshWorlds = useCallback(async () => {
    // 将本次读取到的实例列表直接传给缓存读取，避免把 instanceWorlds
    // 放入 effect 依赖。此前列表 state 每次更新都会重新触发两次请求，
    // 形成无限刷新并最终令页面失去响应。
    const worlds = await fetchInstanceWorlds();
    await fetchCacheWorlds(worlds);
  }, [fetchCacheWorlds, fetchInstanceWorlds]);

  const addToInstance = useCallback(
    async (worldName: string) => {
      if (!instanceDir || !mcVersion) return;
      await invoke("cache_to_instance", {
        kind: "world",
        mcVersion: mcVersion,
        modLoader: null,
        fileName: worldName,
        instanceDir: instanceDir,
        instanceSubdir: "saves",
      });
      await refreshWorlds();
    },
    [instanceDir, mcVersion, refreshWorlds],
  );

  const removeFromInstance = useCallback(
    async (worldName: string) => {
      if (!instanceDir || !mcVersion) return;
      await invoke("instance_to_cache", {
        kind: "world",
        mcVersion: mcVersion,
        modLoader: null,
        fileName: worldName,
        instanceDir: instanceDir,
        instanceSubdir: "saves",
      });
      await refreshWorlds();
    },
    [instanceDir, mcVersion, refreshWorlds],
  );

  useEffect(() => {
    if (!instanceDir) return;
    void refreshWorlds();
  }, [instanceDir, refreshWorlds]);

  const filteredInstance = instanceWorlds.filter((w) =>
    w.name.toLowerCase().includes(instanceSearch.toLowerCase())
  );
  const filteredCache = cacheWorlds.filter((w) =>
    w.name.toLowerCase().includes(cacheSearch.toLowerCase())
  );

  if (!configLoaded) {
    return (
      <motion.div
        variants={fadeSlideUp}
        initial="initial"
        animate="animate"
        className="flex h-full flex-col items-center justify-center gap-3 text-center p-4"
      >
        <div className="size-12 rounded-full bg-muted flex items-center justify-center">
          <Globe className="size-6 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium">正在加载配置...</p>
        <p className="text-xs text-muted-foreground">请稍候</p>
      </motion.div>
    );
  }

  if (!minecraftPath || !instanceDir) {
    return (
      <motion.div
        variants={fadeSlideUp}
        initial="initial"
        animate="animate"
        className="flex h-full flex-col items-center justify-center gap-3 text-center p-4"
      >
        <div className="size-12 rounded-full bg-muted flex items-center justify-center">
          <Globe className="size-6 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium">未配置游戏目录</p>
        <p className="text-xs text-muted-foreground">请先在「启动」页面配置游戏目录路径</p>
      </motion.div>
    );
  }

  return (
    <AnimatePresence mode="wait">
      {selectedWorld ? (
        <WorldSettingsPanel
          key="settings"
          world={selectedWorld}
          savesDir={savesDir!}
          onBack={() => setSelectedWorld(null)}
        />
      ) : (
        <motion.div
          key="list"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="flex h-full flex-col gap-4 p-4 overflow-hidden"
        >
          <motion.div
            variants={fadeSlideUp}
            initial="initial"
            animate="animate"
            className="flex items-center gap-3 shrink-0"
          >
            <div className="flex size-9 items-center justify-center rounded-xl bg-violet-500/10">
              <Globe className="size-5 text-violet-500" />
            </div>
            <div>
              <h1 className="text-lg font-semibold leading-none">游戏世界管理</h1>
              <p className="mt-1 text-xs text-muted-foreground">
                {selectedInstance
                  ? `${selectedInstance.name} · ${instanceWorlds.length} 个世界`
                  : "请选择一个实例"}
              </p>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <Badge variant="secondary" className="text-xs">
                {instanceWorlds.length} 个
              </Badge>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={() => void refreshWorlds()}
                title="刷新"
              >
                <RefreshCw className="size-3.5" />
              </Button>
            </div>
          </motion.div>

          <div className="flex-1 flex gap-4 min-h-0 overflow-hidden">
            {/* 左列：当前实例中的世界 */}
            <motion.div
              variants={fadeSlideUp}
              initial="initial"
              animate="animate"
              className="flex-1 flex flex-col border rounded-xl bg-card overflow-hidden min-w-0"
            >
              <div className="shrink-0 flex items-center gap-3 px-3 py-2 border-b">
                <div className="flex size-7 items-center justify-center rounded-lg bg-violet-500/10">
                  <Globe className="size-3.5 text-violet-500" />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="text-sm font-semibold leading-tight">当前实例中</h2>
                  <p className="text-xs text-muted-foreground truncate">已加入的世界存档</p>
                </div>
                <Badge variant="secondary" className="text-xs shrink-0">
                  {instanceWorlds.length} 个
                </Badge>
                <div className="relative w-40 shrink-0">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
                  <Input
                    value={instanceSearch}
                    onChange={(e) => setInstanceSearch(e.target.value)}
                    placeholder="搜索..."
                    className="pl-7 h-7 text-xs"
                  />
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-3">
                {instanceLoading ? (
                  <div className="space-y-2">
                    {[...Array(4)].map((_, i) => (
                      <div key={i} className="h-12 rounded-lg bg-muted/50 animate-pulse" />
                    ))}
                  </div>
                ) : instanceError ? (
                  <div className="flex flex-col items-center justify-center gap-2 pt-8 text-center">
                    <p className="text-sm text-destructive">读取失败</p>
                    <p className="text-xs text-muted-foreground">{instanceError}</p>
                  </div>
                ) : filteredInstance.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-3 pt-8 text-center">
                    <div className="size-12 rounded-full bg-muted flex items-center justify-center">
                      <Globe className="size-6 text-muted-foreground" />
                    </div>
                    <p className="text-sm font-medium">暂无世界</p>
                    <p className="text-xs text-muted-foreground">游戏世界将保存到 saves 文件夹</p>
                  </div>
                ) : (
                  <motion.div variants={staggerContainer} initial="initial" animate="animate" className="space-y-1">
                    {filteredInstance.map((world) => (
                      <motion.div
                        key={world.name}
                        variants={staggerItem}
                        className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-accent/50 transition-colors"
                      >
                        <button
                          onClick={() => setSelectedWorld(world)}
                          className="flex-1 flex items-center gap-3 min-w-0 text-left"
                        >
                          <div className="size-7 rounded-lg bg-amber-50 dark:bg-amber-900/20 flex items-center justify-center shrink-0">
                            <Folder className="size-3.5 text-amber-600 dark:text-amber-400" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{world.name}</p>
                          </div>
                          <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />
                        </button>
                        <Button
                          variant="secondary"
                          size="sm"
                          className="shrink-0 h-7 px-2"
                          onClick={() => removeFromInstance(world.name)}
                          title="移出实例"
                        >
                          <Plus className="size-3 mr-1 rotate-45" />
                          <span className="text-xs">移出</span>
                        </Button>
                      </motion.div>
                    ))}
                  </motion.div>
                )}
              </div>
            </motion.div>

            {/* 右列：cache 中的世界 */}
            <motion.div
              variants={fadeSlideUp}
              initial="initial"
              animate="animate"
              className="flex-1 flex flex-col border rounded-xl bg-card overflow-hidden min-w-0"
            >
              <div className="shrink-0 flex items-center gap-3 px-3 py-2 border-b">
                <div className="flex size-7 items-center justify-center rounded-lg bg-sky-500/10">
                  <Folder className="size-3.5 text-sky-500" />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="text-sm font-semibold leading-tight">Cache 库</h2>
                  <p className="text-xs text-muted-foreground truncate">对应版本 · 可加入</p>
                </div>
                <Badge variant="secondary" className="text-xs shrink-0">
                  {cacheWorlds.length} 个
                </Badge>
                <div className="relative w-40 shrink-0">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
                  <Input
                    value={cacheSearch}
                    onChange={(e) => setCacheSearch(e.target.value)}
                    placeholder="搜索..."
                    className="pl-7 h-7 text-xs"
                  />
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-3">
                {cacheLoading ? (
                  <div className="space-y-2">
                    {[...Array(4)].map((_, i) => (
                      <div key={i} className="h-12 rounded-lg bg-muted/50 animate-pulse" />
                    ))}
                  </div>
                ) : cacheError ? (
                  <div className="flex flex-col items-center justify-center gap-2 pt-8 text-center">
                    <p className="text-sm text-destructive">读取失败</p>
                    <p className="text-xs text-muted-foreground">{cacheError}</p>
                  </div>
                ) : filteredCache.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-3 pt-8 text-center">
                    <div className="size-12 rounded-full bg-muted flex items-center justify-center">
                      <Folder className="size-6 text-muted-foreground" />
                    </div>
                    <p className="text-sm font-medium">暂无可用世界</p>
                    <p className="text-xs text-muted-foreground">下载的世界将出现在这里</p>
                  </div>
                ) : (
                  <motion.div variants={staggerContainer} initial="initial" animate="animate" className="space-y-1">
                    {filteredCache.map((world) => (
                      <motion.div
                        key={world.name}
                        variants={staggerItem}
                        className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-accent/50 transition-colors"
                      >
                        <div className="size-7 rounded-lg bg-amber-50 dark:bg-amber-900/20 flex items-center justify-center shrink-0">
                          <Folder className="size-3.5 text-amber-600 dark:text-amber-400" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{world.name}</p>
                        </div>
                        <Button
                          variant="default"
                          size="sm"
                          className="shrink-0 h-7 px-2"
                          onClick={() => addToInstance(world.name)}
                          title="加入实例"
                        >
                          <Plus className="size-3 mr-1" />
                          <span className="text-xs">加入</span>
                        </Button>
                      </motion.div>
                    ))}
                  </motion.div>
                )}
              </div>
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
