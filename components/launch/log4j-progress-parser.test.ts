/**
 * Log4j 进度解析器测试
 * 用于验证日志解析器的功能
 */

import { log4jParser } from "./log4j-progress-parser";
import { beforeEach, describe, expect, it } from "vitest";

// 测试日志样本（到「加载模组」完成即成功，不再包含世界/主菜单）
const testLogs = [
  "Running with arguments: [--gameDir, ...]",
  "Java HotSpot(TM) 64-Bit Server VM warning",
  "Loading libraries, please wait...",
  "Downloading library lwjgl-3.3.1.jar",
  "Loaded 123 libraries",
  "Loading assets",
  "Reloading ResourceManager",
  "Assets loaded",
  "Initializing game",
  "Setting up game instance",
  "Game initialized",
  "Loading mods",
  "Found 15 mods to load",
  "Fabric mod loading",
  "Mods loaded successfully",
];

const forgeCompletionLogs = [
  "Running with arguments: [--gameDir, ...]",
  "Loading libraries, please wait...",
  "Loaded 10 libraries",
  "Initializing game",
  "Game initialized",
  "Forge mod loading, version 47.2.0",
  "Forge Mod Loader has successfully loaded 42 mods",
];

const neoforgeCompletionLogs = [
  "Running with arguments: [--gameDir, ...]",
  "Loading libraries, please wait...",
  "Loaded 10 libraries",
  "Initializing game",
  "NeoForge mod loading, version 21.1.0",
  "Early mod loading complete",
];

/**
 * 运行测试
 */
export function runLog4jParserTest() {
  console.log("=== Log4j 进度解析器测试 ===");

  log4jParser.reset();

  testLogs.forEach((log, index) => {
    const result = log4jParser.parseLog(log);
    console.log(`[${index + 1}] 日志: ${log.substring(0, 50)}...`);
    console.log(`    阶段: ${result.stage?.name || "无"}`);
    console.log(`    进度: ${result.progress.toFixed(1)}%`);
    console.log(`    完成: ${result.isComplete ? "是" : "否"}`);
    console.log("---");
  });

  const finalStage = log4jParser.getCurrentStage();
  console.log(`最终阶段: ${finalStage?.name}`);
  console.log(`最终进度: ${log4jParser.parseLog("").progress.toFixed(1)}%`);

  return true;
}

// 如果在浏览器环境中运行测试
if (typeof window !== "undefined") {
  (window as any).runLog4jParserTest = runLog4jParserTest;
}

describe("log4jParser", () => {
  beforeEach(() => {
    log4jParser.reset();
  });

  it("treats mods-loaded as launch success (no world/ready stages)", () => {
    let result = log4jParser.parseLog("");
    for (const log of testLogs) {
      result = log4jParser.parseLog(log);
    }

    expect(result.stage?.id).toBe("loading_mods");
    expect(result.isComplete).toBe(true);
    expect(result.progress).toBe(100);
    expect(log4jParser.getAllStages().map((s) => s.id)).toEqual([
      "jvm_start",
      "loading_libraries",
      "loading_assets",
      "initializing_game",
      "loading_mods",
    ]);
  });

  it("completes on Forge successfully-loaded mods marker", () => {
    let result = log4jParser.parseLog("");
    for (const log of forgeCompletionLogs) {
      result = log4jParser.parseLog(log);
    }
    expect(result.stage?.id).toBe("loading_mods");
    expect(result.isComplete).toBe(true);
    expect(result.progress).toBe(100);
  });

  it("completes on NeoForge early mod loading complete", () => {
    let result = log4jParser.parseLog("");
    for (const log of neoforgeCompletionLogs) {
      result = log4jParser.parseLog(log);
    }
    expect(result.stage?.id).toBe("loading_mods");
    expect(result.isComplete).toBe(true);
  });

  it("completes on Sound engine started as Fabric/vanilla fallback", () => {
    log4jParser.parseLog("Initializing game");
    log4jParser.parseLog("Loading 12 mods:");
    const result = log4jParser.parseLog("Sound engine started");
    expect(result.stage?.id).toBe("loading_mods");
    expect(result.isComplete).toBe(true);
  });
});
