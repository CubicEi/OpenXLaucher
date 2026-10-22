# OpenXLauncher

一款现代化的 **Minecraft 桌面启动器**，基于 **Tauri 2**（Rust）与 **Next.js 16**（React 19）构建，注重便携数据目录、跨平台与较低资源占用。

**社区**

- 原 RTLauncher QQ 群：1013525092  
- OpenXLauncher：[QQ 频道](https://pd.qq.com/s/czr9edieh)  
- GitHub：[CubicEi/OpenXLaucher](https://github.com/CubicEi/OpenXLaucher)

当前版本：**0.2.0-beta**

## 功能概览

### 游戏与版本

- **多加载器**：原版、Forge、NeoForge、Fabric、Quilt、LiteLoader、OptiFine  
- **组合安装**：一次勾选原版 + 加载器（及 Fabric API / OptiFine 等），自动组包为单个实例，并清理中间版本目录  
- **版本与实例**：版本选择、实例资源目录（`versions/<实例名>/`）管理  
- **Java**：下载中心多源 JDK；启动时按版本 JSON / JAR 字节码自动匹配 Java 大版本  

### 模组与下载

- **下载中心**：Minecraft / Java 版本、Modrinth + CurseForge 英文检索、收藏夹  
- **模组详情**：多平台文件列表、依赖自动下载（可配置）  
- **本地模组更新**：基于 SHA1 / jar 内链接 / **本地注册库**（`OpenX/mod-file-registry.db`）解析 Modrinth 或 CurseForge，按发布时间推荐更新；更新过程按 **gameDir** 与运行中实例互斥  
- **整合包**：CurseForge / Modrinth 整合包导入、导出与缓存  

### 资源管理

- **实例资源**：模组、资源包、光影、数据包、存档、投影、截图等分页管理  
- **缓存库**：按 MC 版本 + 加载器分类的下载缓存，支持搜索、回收站清空、与实例间加入/移出  
- **工具栏**：上传（+）、在资源管理器中打开对应子目录、统一风格的删除/清空确认对话框  

### 账户与联机

- **账户**：Microsoft（设备码）、LittleSkin、Yggdrasil（authlib-injector）、离线  
- **皮肤**：3D 预览（skinview3d）  
- **联机**：OpenP2P 相关能力（见 `src-tauri/src/multiplayer`）  

### 界面与其它

- **国际化**：简体中文 / 英文（`components/i18n/locales`），Crowdin 定期同步  
- **主题**：亮/暗色与可扩展主题包（`docs/theme-api`）  
- **应用更新**：内置更新检查（Tauri updater）  
- **日志**：便携目录 `OpenX/logs/launcher.log`，行格式 `[本地时间 LEVEL] 分类/消息`（见下文）  

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 前端 | Next.js 16（App Router）、React 19、TypeScript、Tailwind CSS 4 |
| UI | shadcn/ui、Radix UI、Framer Motion |
| 桌面 | Tauri 2、Rust 1.77+、tokio、reqwest |
| 包管理 | pnpm 8+ |
| 测试 | Vitest（前端）、Rust 单元测试 |

## 快速开始

### 环境要求

- **Node.js** ≥ 18  
- **Rust** ≥ 1.77（与 `src-tauri/Cargo.toml` 中 `rust-version` 一致）  
- **pnpm** ≥ 8  

Windows 构建还需 Visual Studio C++ 构建工具；Linux/macOS 需对应 Tauri [系统依赖](https://v2.tauri.app/start/prerequisites/)。

### 安装与开发

```bash
pnpm install
pnpm tauri dev
```

仅前端（浏览器，无 Tauri 命令时功能受限）：

```bash
pnpm dev
```

### 构建

```bash
# 标准安装包
pnpm tauri build

# 便携版（exe 同目录 OpenX 数据）
pnpm tauri:build:portable

# 调试构建
pnpm tauri:build:debug
```

### 测试与检查

```bash
pnpm test
pnpm exec tsc --noEmit
cd src-tauri && cargo check
```

## 数据与日志目录

便携布局（Windows 下以 **exe 同目录** 为主）：

| 路径 | 说明 |
| --- | --- |
| `OpenX/config` | 启动器配置 |
| `OpenX/minecraft` | 启动器侧 MC 元数据/缓存（非游戏 `.minecraft`） |
| `OpenX/logs/launcher.log` | 运行日志 |
| `OpenX/mod-file-registry.db` | 下载模组 SHA1 → 平台项目绑定 |
| `.minecraft`（可选） | 游戏根目录，可在设置中指定 |

日志格式示例：

```text
[2026-10-22 08:00:00 INFO] launch/config loaded
[2026-10-22 08:00:01 WARN] resources/list instance files failed {"dirPath":"..."}
[2026-10-22 08:00:02 ERROR] instances/vm_scan_instances failed
```

前端：`lib/runtime-log.ts`（`appLog` / `rtlLog`）；Rust：`src-tauri/src/handler/runtime_log.rs`。

## 项目结构（简）

```
OpenXLauncher/
├── app/                    # Next.js 页面（启动、下载、游戏设置、工具等）
├── components/             # UI、启动、下载、资源面板、i18n
├── hooks/                  # 资源管理等 React Hooks
├── lib/                    # 日志、工具函数、主题 SDK
├── src-tauri/              # Tauri / Rust
│   ├── src/auth/           # 账户与皮肤
│   ├── src/downloader/     # 原版、加载器、整合包下载
│   ├── src/handler/        # Tauri 命令（启动、模组、配置…）
│   └── src/version_management/
├── docs/theme-api/         # 主题包开发文档
└── packages/               # theme-cli、theme-sdk 等
```

## 支持的 Mod Loader

| Loader | 列表 / 安装 | 取消下载 |
| --- | --- | --- |
| Forge / NeoForge / Fabric / Quilt / LiteLoader / OptiFine | ✅ | ✅ |

## Crowdin 翻译

源语言：`components/i18n/locales/en-US.json`。GitHub Actions 工作流 `Sync Crowdin translations` 需配置 `CROWDIN_PROJECT_ID`、`CROWDIN_PERSONAL_TOKEN`。

## 贡献

1. Fork 本仓库  
2. 创建分支：`git checkout -b feature/your-feature`  
3. 提交：`git commit -m 'feat: ...'`  
4. 推送并打开 Pull Request  

提交前请运行 `pnpm test`、`pnpm exec tsc --noEmit` 与 `cargo check`（在 `src-tauri` 下）。

## 开源协议

本项目采用 **[GNU General Public License v3.0](https://www.gnu.org/licenses/gpl-3.0.html)**（见 `src-tauri/Cargo.toml` 中的 `license` 字段）。
