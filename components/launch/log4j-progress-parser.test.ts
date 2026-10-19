/**
 * Log4j 进度解析器测试
 * 用于验证日志解析器的功能
 */

import { log4jParser } from "./log4j-progress-parser";
import { beforeEach, describe, expect, it } from "vitest";

// 测试日志样本
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
  "Loading world new_world",
  "Preparing start region for dimension minecraft:overworld",
  "Time elapsed: 2340 ms",
  "World loaded",
  "Game started",
  "Displaying screen net.minecraft.client.gui.screen.MainMenuScreen",
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

  it("advances through the sample launch logs and reaches ready", () => {
    let result = log4jParser.parseLog("");
    for (const log of testLogs) {
      result = log4jParser.parseLog(log);
    }

    expect(result.stage?.id).toBe("ready");
    expect(result.isComplete).toBe(true);
    expect(result.progress).toBe(100);
  });
});
