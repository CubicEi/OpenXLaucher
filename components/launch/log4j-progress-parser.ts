/**
 * Log4j 日志解析器
 * 通过分析 Minecraft log4j 日志来识别启动阶段和进度
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
 * Minecraft 启动阶段定义
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
    estimatedPercentage: 75,
  },
  {
    id: "loading_world",
    name: "加载世界",
    description: "正在加载世界数据",
    estimatedPercentage: 90,
  },
  {
    id: "ready",
    name: "准备完成",
    description: "游戏已准备就绪",
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

  // 加载模组 (Forge/Fabric/Quilt)
  {
    pattern: /Loading mods/i,
    stageId: "loading_mods",
  },
  {
    pattern: /Mod loading/i,
    stageId: "loading_mods",
  },
  {
    pattern: /Forge mod loading/i,
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
    pattern: /Mods loaded/i,
    stageId: "loading_mods",
    isCompletion: true,
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

  // 加载世界
  {
    pattern: /Loading world/i,
    stageId: "loading_world",
  },
  {
    pattern: /Preparing start region/i,
    stageId: "loading_world",
  },
  {
    pattern: /Preparing spawn area/i,
    stageId: "loading_world",
  },
  {
    pattern: /Time elapsed/i,
    stageId: "loading_world",
  },
  {
    pattern: /World loaded/i,
    stageId: "loading_world",
    isCompletion: true,
  },
  {
    pattern: /Loading level/i,
    stageId: "loading_world",
  },
  {
    pattern: /Reading.*level data/i,
    stageId: "loading_world",
  },
  {
    pattern: /Building chunk/i,
    stageId: "loading_world",
  },

  // 准备完成
  {
    pattern: /Game started/i,
    stageId: "ready",
  },
  {
    pattern: /Displaying screen/i,
    stageId: "ready",
  },
  {
    pattern: /Main menu/i,
    stageId: "ready",
  },
  {
    pattern: /Rendering screen/i,
    stageId: "ready",
  },
  {
    pattern: /Opening screen/i,
    stageId: "ready",
  },
  {
    pattern: /Started serving/i,
    stageId: "ready",
  },
  {
    pattern: /Done.*help/i,
    stageId: "ready",
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
          // 如果是完成标记，移动到下一阶段
          if (pattern.isCompletion && stageIndex < LAUNCH_STAGES.length - 1) {
            this.currentStageIndex = stageIndex + 1;
            this.stageStartTime = Date.now();
          } else if (stageIndex >= this.currentStageIndex) {
            // 否则更新当前阶段
            this.currentStageIndex = stageIndex;
            this.stageStartTime = Date.now();
          }

          // 增加当前阶段的日志计数
          const currentStage = LAUNCH_STAGES[this.currentStageIndex];
          this.stageLogCounts.set(
            currentStage.id,
            (this.stageLogCounts.get(currentStage.id) || 0) + 1
          );

          const progress = this.calculateProgress(currentStage);

          return {
            stage: currentStage,
            progress,
            isComplete: currentStage.id === "ready",
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

    const progress = this.calculateProgress(currentStage);

    return {
      stage: currentStage,
      progress,
      isComplete: currentStage.id === "ready",
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
      "loading_world": 15,
      "ready": 5,
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