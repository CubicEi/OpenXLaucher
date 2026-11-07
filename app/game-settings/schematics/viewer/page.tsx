"use client";

import { Suspense, useEffect, useRef, useState, useCallback } from "react";
import { Upload, List, Download, Info, FileBox, Settings, X, RotateCcw, Maximize2, Minimize2, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/components/i18n/use-i18n";
import type { AppLanguage } from "@/components/settings/settings-provider";
import { useRouter, useSearchParams } from "next/navigation";
import { invoke } from "@tauri-apps/api/core";
import { schematicViewerBackRoute } from "@/lib/open-schematic-viewer";

declare global {
  interface Window {
    deepslate: any;
    glMatrix: any;
    deepslateResources: any;
    loadDeepslateResources: (image: HTMLImageElement) => any;
    readLitematicFromNBTData: (nbtdata: any) => any;
    parseSchematicBufferToLitematic: (nbtdata: any, fileName: string) => { litematic: any; format: string };
    getMaterialList: (litematic: any) => Record<string, number>;
    structureFromLitematic: (litematic: any, y_min?: number, y_max?: number, regionIndex?: number) => any;
    setStructure: (structure: any, reset_view?: boolean) => void;
    render: () => void;
    createRenderCanvas: (canvas: HTMLCanvasElement) => void;
    destroyRenderCanvas: () => void;
    structureLitematic: any;
  }
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) { resolve(); return; }
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

const CDN_BASES = ["https://cdn.jsdelivr.net/npm", "https://unpkg.com"];

async function loadClassicScriptWithVerify(src: string, globalName: string): Promise<void> {
  await loadScript(src);
  const w = window as any;
  if (typeof w[globalName] === "undefined") {
    throw new Error(`${globalName} not available on window after loading ${src}`);
  }
}

async function loadLibraryScript(cdnPath: string, localPath: string, globalName: string): Promise<void> {
  const attempts = [localPath, ...CDN_BASES.map((base) => `${base}${cdnPath}`)];
  let lastError: unknown;
  for (const src of attempts) {
    try {
      await loadClassicScriptWithVerify(src, globalName);
      return;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`All sources failed for ${globalName}`);
}

/**
 * assets.js is `const assets = JSON.parse('...')`. Inline <script textContent> is blocked
 * under Tauri CSP (hashes override 'unsafe-inline'). Extract and JSON.parse in app code.
 */
function loadAssetsOntoWindow(assetsText: string): void {
  if (typeof (window as any).assets !== "undefined") return;

  const trimmed = assetsText.trim();
  if (!/^(?:(?:const|let|var)\s+assets|window\.assets)\s*=\s*JSON\.parse\(/.test(trimmed)) {
    throw new Error("Unrecognized assets.js format (expected const assets = JSON.parse(...))");
  }

  const openIdx = trimmed.indexOf("JSON.parse(");
  const quoteIdx = openIdx + "JSON.parse(".length;
  const quote = trimmed[quoteIdx];
  if (quote !== "'" && quote !== '"') {
    throw new Error("Unrecognized assets.js JSON.parse quote");
  }

  const closeIdx = trimmed.lastIndexOf(quote + ")");
  if (closeIdx <= quoteIdx) {
    throw new Error("Unrecognized assets.js JSON.parse closing");
  }

  (window as any).assets = JSON.parse(trimmed.slice(quoteIdx + 1, closeIdx));
}

function computeLayerHeight(litematic: any, regionView: "merge" | number): number {
  if (!litematic?.regions?.length) return 0;
  if (regionView === "merge") {
    let minY = 0;
    let maxY = 0;
    let first = true;
    for (const region of litematic.regions) {
      const py = region.position?.y ?? 0;
      const ry = py + region.height;
      if (first) {
        minY = py;
        maxY = ry;
        first = false;
      } else {
        minY = Math.min(minY, py);
        maxY = Math.max(maxY, ry);
      }
    }
    return Math.max(0, maxY - minY);
  }
  const region = litematic.regions[regionView] ?? litematic.regions[0];
  return region.height;
}

export default function SchematicViewerPage() {
  return (
    <Suspense
      fallback={
        <div className="relative w-full h-full min-h-[400px] bg-black flex items-center justify-center text-zinc-500 text-sm">
          Loading…
        </div>
      }
    >
      <SchematicViewerPageContent />
    </Suspense>
  );
}

function SchematicViewerPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { language } = useI18n();
  const L = <T extends { [k in AppLanguage]: string }>(obj: T): string => obj[language] ?? obj["zh-CN"] ?? obj["en-US"];
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const atlasImgRef = useRef<HTMLImageElement>(null);
  const autoLoadAttemptedRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [scriptsLoaded, setScriptsLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [resourcesLoaded, setResourcesLoaded] = useState(false);
  const [localFileStatus, setLocalFileStatus] = useState<Record<string, boolean>>({});
  const [schematicInfo, setSchematicInfo] = useState<any>(null);
  const [blockCounts, setBlockCounts] = useState<Record<string, number> | null>(null);
  const [showMaterialList, setShowMaterialList] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [minLayer, setMinLayer] = useState(0);
  const [maxLayer, setMaxLayer] = useState(0);
  const [maxY, setMaxY] = useState(0);
  const [fileName, setFileName] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [runtimeGlobals, setRuntimeGlobals] = useState({
    deepslate: false,
    glMatrix: false,
    assets: false,
  });
  const [autoLoadError, setAutoLoadError] = useState<string | null>(null);
  const [parseNotice, setParseNotice] = useState<string | null>(null);
  const [regionView, setRegionView] = useState<"merge" | number>("merge");
  const [regionNames, setRegionNames] = useState<string[]>([]);
  const expectAutoOpen = !!(searchParams.get("path") || searchParams.get("k"));
  const [isAutoOpening, setIsAutoOpening] = useState(expectAutoOpen);
  const returnRoute = schematicViewerBackRoute(searchParams.get("from"));

  const chromeIconBtn =
    "h-9 w-9 rounded-full bg-zinc-800/95 text-zinc-100 shadow-md backdrop-blur border border-zinc-500 hover:bg-zinc-700 hover:text-white hover:border-zinc-400";
  const chromeTextBtn =
    "rounded-full bg-zinc-800/95 text-zinc-100 shadow-md backdrop-blur border border-zinc-500 hover:bg-zinc-700 hover:text-white hover:border-zinc-400 text-xs h-8 px-3";
  const chromeGhostBtn = "h-6 w-6 text-zinc-200 hover:text-white hover:bg-zinc-700";
  const chromeSelect =
    "w-full bg-zinc-800 border border-zinc-600 rounded px-2 py-1.5 text-xs text-zinc-100";
  const layerSliderClass =
    "h-full accent-sky-400 cursor-pointer opacity-90 hover:opacity-100";

  useEffect(() => {
    let cancelled = false;

    const LOCAL_FILES = [
      { name: "assets.js", path: "/schematic-viewer/assets.js" },
      { name: "deepslate.js", path: "/schematic-viewer/deepslate.js" },
      { name: "gl-matrix-min.js", path: "/schematic-viewer/gl-matrix-min.js" },
    ];

    (async function checkLocalFiles() {
      const status: Record<string, boolean> = {};
      for (const f of LOCAL_FILES) {
        try {
          const r = await fetch(f.path, { method: "HEAD" });
          status[f.name] = r.ok;
        } catch {
          status[f.name] = false;
        }
      }
      if (!cancelled) setLocalFileStatus(status);
    })();

    async function init() {
      try {
        await Promise.all([
          loadLibraryScript(
            "/deepslate@0.27.2/dist/deepslate.umd.cjs",
            "/schematic-viewer/deepslate.js",
            "deepslate",
          ),
          loadLibraryScript("/gl-matrix@3.4.3/gl-matrix-min.js", "/schematic-viewer/gl-matrix-min.js", "glMatrix"),
        ]);
        if (cancelled) return;

        const globalsAfterLibs = {
          deepslate: typeof window.deepslate !== "undefined",
          glMatrix: typeof window.glMatrix !== "undefined",
          assets: typeof (window as any).assets !== "undefined",
        };

        if (!globalsAfterLibs.glMatrix) {
          throw new Error("glMatrix failed to initialize — check public/schematic-viewer/gl-matrix-min.js");
        }
        if (!globalsAfterLibs.deepslate) {
          throw new Error("deepslate failed to initialize — check public/schematic-viewer/deepslate.js");
        }

        // Bundled from misode/mcmeta (see scripts/build-schematic-assets.mjs); not shipped by deepslate npm.
        const assetsResp = await fetch("/schematic-viewer/assets.js");
        if (!assetsResp.ok) {
          throw new Error(`Failed to fetch assets.js (HTTP ${assetsResp.status})`);
        }
        const assetsText = await assetsResp.text();
        if (cancelled) return;

        if (typeof (window as any).assets === "undefined") {
          loadAssetsOntoWindow(assetsText);
        }

        if (typeof (window as any).assets === "undefined") {
          throw new Error("Failed to load assets.js (window.assets is undefined)");
        }

        await loadScript("/schematic-viewer/nbt-compat.js");
        await loadScript("/schematic-viewer/opaque.js");
        await loadScript("/schematic-viewer/deepslate-helpers.js");
        await loadScript("/schematic-viewer/litematic-utils.js");
        await loadScript("/schematic-viewer/schematic-format-utils.js");
        await loadScript("/schematic-viewer/viewer.js");
        if (cancelled) return;

        setRuntimeGlobals({
          deepslate: typeof window.deepslate !== "undefined",
          glMatrix: typeof window.glMatrix !== "undefined",
          assets: typeof (window as any).assets !== "undefined",
        });
        setScriptsLoaded(true);
      } catch (e) {
        console.error("[schematic-viewer] Failed to load scripts:", e);
        setRuntimeGlobals({
          deepslate: typeof window.deepslate !== "undefined",
          glMatrix: typeof window.glMatrix !== "undefined",
          assets: typeof (window as any).assets !== "undefined",
        });
        setLoadError(e instanceof Error ? e.message : String(e));
      }
    }

    init();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!scriptsLoaded) return;
    const image = atlasImgRef.current;
    if (!image) return;

    function onLoad() {
      if (window.loadDeepslateResources) {
        window.loadDeepslateResources(image!);
        setResourcesLoaded(true);
      }
    }

    if (image.complete) {
      onLoad();
    } else {
      image.addEventListener("load", onLoad);
      return () => image.removeEventListener("load", onLoad);
    }
  }, [scriptsLoaded]);

  useEffect(() => {
    if (!resourcesLoaded || !canvasRef.current) return;
    const canvas = canvasRef.current;

    const resizeCanvas = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
    };
    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);
    const ro = new ResizeObserver(resizeCanvas);
    if (canvas.parentElement) ro.observe(canvas.parentElement);

    if (window.createRenderCanvas) {
      window.createRenderCanvas(canvas);
    }

    return () => {
      window.removeEventListener("resize", resizeCanvas);
      ro.disconnect();
      if (window.destroyRenderCanvas) {
        window.destroyRenderCanvas();
      }
    };
  }, [resourcesLoaded]);

  const structureRegionArg = useCallback((view: "merge" | number) => {
    return view === "merge" ? -1 : view;
  }, []);

  const applyLitematicToViewer = useCallback(
    (litematic: any, nbtdata: any, name: string, format: string) => {
      window.structureLitematic = litematic;
      const names = litematic.regionNames?.length
        ? litematic.regionNames
        : litematic.regions.map((_: unknown, i: number) => `region_${i}`);
      setRegionNames(names);
      const initialView: "merge" | number = litematic.regions.length > 1 ? "merge" : 0;
      setRegionView(initialView);

      const mY = computeLayerHeight(litematic, initialView);
      setMaxY(mY);
      setMinLayer(0);
      setMaxLayer(Math.max(0, mY - 1));
      setFileName(name);

      const counts = window.getMaterialList(litematic);
      setBlockCounts(counts);

      const region0 = litematic.regions[0];
      let infoName = name.replace(/\.(litematic|schem|schematic|nbt)$/i, "");
      let infoDesc = "";
      let infoAuthor = "-";
      let infoDate = "-";
      try {
        const nbtRoot = nbtdata.value;
        infoDesc = nbtRoot.Metadata?.value?.Description?.value || "";
        infoAuthor = nbtRoot.Metadata?.value?.Author?.value || "-";
        const rawDate = nbtRoot.Metadata?.value?.TimeCreated?.value;
        infoDate = rawDate ? new Date(rawDate).toLocaleString() : "-";
      } catch {}

      const sizeLabel =
        litematic.regions.length > 1
          ? L({
              "zh-CN": `${litematic.regions.length} 个区域（已合并预览）`,
              "en-US": `${litematic.regions.length} regions (merged)`,
            })
          : `${region0.width} × ${region0.height} × ${region0.depth}`;

      setParseNotice(
        format !== "litematic"
          ? L({
              "zh-CN": `已按 ${format} 格式解析`,
              "en-US": `Parsed as ${format}`,
            })
          : null,
      );

      setSchematicInfo({
        name: infoName,
        description: infoDesc,
        author: infoAuthor,
        date: infoDate,
        size: sizeLabel,
        format,
        blocks: Object.values(counts).reduce((a: number, b: number) => a + b, 0),
      });

      const structure = window.structureFromLitematic(
        litematic,
        0,
        -1,
        structureRegionArg(initialView),
      );
      window.setStructure(structure, true);
    },
    [L, structureRegionArg],
  );

  const processFileBuffer = useCallback(
    (buffer: ArrayBuffer, name: string) => {
      if (!window.deepslateResources) {
        alert(L({ "zh-CN": "资源尚未就绪，请稍候", "en-US": "Resources not ready yet" }));
        return false;
      }

      setIsLoading(true);
      setAutoLoadError(null);

      try {
        const nbtdata = window.deepslate.readNbt(new Uint8Array(buffer));
        const parsed = window.parseSchematicBufferToLitematic(nbtdata, name);
        applyLitematicToViewer(parsed.litematic, nbtdata, name, parsed.format);
        return true;
      } catch (e) {
        console.error("[schematic-viewer] Load failed:", e);
        const msg = e instanceof Error ? e.message : String(e);
        alert(
          L({
            "zh-CN": `无法加载该文件：\n${msg}`,
            "en-US": `Failed to load file:\n${msg}`,
          }),
        );
        return false;
      } finally {
        setIsLoading(false);
      }
    },
    [L, applyLitematicToViewer],
  );

  const handleFileLoad = useCallback(
    async (file: File) => {
      const reader = new FileReader();
      reader.readAsArrayBuffer(file);
      reader.onload = () => {
        if (reader.result) {
          processFileBuffer(reader.result as ArrayBuffer, file.name);
        }
      };
      reader.onerror = () => {
        alert("Failed to read file");
      };
    },
    [processFileBuffer]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file) handleFileLoad(file);
    },
    [handleFileLoad]
  );

  const handleLayerChange = useCallback(
    (min: number, max: number) => {
      if (!window.structureLitematic) return;
      if (min > max) return;
      setMinLayer(min);
      setMaxLayer(max);
      const structure = window.structureFromLitematic(
        window.structureLitematic,
        min,
        max + 1,
        structureRegionArg(regionView),
      );
      window.setStructure(structure);
    },
    [regionView, structureRegionArg],
  );

  const resetView = useCallback(() => {
    if (!window.structureLitematic) return;
    const structure = window.structureFromLitematic(
      window.structureLitematic,
      minLayer,
      maxLayer + 1,
      structureRegionArg(regionView),
    );
    window.setStructure(structure, true);
  }, [minLayer, maxLayer, regionView, structureRegionArg]);

  const handleRegionViewChange = useCallback(
    (next: "merge" | number) => {
      if (!window.structureLitematic) return;
      setRegionView(next);
      const mY = computeLayerHeight(window.structureLitematic, next);
      setMaxY(mY);
      setMinLayer(0);
      setMaxLayer(Math.max(0, mY - 1));
      const structure = window.structureFromLitematic(
        window.structureLitematic,
        0,
        -1,
        structureRegionArg(next),
      );
      window.setStructure(structure, true);
    },
    [structureRegionArg],
  );

  const exitToSchematics = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    router.push(returnRoute);
  }, [router, returnRoute]);

  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }, []);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (showSettings) { setShowSettings(false); return; }
      if (showMaterialList) { setShowMaterialList(false); return; }
      if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showSettings, showMaterialList]);

  const unloadSchematic = useCallback(() => {
    if (window.destroyRenderCanvas) {
      window.destroyRenderCanvas();
    }
    if (canvasRef.current && window.createRenderCanvas) {
      const canvas = canvasRef.current;
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(rect.width)) * dpr;
      canvas.height = Math.max(1, Math.round(rect.height)) * dpr;
      window.createRenderCanvas(canvas);
    }
    window.structureLitematic = null;
    setSchematicInfo(null);
    setBlockCounts(null);
    setFileName("");
    setShowMaterialList(false);
    setRegionNames([]);
    setRegionView("merge");
    setParseNotice(null);
  }, []);

  const exportCSV = useCallback(() => {
    if (!blockCounts) return;
    const csvContent = Object.entries(blockCounts)
      .sort(([, a], [, b]) => b - a)
      .map(([key, val]) => `${key},${val}`)
      .join("\n");
    const blob = new Blob([csvContent], { type: "text/csv" });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "MaterialList.csv";
    a.click();
    window.URL.revokeObjectURL(url);
  }, [blockCounts]);

  useEffect(() => {
    if (!resourcesLoaded || autoLoadAttemptedRef.current) return;
    autoLoadAttemptedRef.current = true;

    const pathParam = searchParams.get("path");
    const nameParam = searchParams.get("name");
    const keyParam = searchParams.get("k");

    if (!pathParam && !keyParam) {
      setIsAutoOpening(false);
      return;
    }

    (async () => {
      setIsAutoOpening(true);
      try {
        if (pathParam) {
          const b64 = await invoke<string>("read_file_base64", { path: pathParam });
          const buffer = base64ToArrayBuffer(b64);
          const fileName = nameParam || pathParam.split(/[\\/]/).pop() || "schematic";
          const ok = processFileBuffer(buffer, fileName);
          if (!ok) {
            setAutoLoadError(
              L({
                "zh-CN": `无法从路径加载：${pathParam}`,
                "en-US": `Could not load schematic from: ${pathParam}`,
              }),
            );
          }
          return;
        }

        const raw = sessionStorage.getItem(keyParam!);
        if (!raw) {
          setAutoLoadError(
            L({
              "zh-CN": "会话数据已失效，请从原理图列表重新打开",
              "en-US": "Session data expired — reopen from the schematics list",
            }),
          );
          return;
        }
        const obj = JSON.parse(raw);
        if (!obj?.b64 || !obj?.name) {
          setAutoLoadError(
            L({
              "zh-CN": "会话数据不完整",
              "en-US": "Incomplete session payload",
            }),
          );
          return;
        }
        processFileBuffer(base64ToArrayBuffer(obj.b64), obj.name);
        try {
          sessionStorage.removeItem(keyParam!);
        } catch {}
      } catch (e) {
        console.error("[schematic-viewer] auto load failed:", e);
        setAutoLoadError(e instanceof Error ? e.message : String(e));
      } finally {
        setIsAutoOpening(false);
      }
    })();
  }, [resourcesLoaded, processFileBuffer, searchParams, L]);

  const showImportPrompt =
    resourcesLoaded && !schematicInfo && !loadError && !isAutoOpening && !isLoading;

  const resourceRows: { file: string; globalKey: keyof typeof runtimeGlobals; hint: string }[] = [
    {
      file: "assets.js",
      globalKey: "assets",
      hint: L({
        "zh-CN": "mcmeta 26.3（scripts/build-schematic-assets.mjs）",
        "en-US": "mcmeta 26.3 (scripts/build-schematic-assets.mjs)",
      }),
    },
    {
      file: "deepslate.js",
      globalKey: "deepslate",
      hint: "https://cdn.jsdelivr.net/npm/deepslate@0.27.2/dist/deepslate.umd.cjs",
    },
    {
      file: "gl-matrix-min.js",
      globalKey: "glMatrix",
      hint: "https://cdn.jsdelivr.net/npm/gl-matrix@3.4.3/gl-matrix-min.js",
    },
  ];

  const renderResourceStatus = (file: string, globalKey: keyof typeof runtimeGlobals) => {
    const onDisk = !!localFileStatus[file];
    const runtimeOk = runtimeGlobals[globalKey];
    if (runtimeOk) {
      return (
        <span className="text-green-500 ml-2">
          ({L({ "zh-CN": "✓ 运行时已加载", "en-US": "✓ Loaded in runtime" })})
        </span>
      );
    }
    if (onDisk) {
      return (
        <span className="text-amber-500 ml-2">
          ({L({ "zh-CN": "△ 文件在本地但初始化失败", "en-US": "△ On disk but init failed" })})
        </span>
      );
    }
    return (
      <span className="text-red-500 ml-2">
        ({L({ "zh-CN": "✗ 缺失", "en-US": "✗ Missing" })})
      </span>
    );
  };

  const allLocalPresent = resourceRows.every((r) => localFileStatus[r.file]);

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full overflow-hidden bg-black"
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
    >
      <img
        ref={atlasImgRef}
        id="atlas"
        src="/schematic-viewer/atlas.png"
        alt="atlas"
        crossOrigin="anonymous"
        hidden
      />

      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ cursor: "grab", zIndex: 0 }}
      />

      {loadError && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm overflow-y-auto py-8">
          <div className="text-center max-w-lg p-6">
            <div className="text-red-400 text-lg mb-3">
              {L({ "zh-CN": "资源加载失败", "en-US": "Resource Load Failed" })}
            </div>
            <div className="text-zinc-400 text-sm mb-4 text-left space-y-2">
              <p>
                {allLocalPresent
                  ? L({
                      "zh-CN": "本地资源文件已存在，但脚本未成功初始化。请查看下方错误详情（常见原因：文件损坏或版本不匹配）。",
                      "en-US": "Local resource files are present but scripts failed to initialize. See the error below (corrupt or mismatched files are common).",
                    })
                  : L({
                      "zh-CN": "无法加载查看器依赖。若 CDN 不可用，请将以下文件放入",
                      "en-US": "Could not load viewer dependencies. If CDN is blocked, copy these files to",
                    })}
                {!allLocalPresent && (
                  <code className="bg-zinc-800 px-1.5 py-0.5 rounded text-blue-400 font-mono text-xs ml-1">
                    public/schematic-viewer/
                  </code>
                )}
              </p>
              <ol className="list-decimal list-inside space-y-1 text-xs text-zinc-300 pl-2">
                {resourceRows.map((row) => (
                  <li key={row.file}>
                    <code className="bg-zinc-800 px-1 rounded">{row.file}</code>
                    <span className="text-zinc-500 ml-2">← {row.hint}</span>
                    {renderResourceStatus(row.file, row.globalKey)}
                  </li>
                ))}
              </ol>
              {!allLocalPresent && (
                <p className="text-xs text-zinc-500 pt-2">
                  {L({
                    "zh-CN": "复制完成后刷新页面",
                    "en-US": "Refresh after copying the files",
                  })}
                </p>
              )}
            </div>
            <p className="text-zinc-600 text-xs border-t border-zinc-800 pt-3 mt-3">{loadError}</p>
          </div>
        </div>
      )}

      {!loadError && !resourcesLoaded && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="text-center">
            <div className="w-12 h-12 border-4 border-zinc-600 border-t-blue-500 rounded-full animate-spin mx-auto mb-4" />
            <p className="text-zinc-300 text-sm">
              {L({ "zh-CN": "加载资源中...", "en-US": "Loading resources..." })}
            </p>
          </div>
        </div>
      )}

      {(isLoading || isAutoOpening) && !loadError && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="text-center">
            <div className="w-12 h-12 border-4 border-zinc-600 border-t-sky-400 rounded-full animate-spin mx-auto mb-4" />
            <p className="text-zinc-200 text-sm">
              {L({ "zh-CN": "加载文件中...", "en-US": "Loading file..." })}
            </p>
          </div>
        </div>
      )}

      {showImportPrompt && (
        <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
          <Button
            variant="secondary"
            size="icon"
            className={`pointer-events-auto absolute top-4 left-4 z-20 ${chromeIconBtn}`}
            onClick={exitToSchematics}
            title={L({ "zh-CN": "返回原理图列表", "en-US": "Back to schematics" })}
          >
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div className="pointer-events-auto">
            <div className="bg-black/80 backdrop-blur-md rounded-2xl p-8 border border-zinc-800 shadow-2xl max-w-md w-full mx-4">
              <div className="text-center mb-6">
                <FileBox className="w-16 h-16 mx-auto mb-4 text-zinc-500" />
                <h2 className="text-xl font-bold text-white mb-2">
                  {L({ "zh-CN": "投影预览", "en-US": "Schematic Viewer" })}
                </h2>
                <p className="text-zinc-400 text-sm">
                  {L({
                    "zh-CN": "拖放 .litematic/.schem/.schematic 文件到此处",
                    "en-US": "Drop .litematic/.schem/.schematic file here",
                  })}
                </p>
              </div>

              <Label className="block cursor-pointer">
                <div className="border-2 border-dashed border-zinc-700 hover:border-blue-500 rounded-xl p-6 transition-colors text-center">
                  <Upload className="w-10 h-10 mx-auto mb-2 text-zinc-500" />
                  <p className="text-sm text-zinc-400">
                    {L({
                      "zh-CN": "点击选择文件",
                      "en-US": "Click to select file",
                    })}
                  </p>
                </div>
                <Input
                  ref={fileInputRef}
                  type="file"
                  accept=".litematic,.nbt,.schem,.schematic"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleFileLoad(file);
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                />
              </Label>

              {autoLoadError && (
                <p className="text-xs text-amber-400 text-center mt-4 border border-amber-900/50 rounded-lg p-2 bg-amber-950/30">
                  {autoLoadError}
                </p>
              )}

              <p className="text-xs text-zinc-600 text-center mt-4">
                Powered by <a href="https://github.com/misode/deepslate" className="text-blue-400 hover:underline" target="_blank" rel="noopener noreferrer">DeepSlate</a>
              </p>
            </div>
          </div>
        </div>
      )}

      {schematicInfo && (
        <>
          <div className="absolute bottom-4 left-4 z-20 flex flex-col gap-2">
            <Button
              variant="secondary"
              size="icon"
              className={chromeIconBtn}
              onClick={() => setShowMaterialList(!showMaterialList)}
              title={L({ "zh-CN": "材料清单", "en-US": "Material List" })}
            >
              <List className="w-4 h-4" />
            </Button>

            <Button
              variant="secondary"
              size="icon"
              className={chromeIconBtn}
              onClick={resetView}
              title={L({ "zh-CN": "重置视角", "en-US": "Reset View" })}
            >
              <RotateCcw className="w-4 h-4" />
            </Button>
          </div>

          {showMaterialList && blockCounts && (
            <div className="absolute bottom-4 left-16 z-20 bg-zinc-950/95 backdrop-blur-md border border-zinc-600 rounded-xl shadow-2xl max-h-[80vh] overflow-hidden w-72 text-zinc-100">
              <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700">
                <h3 className="text-sm font-medium text-white">
                  {L({ "zh-CN": "材料清单", "en-US": "Material List" })}
                </h3>
                <div className="flex gap-1">
                  <Button variant="ghost" size="icon" className={chromeGhostBtn} onClick={exportCSV}>
                    <Download className="w-3 h-3" />
                  </Button>
                  <Button variant="ghost" size="icon" className={chromeGhostBtn} onClick={() => setShowMaterialList(false)}>
                    <X className="w-3 h-3" />
                  </Button>
                </div>
              </div>
              <div className="overflow-y-auto max-h-[calc(80vh-48px)]" style={{ columnWidth: "auto" }}>
                {Object.entries(blockCounts)
                  .sort(([, a], [, b]) => b - a)
                  .map(([key, val]) => (
                    <div
                      key={key}
                      className="flex items-center justify-between px-4 py-1.5 text-xs border-b border-zinc-800/50 last:border-0 hover:bg-zinc-800/50"
                    >
                      <span className="truncate mr-2 text-zinc-200">{key.replace("minecraft:", "")}</span>
                      <span className="font-mono text-zinc-400 flex-shrink-0">{val.toLocaleString()}</span>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {maxY > 0 && (
            <div className="absolute top-1/2 -translate-y-1/2 left-2 z-20 flex items-center gap-3" style={{ height: "60vh" }}>
              <div className="flex flex-col items-center gap-1 h-full">
                <input
                  type="range"
                  min={0}
                  max={maxY - 1}
                  value={maxLayer}
                  onChange={(e) => handleLayerChange(minLayer, parseInt(e.target.value))}
                  className={layerSliderClass}
                  style={{
                    writingMode: "vertical-lr",
                    direction: "rtl",
                    appearance: "slider-vertical" as any,
                    width: "20px",
                  }}
                  title={L({ "zh-CN": "最大层", "en-US": "Max Layer" })}
                />
                <span className="text-xs text-zinc-300 tabular-nums">{maxLayer}</span>
              </div>
              <div className="flex flex-col items-center gap-1 h-full">
                <input
                  type="range"
                  min={0}
                  max={maxY - 1}
                  value={minLayer}
                  onChange={(e) => handleLayerChange(parseInt(e.target.value), maxLayer)}
                  className={layerSliderClass}
                  style={{
                    writingMode: "vertical-lr",
                    direction: "rtl",
                    appearance: "slider-vertical" as any,
                    width: "20px",
                  }}
                  title={L({ "zh-CN": "最小层", "en-US": "Min Layer" })}
                />
                <span className="text-xs text-zinc-300 tabular-nums">{minLayer}</span>
              </div>
            </div>
          )}

          <div className="absolute top-4 right-4 z-20 flex flex-col gap-2 items-end">
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="icon"
                className={`${chromeIconBtn} bg-sky-700/90 border-sky-400/70 hover:bg-sky-600`}
                onClick={exitToSchematics}
                title={L({ "zh-CN": "退出并返回 Schematics 页面 (Esc)", "en-US": "Back to Schematics (Esc)" })}
              >
                <ArrowLeft className="w-4 h-4" />
              </Button>
              <Button
                variant="secondary"
                size="icon"
                className={chromeIconBtn}
                onClick={toggleFullscreen}
                title={isFullscreen ? L({ "zh-CN": "退出全屏", "en-US": "Exit Fullscreen" }) : L({ "zh-CN": "全屏显示", "en-US": "Enter Fullscreen" })}
              >
                {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
              </Button>
            </div>

            <Button
              variant="secondary"
              size="icon"
              className={chromeIconBtn}
              onClick={() => setShowSettings(!showSettings)}
              title={L({ "zh-CN": "设置", "en-US": "Settings" })}
            >
              <Settings className="w-4 h-4" />
            </Button>

            <Button
              variant="secondary"
              size="sm"
              className={chromeTextBtn}
              onClick={unloadSchematic}
            >
              {L({ "zh-CN": "卸载投影", "en-US": "Unload Schematic" })}
            </Button>
          </div>

          <div
            className="absolute top-0 right-0 z-30 h-full bg-zinc-950/95 backdrop-blur-md border-l border-zinc-700 shadow-2xl overflow-y-auto transition-all duration-300 text-zinc-100"
            style={{ width: showSettings ? "380px" : "0" }}
          >
            <div className="p-6 min-w-[380px]">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-bold text-white">
                  {L({ "zh-CN": "设置", "en-US": "Settings" })}
                </h2>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-zinc-200 hover:text-white hover:bg-zinc-700" onClick={() => setShowSettings(false)}>
                  <X className="w-4 h-4" />
                </Button>
              </div>

              {parseNotice && (
                <p className="text-xs text-blue-300/90 mb-4 border border-blue-900/40 rounded-lg px-3 py-2 bg-blue-950/20">
                  {parseNotice}
                </p>
              )}

              {regionNames.length > 1 && (
                <div className="mb-6">
                  <Label className="text-xs text-zinc-500 mb-2 block">
                    {L({ "zh-CN": "区域", "en-US": "Regions" })}
                  </Label>
                  <select
                    className={chromeSelect}
                    value={regionView === "merge" ? "merge" : String(regionView)}
                    onChange={(e) => {
                      const v = e.target.value;
                      handleRegionViewChange(v === "merge" ? "merge" : parseInt(v, 10));
                    }}
                  >
                    <option value="merge">
                      {L({ "zh-CN": "合并全部区域", "en-US": "Merge all regions" })}
                    </option>
                    {regionNames.map((name, idx) => (
                      <option key={name + idx} value={String(idx)}>
                        {name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {schematicInfo && (
                <div className="mb-6 space-y-3 text-sm">
                  <h3 className="text-sm font-medium text-zinc-400 flex items-center gap-2">
                    <Info className="w-4 h-4" />
                    {L({ "zh-CN": "投影信息", "en-US": "Schematic Info" })}
                  </h3>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <div className="text-zinc-500">{L({ "zh-CN": "名称", "en-US": "Name" })}</div>
                      <div className="text-white truncate">{schematicInfo.name}</div>
                    </div>
                    <div>
                      <div className="text-zinc-500">{L({ "zh-CN": "作者", "en-US": "Author" })}</div>
                      <div className="text-white truncate">{schematicInfo.author}</div>
                    </div>
                    <div>
                      <div className="text-zinc-500">{L({ "zh-CN": "尺寸", "en-US": "Size" })}</div>
                      <div className="text-white font-mono">{schematicInfo.size}</div>
                    </div>
                    <div>
                      <div className="text-zinc-500">{L({ "zh-CN": "方块总数", "en-US": "Blocks" })}</div>
                      <div className="text-white font-mono">{schematicInfo.blocks.toLocaleString()}</div>
                    </div>
                    <div className="col-span-2">
                      <div className="text-zinc-500">{L({ "zh-CN": "创建时间", "en-US": "Created" })}</div>
                      <div className="text-white truncate">{schematicInfo.date}</div>
                    </div>
                    {schematicInfo.description && (
                      <div className="col-span-2">
                        <div className="text-zinc-500">{L({ "zh-CN": "描述", "en-US": "Description" })}</div>
                        <div className="text-white">{schematicInfo.description}</div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="mb-6">
                <h3 className="text-sm font-medium text-zinc-400 mb-3">
                  {L({ "zh-CN": "操作", "en-US": "Controls" })}
                </h3>
                <div className="space-y-4">
                  <div>
                    <Label className="text-xs text-zinc-500 mb-2 block">
                      {L({ "zh-CN": "左键拖拽", "en-US": "Click-drag" })}
                    </Label>
                    <div className="flex gap-2 items-center">
                      <select
                        className={`${chromeSelect} w-auto`}
                        defaultValue={typeof window !== "undefined" ? localStorage.getItem("click-drag") || "move" : "move"}
                        onChange={(e) => {
                          try { localStorage.setItem("click-drag", e.target.value); } catch {}
                        }}
                      >
                        <option value="move">{L({ "zh-CN": "移动", "en-US": "Move" })}</option>
                        <option value="pan">{L({ "zh-CN": "旋转", "en-US": "Pan" })}</option>
                      </select>
                      <label className="flex items-center gap-1 text-xs text-zinc-400">
                        <input
                          type="checkbox"
                          defaultChecked={typeof window !== "undefined" ? localStorage.getItem("click-drag-invert") === "true" : false}
                          onChange={(e) => {
                            try { localStorage.setItem("click-drag-invert", String(e.target.checked)); } catch {}
                          }}
                        />
                        {L({ "zh-CN": "反转", "en-US": "Invert" })}
                      </label>
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs text-zinc-500 mb-2 block">
                      {L({ "zh-CN": "中键拖拽", "en-US": "Middle-click-drag" })}
                    </Label>
                    <div className="flex gap-2 items-center">
                      <select
                        className={`${chromeSelect} w-auto`}
                        defaultValue={typeof window !== "undefined" ? localStorage.getItem("middle-click-drag") || "pan" : "pan"}
                        onChange={(e) => {
                          try { localStorage.setItem("middle-click-drag", e.target.value); } catch {}
                        }}
                      >
                        <option value="move">{L({ "zh-CN": "移动", "en-US": "Move" })}</option>
                        <option value="pan">{L({ "zh-CN": "旋转", "en-US": "Pan" })}</option>
                      </select>
                      <label className="flex items-center gap-1 text-xs text-zinc-400">
                        <input
                          type="checkbox"
                          defaultChecked={typeof window !== "undefined" ? localStorage.getItem("middle-click-drag-invert") === "true" : false}
                          onChange={(e) => {
                            try { localStorage.setItem("middle-click-drag-invert", String(e.target.checked)); } catch {}
                          }}
                        />
                        {L({ "zh-CN": "反转", "en-US": "Invert" })}
                      </label>
                    </div>
                  </div>
                </div>
              </div>

              <div>
                <h3 className="text-sm font-medium text-zinc-400 mb-3">
                  {L({ "zh-CN": "快捷键", "en-US": "Shortcuts" })}
                </h3>
                <div className="text-xs text-zinc-500 space-y-1">
                  <p>
                    WASD / Arrow Keys: {L({ "zh-CN": "移动", "en-US": "Move" })}
                  </p>
                  <p>
                    Shift / Space: {L({ "zh-CN": "上下", "en-US": "Up/Down" })}
                  </p>
                  <p>
                    Scroll: {L({ "zh-CN": "缩放", "en-US": "Zoom" })}
                  </p>
                  <p>
                    {L({ "zh-CN": "触屏: 单指旋转, 双指平移+缩放", "en-US": "Touch: 1-finger pan, 2-finger move+zoom" })}
                  </p>
                </div>
              </div>

              <div className="mt-6 pt-4 border-t border-zinc-800">
                <p className="text-xs text-zinc-600">
                  Powered by <a href="https://github.com/misode/deepslate" className="text-blue-400 hover:underline" target="_blank" rel="noopener noreferrer">DeepSlate</a>
                </p>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}