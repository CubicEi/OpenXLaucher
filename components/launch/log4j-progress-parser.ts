/**
 * Log4j 日志解析器
 * 通过分析 Minecraft log4j 日志来识别启动阶段和进度
 *
 * 启动成功判定：模组加载完成（不再等待加载世界 / 主菜单 / 准备就绪）。
 */

export interface Log4jProgressStage {
  /** 阶段ID */
  id: string;
  /** 阶段名称 */
  name: string;
  /** 阶段描述 */
  description: string;
  /** 预计进度百分比 (0-100) */
  estimatedPercentage: number;
}

/**
 * Minecraft 启动阶段定义（最后一项「加载模组」完成即视为启动成功）
 */
const LAUNCH_STAGES: Log4jProgressStage[] = [
  {
    id: "jvm_start",
    name: "JVM 启动",
    description: "Java 虚拟机正在启动",
    estimatedPercentage: 5,
  },
  {
    id: "loading_libraries",
    name: "加载库文件",
    description: "正在加载游戏依赖库",
    estimatedPercentage: 20,
  },
  {
    id: "loading_assets",
    name: "加载资源",
    description: "正在加载游戏资源和材质",
    estimatedPercentage: 40,
  },
  {
    id: "initializing_game",
    name: "初始化游戏",
    description: "正在初始化游戏核心",
    estimatedPercentage: 60,
  },
  {
    id: "loading_mods",
    name: "加载模组",
    description: "正在加载和验证模组",
    estimatedPercentage: 100,
  },
];

/**
 * 日志匹配规则
 */
interface LogPattern {
  /** 正则表达式模式 */
  pattern: RegExp;
  /** 匹配到的阶段ID */
  stageId: string;
  /** 是否为完成标记 */
  isCompletion?: boolean;
}

/**
 * Minecraft log4j 日志模式匹配规则
 *
 * 模组加载完成标记（优先于标题画面 / 世界加载）：
 * - Forge 1.12+: "Forge Mod Loader has successfully loaded N mods"
 * - Forge/NeoForge: "Mod loading complete" / "Early mod loading complete"
 * - 通用: "Mods loaded" / "successfully loaded N mods"
 * - Fabric/Quilt/原版回退（模组列表后、进世界前）: Sound engine / Narrator / Backend LWJGL
 */
const LOG_PATTERNS: LogPattern[] = [
  // JVM 启动
  {
    pattern: /Running with arguments:/i,
    stageId: "jvm_start",
  },
  {
    pattern: /Java HotSpot\(TM\)/i,
    stageId: "jvm_start",
  },
  {
    pattern: /OpenJDK/i,
    stageId: "jvm_start",
  },
  {
    pattern: /Picked up _JAVA_OPTIONS/i,
    stageId: "jvm_start",
  },

  // 加载库文件
  {
    pattern: /Loading libraries/i,
    stageId: "loading_libraries",
  },
  {
    pattern: /Downloading library/i,
    stageId: "loading_libraries",
  },
  {
    pattern: /Library download/i,
    stageId: "loading_libraries",
  },
  {
    pattern: /Loaded \d+ libraries/i,
    stageId: "loading_libraries",
    isCompletion: true,
  },
  {
    pattern: /Considering library/i,
    stageId: "loading_libraries",
  },
  {
    pattern: /Library .* does not exist/i,
    stageId: "loading_libraries",
  },

  // 加载资源
  {
    pattern: /Loading assets/i,
    stageId: "loading_assets",
  },
  {
    pattern: /Reloading resources/i,
    stageId: "loading_assets",
  },
  {
    pattern: /Resource pack loading/i,
    stageId: "loading_assets",
  },
  {
    pattern: /Assets loaded/i,
    stageId: "loading_assets",
    isCompletion: true,
  },
  {
    pattern: /Reloading ResourceManager/i,
    stageId: "loading_assets",
  },
  {
    pattern: /Applied.*resource pack/i,
    stageId: "loading_assets",
  },

  // 初始化游戏
  {
    pattern: /Initializing game/i,
    stageId: "initializing_game",
  },
  {
    pattern: /Starting game/i,
    stageId: "initializing_game",
  },
  {
    pattern: /Game instance created/i,
    stageId: "initializing_game",
  },
  {
    pattern: /Game initialized/i,
    stageId: "initializing_game",
    isCompletion: true,
  },
  {
    pattern: /Setting up game/i,
    stageId: "initializing_game",
  },
  {
    pattern: /Created.*dimensions/i,
    stageId: "initializing_game",
  },

  // 加载模组 — 完成标记须排在进入标记之前，避免 "mod loading complete" 被 /Mod loading/ 抢先匹配
  {
    pattern: /Mods loaded/i,
    stageId: "loading_mods",
    isCompletion: true,
  },
  {
    pattern: /successfully loaded \d+ mods/i,
    stageId: "loading_mods",
    isCompletion: true,
  },
  {
    pattern: /Forge Mod Loader has successfully loaded/i,
    stageId: "loading_mods",
    isCompletion: true,
  },
  {
    pattern: /(?:Early )?mod loading complete/i,
    stageId: "loading_mods",
    isCompletion: true,
  },
  // Fabric/Quilt/原版：模组阶段之后、进世界之前的稳定客户端就绪信号
  {
    pattern: /Sound engine started/i,
    stageId: "loading_mods",
    isCompletion: true,
  },
  {
    pattern: /Narrator library/i,
    stageId: "loading_mods",
    isCompletion: true,
  },
  {
    pattern: /Backend library:\s*LWJGL/i,
    stageId: "loading_mods",
    isCompletion: true,
  },

  // 加载模组 (Forge/Fabric/Quilt/NeoForge) — 进入阶段
  {
    pattern: /Loading mods/i,
    stageId: "loading_mods",
  },
  {
    pattern: /Loading \d+ mods/i,
    stageId: "loading_mods",
  },
  {
    // 排除 "mod loading complete"（已由上方完成规则处理）
    pattern: /Mod loading(?! complete)/i,
    stageId: "loading_mods",
  },
  {
    pattern: /Forge mod loading/i,
    stageId: "loading_mods",
  },
  {
    pattern: /NeoForge mod loading/i,
    stageId: "loading_mods",
  },
  {
    pattern: /Fabric mod loading/i,
    stageId: "loading_mods",
  },
  {
    pattern: /Quilt mod loading/i,
    stageId: "loading_mods",
  },
  {
    pattern: /Found \d+ mods/i,
    stageId: "loading_mods",
  },
  {
    pattern: /Processing mods/i,
    stageId: "loading_mods",
  },
  {
    pattern: /Mod.*found/i,
    stageId: "loading_mods",
  },
  {
    pattern: /Applying mod/i,
    stageId: "loading_mods",
  },
  {
    pattern: /Constructing mods/i,
    stageId: "loading_mods",
  },
  {
    pattern: /Configuring mods/i,
    stageId: "loading_mods",
  },
];

/**
 * Log4j 进度解析器类
 */
export class Log4jProgressParser {
  private currentStageIndex = 0;
  private stageStartTime = 0;
  private stageLogCounts: Map<string, number> = new Map();
  private totalLogCount = 0;
  /** 模组加载完成 → 启动成功 */
  private launchComplete = false;

  /**
   * 解析单条日志，返回当前进度信息
   */
  parseLog(message: string): {
    stage: Log4jProgressStage | null;
    progress: number;
    isComplete: boolean;
  } {
    this.totalLogCount++;

    // 尝试匹配所有日志模式
    for (const pattern of LOG_PATTERNS) {
      if (pattern.pattern.test(message)) {
        const stageIndex = LAUNCH_STAGES.findIndex(s => s.id === pattern.stageId);
        if (stageIndex !== -1) {
          if (pattern.isCompletion) {
            if (stageIndex < LAUNCH_STAGES.length - 1) {
              // 非最后阶段的完成标记：推进到下一阶段
              this.currentStageIndex = stageIndex + 1;
            } else {
              // 最后阶段（加载模组）完成 = 启动成功
              this.currentStageIndex = stageIndex;
              this.launchComplete = true;
            }
            this.stageStartTime = Date.now();
          } else if (stageIndex >= this.currentStageIndex) {
            this.currentStageIndex = stageIndex;
            this.stageStartTime = Date.now();
          }

          // 增加当前阶段的日志计数
          const currentStage = LAUNCH_STAGES[this.currentStageIndex];
          this.stageLogCounts.set(
            currentStage.id,
            (this.stageLogCounts.get(currentStage.id) || 0) + 1
          );

          const progress = this.launchComplete
            ? 100
            : this.calculateProgress(currentStage);

          return {
            stage: currentStage,
            progress,
            isComplete: this.launchComplete,
          };
        }
      }
    }

    // 如果没有匹配到模式，增加当前阶段的日志计数
    const currentStage = LAUNCH_STAGES[this.currentStageIndex];
    this.stageLogCounts.set(
      currentStage.id,
      (this.stageLogCounts.get(currentStage.id) || 0) + 1
    );

    const progress = this.launchComplete
      ? 100
      : this.calculateProgress(currentStage);

    return {
      stage: currentStage,
      progress,
      isComplete: this.launchComplete,
    };
  }

  /**
   * 计算当前进度百分比
   */
  private calculateProgress(stage: Log4jProgressStage): number {
    // 获取当前阶段和下一阶段的预计百分比
    const currentStagePercentage = stage.estimatedPercentage;
    const nextStageIndex = this.currentStageIndex + 1;
    const nextStagePercentage = nextStageIndex < LAUNCH_STAGES.length
      ? LAUNCH_STAGES[nextStageIndex].estimatedPercentage
      : 100;

    // 计算阶段间的进度范围
    const stageRange = nextStagePercentage - currentStagePercentage;

    // 基于当前阶段的日志数量计算内部进度
    const currentStageLogs = this.stageLogCounts.get(stage.id) || 0;
    // 假设每个阶段平均处理 10-50 条日志，根据阶段不同调整
    const expectedLogsPerStage = this.getExpectedLogsForStage(stage.id);
    const stageProgress = Math.min((currentStageLogs / expectedLogsPerStage) * stageRange, stageRange * 0.8);

    // 计算总进度
    let progress = currentStagePercentage + stageProgress;

    // 确保进度在合理范围内
    return Math.min(Math.max(progress, 0), 100);
  }

  /**
   * 获取每个阶段的预期日志数量
   */
  private getExpectedLogsForStage(stageId: string): number {
    const expectedLogs: Record<string, number> = {
      "jvm_start": 5,
      "loading_libraries": 20,
      "loading_assets": 15,
      "initializing_game": 10,
      "loading_mods": 25,
    };
    return expectedLogs[stageId] || 10;
  }

  /**
   * 重置解析器状态
   */
  reset(): void {
    this.currentStageIndex = 0;
    this.stageStartTime = 0;
    this.stageLogCounts.clear();
    this.totalLogCount = 0;
    this.launchComplete = false;
  }

  /**
   * 获取当前阶段
   */
  getCurrentStage(): Log4jProgressStage | null {
    return LAUNCH_STAGES[this.currentStageIndex] || null;
  }

  /**
   * 获取所有阶段
   */
  getAllStages(): Log4jProgressStage[] {
    return [...LAUNCH_STAGES];
  }
}

/**
 * 创建全局解析器实例
 */
export const log4jParser = new Log4jProgressParser();
