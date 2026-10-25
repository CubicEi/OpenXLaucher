pub mod resource_checker;

use base64::Engine;
use crate::downloader::shared_utils::sanitize_instance_name;
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Minecraft 实例中需要存在的标准子目录
///
/// 每次打开文件检索页面对应实例时都会检查这些目录是否存在，不存在则创建。
const STANDARD_INSTANCE_SUBDIRS: &[&str] = &[
    "mods",
    "resourcepacks",
    "shaderpacks",
    "saves",
    "datapacks",
    "config",
    "schematics",
    "screenshots",
];

/// 确保指定实例目录下存在所有 Minecraft 标准子目录
///
/// 调用频率：在文件检索页面点开对应实例时检查一次即可。
pub fn ensure_instance_dirs(instance_dir: &Path) -> Result<(), String> {
    for sub in STANDARD_INSTANCE_SUBDIRS {
        let sub_path = instance_dir.join(sub);
        if !sub_path.exists() {
            std::fs::create_dir_all(&sub_path)
                .map_err(|e| format!("创建目录 {} 失败: {}", sub_path.display(), e))?;
        }
    }
    Ok(())
}

/// 前端调用命令：确保指定实例目录具备完整的标准子目录结构
#[tauri::command]
pub async fn vm_ensure_instance_dirs(instance_dir: String) -> Result<(), String> {
    let path = Path::new(&instance_dir);
    if !path.exists() {
        std::fs::create_dir_all(path)
            .map_err(|e| format!("创建实例目录 {} 失败: {}", path.display(), e))?;
    }
    ensure_instance_dirs(path)
}

// ── 返回结构体 ───────────────────────────────────────────────

/// 单个实例的元数据
#[derive(Debug, Serialize)]
pub struct InstanceData {
    /// 实例名称（即 instance 目录下的文件夹名，当前约定同时也是 MC 版本号）
    pub name: String,
    /// Minecraft 版本号
    pub minecraft_version: String,
    /// 加载器类型（从 versions/<name>/<name>.json 的 mainClass 推断）
    pub loader: String,
    /// mods/ 目录中的文件数量
    pub mods_count: usize,
}

/// 单个材质包/光影包的信息
#[derive(Debug, Serialize)]
pub struct ResourcePackInfo {
    /// 文件夹名
    pub name: String,
    /// pack.png 的绝对路径（若不存在则为空字符串）
    pub icon_path: String,
    /// 基于 pack_format 的 MC 版本范围描述
    pub mc_version_range: String,
}

/// level.dat 解析结果
#[derive(Debug, Serialize)]
pub struct LevelDatInfo {
    pub seed: String,
    pub keep_inventory: bool,
    pub mob_griefing: bool,
    pub do_fire_tick: bool,
    pub allow_commands: bool,
}

// ── 辅助工具 ─────────────────────────────────────────────────

/// 根据 mainClass 推断加载器类型
fn detect_loader_from_main_class(main_class: &str) -> &'static str {
    let mc = main_class.to_lowercase();
    if mc.contains("optifine") {
        "OptiFine"
    } else if mc.contains("quiltmc") || mc.contains("quilt") {
        "Quilt"
    } else if mc.contains("fabricmc") || mc.contains("knot") {
        "Fabric"
    } else if mc.contains("neoforged") {
        "NeoForge"
    } else if mc.contains("bootstraplauncher")
        || mc.contains("modlauncher")
        || mc.contains("minecraftforge")
    {
        "Forge"
    } else if mc.contains("liteloader") {
        "LiteLoader"
    } else {
        "Vanilla"
    }
}

/// 从加载器库坐标推断加载器类型（比 mainClass 更可靠）。
///
/// NeoForge 与 Forge 的 mainClass 同为 `cpw.mods.bootstraplauncher.BootstrapLauncher`，
/// 无法区分；而库坐标是各自独占的：
/// - NeoForge: `net.neoforged:fancymodloader:*` / `net.neoforged:neoforge:*` /
///             `net.neoforged:fmlloader:*` / `net.neoforged:forge:*`（早期版本）
/// - Forge: `net.minecraftforge:forge:*` / `net.minecraftforge:fmlloader:*`
///
/// 注意：
/// - `net.minecraftforge:srgutils`、`cpw.mods:modlauncher`、
///   `cpw.mods:bootstraplauncher` 是两者共用库，不能作为 Forge 判据。
/// - 只要出现任何 net.neoforged:* loader 坐标就直接返回 NeoForge，
///   比 Forge 的 net.minecraftforge:forge/fmlloader 判据优先级更高。
fn detect_loader_from_libraries(json: &serde_json::Value) -> Option<&'static str> {
    let mut has_forge_fml = false;

    let mut scan_libraries = |libs: &[serde_json::Value]| -> Option<&'static str> {
        for library in libs {
            let Some(name) = library.get("name").and_then(|v| v.as_str()) else {
                continue;
            };
            let name = name.to_lowercase();
            if name.starts_with("net.neoforged:fancymodloader:")
                || name.starts_with("net.neoforged:neoforge:")
                || name.starts_with("net.neoforged:fmlloader:")
                || name.starts_with("net.neoforged:forge:")
                || name.starts_with("net.neoforged:fml:")
            {
                return Some("NeoForge");
            }
            if name.starts_with("net.minecraftforge:forge:")
                || name.starts_with("net.minecraftforge:fmlloader:")
            {
                has_forge_fml = true;
            }
            if name.starts_with("net.fabricmc:loader:")
                || name.starts_with("net.fabricmc:fabric-loader:")
            {
                return Some("Fabric");
            }
            if name.starts_with("org.quiltmc:quilt-loader:") {
                return Some("Quilt");
            }
            if name.starts_with("com.mumfrey:liteloader:") {
                return Some("LiteLoader");
            }
        }
        None
    };

    if let Some(libs) = json.get("libraries").and_then(|v| v.as_array()) {
        if let Some(result) = scan_libraries(libs) {
            return Some(result);
        }
    }

    if let Some(patches) = json.get("patches").and_then(|v| v.as_array()) {
        for patch in patches {
            if let Some(libs) = patch.get("libraries").and_then(|v| v.as_array()) {
                if let Some(result) = scan_libraries(libs) {
                    return Some(result);
                }
            }
        }
    }

    if has_forge_fml {
        Some("Forge")
    } else {
        None
    }
}

/// 从 version.json 的 arguments.game 参数中推断加载器类型。
///
/// NeoForge 会在 game 参数里携带 Forge 没有的专属键：
/// - `--fml.neoForgeVersion`
/// - `--fml.neoFormVersion`
/// - `--fml.neoForge`（NeoForge 1.20.2+）
///
/// 此外也扫描 json 其他顶层字段中是否出现 `neoforge` / `neoforged` 关键词，
/// 以覆盖某些启动器改写 arguments 后把 NeoForge 痕迹藏在别处的情况。
fn detect_loader_from_arguments(json: &serde_json::Value) -> Option<&'static str> {
    let check_game_args = |args: &[serde_json::Value]| -> Option<&'static str> {
        let mut iter = args.iter().peekable();
        while let Some(arg) = iter.next() {
            let Some(s) = arg.as_str() else { continue };
            let lower = s.to_lowercase();
            if lower == "--fml.neoforgeversion"
                || lower == "--fml.neoformversion"
                || lower == "--fml.neoforge"
            {
                return Some("NeoForge");
            }
            if lower == "--launchtarget" {
                if let Some(next) = iter.peek() {
                    if let Some(target) = next.as_str() {
                        let t = target.to_lowercase();
                        if matches!(
                            t.as_str(),
                            "forgeclient" | "neoforgeclient" | "forgeserver" | "neoforgeserver"
                        ) {
                            return Some("NeoForge");
                        }
                    }
                }
            }
        }
        None
    };

    if let Some(game_args) = json
        .get("arguments")
        .and_then(|v| v.get("game"))
        .and_then(|v| v.as_array())
    {
        if let Some(result) = check_game_args(game_args) {
            return Some(result);
        }
    }

    if let Some(patches) = json.get("patches").and_then(|v| v.as_array()) {
        for patch in patches {
            if let Some(game_args) = patch
                .get("arguments")
                .and_then(|v| v.get("game"))
                .and_then(|v| v.as_array())
            {
                if let Some(result) = check_game_args(game_args) {
                    return Some(result);
                }
            }
        }
    }

    let scan_str = |key: &str| -> Option<&'static str> {
        let v = json.get(key)?.as_str()?.to_lowercase();
        if v.contains("neoforge") || v.contains("neoforged") {
            Some("NeoForge")
        } else {
            None
        }
    };
    if let Some(r) = scan_str("id") {
        return Some(r);
    }
    if let Some(r) = scan_str("inheritsFrom") {
        return Some(r);
    }
    if let Some(r) = scan_str("type") {
        return Some(r);
    }
    if let Some(r) = json
        .get("downloads")
        .and_then(|d| d.get("installer"))
        .and_then(|u| u.get("url"))
        .and_then(|s| s.as_str())
        .and_then(|s| {
            let lower = s.to_lowercase();
            (lower.contains("neoforge") || lower.contains("neoforged")).then_some("NeoForge")
        })
    {
        return Some(r);
    }

    fn deep_scan_for_neoforge(v: &serde_json::Value) -> bool {
        match v {
            serde_json::Value::String(s) => {
                let lower = s.to_lowercase();
                lower.contains("neoforge") || lower.contains("neoforged")
            }
            serde_json::Value::Array(arr) => arr.iter().any(deep_scan_for_neoforge),
            serde_json::Value::Object(map) => {
                for (k, val) in map {
                    let lower = k.to_lowercase();
                    if lower.contains("neoforge") || lower.contains("neoforged") {
                        return true;
                    }
                    if deep_scan_for_neoforge(val) {
                        return true;
                    }
                }
                false
            }
            _ => false,
        }
    }
    if deep_scan_for_neoforge(json) {
        return Some("NeoForge");
    }

    None
}

/// 从版本文件夹名中快速推断加载器（备用方案）
fn detect_loader_from_name(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    let starts_with_mc_version = regex::Regex::new(r"^\d+\.\d+(?:\.\d+)?[-_]")
        .map(|re| re.is_match(&lower))
        .unwrap_or(false);
    // 使用更精确的匹配模式，避免误报
    // 例如： "-fabric-", "_fabric_", "-fabric", "fabric-", "fabric_" 等模式
    if lower.contains("optifine") {
        "OptiFine"
    } else if lower.contains("neoforge") {
        "NeoForge"
    } else if (starts_with_mc_version && (lower.contains("-fabric-") || lower.contains("_fabric_"))) ||
              lower.ends_with("-fabric") || lower.ends_with("_fabric") ||
              lower.starts_with("fabric-loader-") || lower.starts_with("fabric_loader_") ||
              lower.contains("-fabricloader-") || lower.contains("_fabricloader_") {
        "Fabric"
    } else if lower.contains("-quilt-") || lower.contains("_quilt_") ||
              lower.ends_with("-quilt") || lower.ends_with("_quilt") ||
              lower.starts_with("quilt-") || lower.starts_with("quilt_") ||
              lower.contains("-quiltloader-") || lower.contains("_quiltloader_") {
        "Quilt"
    } else if lower.contains("-forge-") || lower.contains("_forge_") ||
              lower.ends_with("-forge") || lower.ends_with("_forge") ||
              lower.starts_with("forge-") || lower.starts_with("forge_") {
        "Forge"
    } else if lower.contains("liteloader") {
        "LiteLoader"
    } else {
        "Vanilla"
    }
}

/// 从版本文件夹名称中提取原始 Minecraft 版本号
///
/// 支持的常见格式：
/// - "1.21.1" -> "1.21.1"
/// - "1.21.1-neoforge-4.0.1.20" -> "1.21.1"
/// - "1.21.1-forge-52.0.0" -> "1.21.1"
/// - "fabric-loader-0.15.0-1.21.1" -> "1.21.1"
/// - "quilt-loader-0.25.0-1.21.1" -> "1.21.1"
/// - "1.21.1-OptiFine_HD_U_I7_pre1" -> "1.21.1"
/// - "26.3-snapshot-5" -> "26.3"
/// - "25w42a" -> "25w42a"
fn extract_minecraft_version(name: &str) -> String {
    // 模式 1：快照版本格式，如 25w42a, 24w12a
    let snapshot_re = regex::Regex::new(r"^\d{2}w\d{2}[a-z]$").unwrap();
    if snapshot_re.is_match(name) {
        return name.to_string();
    }
    
    // 模式 2：以数字开头，后面跟 . 和数字，即 "x.y.z" 或 "x.y" 格式
    // 匹配 "1.21.1"、"1.21" 等开头的部分
    let standard_re = regex::Regex::new(r"^(\d+\.\d+(?:\.\d+)?)").unwrap();
    if let Some(caps) = standard_re.captures(name) {
        return caps.get(1).unwrap().as_str().to_string();
    }
    
    // 模式 3：版本号在字符串中间。一个名称可能同时包含加载器版本和
    // Minecraft 版本（如 fabric-loader-0.15.0-1.21.1），优先选 1.x，
    // 否则选日历版本中最后一个主版本 >= 20 的候选。
    let middle_re = regex::Regex::new(r"\d+\.\d+(?:\.\d+)?").unwrap();
    let candidates: Vec<&str> = middle_re.find_iter(name).map(|m| m.as_str()).collect();
    if let Some(version) = candidates.iter().find(|v| v.starts_with("1.")) {
        return (*version).to_string();
    }
    if let Some(version) = candidates.iter().rev().find(|v| {
        v.split('.').next().and_then(|n| n.parse::<u32>().ok()).unwrap_or(0) >= 20
    }) {
        return (*version).to_string();
    }
    
    // 模式 4：处理类似 "26.3-snapshot-5" 的格式
    let snapshot_ver_re = regex::Regex::new(r"^(\d+\.\d+)-snapshot").unwrap();
    if let Some(caps) = snapshot_ver_re.captures(name) {
        return caps.get(1).unwrap().as_str().to_string();
    }
    
    // 模式 5：处理单个数字版本，如 "26" (用于新的快照格式)
    let single_ver_re = regex::Regex::new(r"^(\d+)(?:[-_.]|$)").unwrap();
    if let Some(caps) = single_ver_re.captures(name) {
        let ver = caps.get(1).unwrap().as_str();
        // 只有当数字大于等于 20 时才认为是版本号（避免误判其他数字）
        if let Ok(num) = ver.parse::<u32>() {
            if num >= 20 {
                return ver.to_string();
            }
        }
    }
    
    // fallback：原样返回
    name.to_string()
}

/// 判断目录名本身是否是可识别的 Minecraft 版本标识。
///
/// assetIndex.id 是资源索引代号（例如 32），不是 Minecraft 版本；只有目录名
/// 确实像正式版或周快照时，才把它作为分组版本使用。
fn version_from_instance_name(name: &str) -> Option<String> {
    let release = regex::Regex::new(r"^\d+\.\d+(?:\.\d+)?(?:-.+)?$").ok()?;
    let weekly_snapshot = regex::Regex::new(r"^\d{2}w\d{2}[a-z]$").ok()?;
    // 新的快照格式，如 26, 26.3, 26.3-snapshot-5
    let new_snapshot = regex::Regex::new(r"^\d+(\.\d+)?(?:-snapshot)?$").ok()?;

    if release.is_match(name) {
        Some(extract_minecraft_version(name))
    } else if weekly_snapshot.is_match(name) {
        Some(name.to_string())
    } else if new_snapshot.is_match(name) {
        // 检查是否为合理的版本号（主版本号 >= 20）
        let extracted = extract_minecraft_version(name);
        if let Ok(num) = extracted.parse::<f32>() {
            if num >= 20.0 {
                Some(extracted)
            } else {
                None
            }
        } else {
            None
        }
    } else {
        None
    }
}

/// 合并型整合包实例没有 inheritsFrom，目录名也不一定带加载器名称。
/// 优先从加载器库坐标中读取真实 Minecraft 版本。
fn detect_minecraft_version_from_libraries(json: &serde_json::Value) -> Option<String> {
    let libraries = json.get("libraries")?.as_array()?;
    for library in libraries {
        let name = library.get("name")?.as_str()?;
        let parts: Vec<&str> = name.split(':').collect();
        if parts.len() < 3 {
            continue;
        }

        let group = parts[0];
        let artifact = parts[1];
        let version = parts[2];
        let carries_mc_version = (group == "net.minecraftforge"
            && (artifact == "forge" || artifact == "fmlloader"))
            || (group == "net.fabricmc" && artifact == "intermediary");
        if carries_mc_version {
            let detected = extract_minecraft_version(version);
            // 合并型整合包里 fabric 的 intermediary 会被改写成占位符 "0.0.0"，
            // 它不含真实版本信息，直接跳过，留给后续的 patches 检测。
            if detected != "0.0.0" && (detected != version || version.contains('.')) {
                return Some(detected);
            }
        }
    }
    None
}

/// 从合并型整合包 version.json 的 `patches` 字段读取真实 Minecraft 版本。
///
/// 合并型整合包的 JSON 会把补丁列表写入 `patches`，例如：
/// ```json
/// { "patches": [ { "id": "game", "version": "26.1.2", "priority": 0 } ] }
/// ```
/// 其中 `id == "game"` 的补丁携带的是真实的 Minecraft 版本号。
fn detect_minecraft_version_from_patches(json: &serde_json::Value) -> Option<String> {
    json.get("patches")?
        .as_array()?
        .iter()
        .find_map(|patch| {
            if patch.get("id").and_then(|v| v.as_str()) != Some("game") {
                return None;
            }
            let ver = patch.get("version").and_then(|v| v.as_str())?;
            let detected = extract_minecraft_version(ver);
            if version_from_instance_name(&detected).is_some() {
                Some(detected)
            } else {
                None
            }
        })
}

/// 扫描单个实例目录，构建 InstanceData
fn build_instance_data(instance_dir: &Path, minecraft_path: &Path) -> Option<InstanceData> {
    let name = instance_dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Unknown")
        .to_string();

    // 跳过 HMCL 特有的目录
    if name == ".hmcl" || name == "hmcl" {
        return None;
    }

    // 计算 mods 数量
    let mods_dir = instance_dir.join("mods");
    let mods_count = if mods_dir.is_dir() {
        std::fs::read_dir(&mods_dir)
            .map(|entries| entries.flatten().filter(|e| e.path().is_file()).count())
            .unwrap_or(0)
    } else {
        0
    };

    // 尝试从 versions/<name>/<name>.json 推断加载器与真实 MC 版本
    let version_json_path = minecraft_path
        .join("versions")
        .join(&name)
        .join(format!("{}.json", name));
    let (minecraft_version, loader) = if version_json_path.is_file() {
        match std::fs::read_to_string(&version_json_path) {
            Ok(content) => {
                match serde_json::from_str::<serde_json::Value>(&content) {
                    Ok(json) => {
                        // assetIndex.id 是资源索引代号，不是 Minecraft 版本。
                        // 合并型实例优先读补丁列表里的真实版本，其次读加载器库坐标，普通实例再读版本目录名。
                        let raw_ver = json
                            .get("inheritsFrom")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                            .or_else(|| detect_minecraft_version_from_patches(&json))
                            .or_else(|| detect_minecraft_version_from_libraries(&json))
                            .or_else(|| version_from_instance_name(&name))
                            .or_else(|| {
                                // 从 downloads.client.url 中匹配版本号
                                json.get("downloads")
                                    .and_then(|v| v.get("client"))
                                    .and_then(|v| v.get("url"))
                                    .and_then(|v| v.as_str())
                                    .and_then(|url| {
                                        let re = regex::Regex::new(
                                            r"/(\d+\.\d+(\.\d+)?(-pre\d+)?(-rc\d+)?(-snapshot)?)/",
                                        )
                                        .ok()?;
                                        re.captures(url)
                                            .and_then(|c| c.get(1))
                                            .map(|m| m.as_str().to_string())
                                    })
                            })
                            .unwrap_or(name.clone());
                        // 进一步提取纯版本号（防止 inheritsFrom 也包含加载器信息）
                        let mut mc_ver = extract_minecraft_version(&raw_ver);
                        // 如果提取到的版本看起来不合理（例如 "0.0.0" 或等于原始目录名），
                        // 那么尝试从目录名中再次提取一个更可信的版本号。
                        let is_plausible = version_from_instance_name(&mc_ver).is_some();
                        if !is_plausible || mc_ver == "0.0.0" || mc_ver == name {
                            let alt = extract_minecraft_version(&name);
                            if version_from_instance_name(&alt).is_some() {
                                mc_ver = alt;
                            }
                        }
                        // 从 mainClass 推断加载器，但用库坐标 / arguments / 文件夹名交叉验证
                        // （NeoForge 与 Forge 的 mainClass 同为 BootstrapLauncher，无法直接区分）
                        let from_main = json
                            .get("mainClass")
                            .and_then(|v| v.as_str())
                            .map(detect_loader_from_main_class)
                            .unwrap_or("Vanilla");
                        let from_name = detect_loader_from_name(&name);
                        let from_libs = detect_loader_from_libraries(&json);
                        let from_args = detect_loader_from_arguments(&json);
                        let loader = if from_name == "OptiFine"
                            && (from_main == "Forge"
                                || from_libs == Some("Forge")
                                || from_args == Some("Forge"))
                        {
                            // OptiFine 继承 Forge 的 mainClass 和库，但文件夹名明确是 OptiFine
                            "OptiFine"
                        } else if let Some(l) = from_libs {
                            // 1. 库坐标是最可靠的判据
                            l
                        } else if let Some(l) = from_args {
                            // 2. arguments.game 里的 NeoForge 专属参数是第二可靠的判据
                            //    （合并型整合包可能丢失 loader 库坐标，但 arguments 通常保留）
                            l
                        } else if from_main == "Forge" && from_name == "NeoForge" {
                            // 3. 无任何 loader 专属信号时，用文件夹名兜底区分
                            "NeoForge"
                        } else if from_main == "Vanilla" {
                            // mainClass 无法判断 → 用文件夹名
                            from_name
                        } else {
                            from_main
                        }
                        .to_string();
                        (mc_ver, loader)
                    }
                    Err(_) => (
                        extract_minecraft_version(&name),
                        detect_loader_from_name(&name).to_string(),
                    ),
                }
            }
            Err(_) => (
                extract_minecraft_version(&name),
                detect_loader_from_name(&name).to_string(),
            ),
        }
    } else {
        (
            extract_minecraft_version(&name),
            detect_loader_from_name(&name).to_string(),
        )
    };

    Some(InstanceData {
        name,
        minecraft_version,
        loader,
        mods_count,
    })
}

/// 目录条目信息
#[derive(Debug, Serialize)]
pub struct DirEntry {
    /// 文件或目录名（不含父路径）
    pub name: String,
    /// 文件完整路径
    pub path: String,
    /// 是否为目录
    pub is_dir: bool,
    /// 文件扩展名（小写，不含点；目录为空字符串）
    pub extension: String,
    /// 文件大小（字节），目录为 0
    pub size: u64,
    /// 修改时间（RFC3339 格式）
    pub modified: String,
}

// ── Tauri 命令 ────────────────────────────────────────────────

/// 扫描 instances 目录，返回所有实例的结构化信息
///
/// - `instances_path`: instances 目录的绝对路径（如 `<minecraft_path>/instance`）
#[tauri::command]
pub async fn vm_scan_instances(instances_path: String) -> Result<Vec<InstanceData>, String> {
    let path = Path::new(&instances_path);

    // minecraft_path 是 instances_path 的父目录（用于查找 versions/）
    let minecraft_path = path
        .parent()
        .ok_or_else(|| format!("无法获取父目录: {}", instances_path))?;

    if !path.exists() || !path.is_dir() {
        return Ok(vec![]);
    }

    let entries = std::fs::read_dir(path).map_err(|e| format!("读取实例目录失败: {}", e))?;

    let mut result = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            // 跳过 HMCL 特有的目录，避免误判
            if let Some(dir_name) = p.file_name().and_then(|n| n.to_str()) {
                // 明确跳过 HMCL 相关目录
                if dir_name == ".hmcl" || dir_name == "hmcl" {
                    continue;
                }
            }
            
            if let Some(data) = build_instance_data(&p, minecraft_path) {
                result.push(data);
            }
        }
    }

    Ok(result)
}

/// 扫描指定根目录下的 resourcepacks/ 文件夹，返回所有材质包信息
///
/// - `root_path`: 包含 `resourcepacks/` 子目录的根路径
#[tauri::command]
pub async fn vm_find_resource_packs(root_path: String) -> Result<Vec<ResourcePackInfo>, String> {
    let packs = resource_checker::find_resource_packs(&root_path);
    let result = packs
        .into_iter()
        .map(|(name, icon_path, mc_version_range)| ResourcePackInfo {
            name,
            icon_path,
            mc_version_range,
        })
        .collect();
    Ok(result)
}

/// 解析世界目录下的 level.dat，返回种子和游戏规则
///
/// - `world_folder_path`: 包含 `level.dat` 的世界文件夹绝对路径
#[tauri::command]
pub async fn vm_parse_level_dat(world_folder_path: String) -> Result<LevelDatInfo, String> {
    let raw = resource_checker::parse_level_dat(&world_folder_path)
        .ok_or_else(|| format!("无法解析 level.dat: {}", world_folder_path))?;

    // 原始格式：[seed, keepInventory, mobGriefing, doFireTick, allowCommands]
    let parse_bool = |s: &str| s.to_lowercase() == "true";

    Ok(LevelDatInfo {
        seed: raw.get(0).cloned().unwrap_or_default(),
        keep_inventory: raw.get(1).map(|s| parse_bool(s)).unwrap_or(false),
        mob_griefing: raw.get(2).map(|s| parse_bool(s)).unwrap_or(false),
        do_fire_tick: raw.get(3).map(|s| parse_bool(s)).unwrap_or(false),
        allow_commands: raw.get(4).map(|s| parse_bool(s)).unwrap_or(false),
    })
}

/// 修改世界目录中 level.dat 的游戏规则
///
/// - `world_folder_path`: 包含 `level.dat` 的世界文件夹绝对路径
/// - `param_name`: 规则名（keepInventory / mobGriefing / doFireTick / allowCommands）
/// - `new_value`: 新值（字符串，如 `"true"` / `"false"`）
#[tauri::command]
pub async fn vm_modify_game_rule(
    world_folder_path: String,
    param_name: String,
    new_value: String,
) -> Result<(), String> {
    resource_checker::modify_nbt_param_str(&world_folder_path, &param_name, &new_value)
}

/// 列出指定目录的直接子条目（一层，不递归）
///
/// - `dir_path`: 要列出的目录绝对路径
/// - `extensions_filter`: 允许通过的文件扩展名列表（小写，不含点），为空时返回所有文件和目录
#[tauri::command]
pub async fn vm_list_dir(
    dir_path: String,
    extensions_filter: Vec<String>,
) -> Result<Vec<DirEntry>, String> {
    let path = Path::new(&dir_path);
    let is_mods_dir = dir_path.replace('\\', "/").ends_with("/mods");
    if !path.exists() || !path.is_dir() {
        if is_mods_dir {
            let _ = crate::handler::runtime_log::append_runtime_log(
                "warn",
                "resources",
                "mods directory missing",
                Some(serde_json::json!({
                    "dirPath": dir_path,
                    "exists": path.exists(),
                    "isDir": path.is_dir(),
                })),
            );
        }
        return Ok(vec![]);
    }

    let entries = std::fs::read_dir(path).map_err(|e| format!("读取目录失败: {}", e))?;

    let mut result = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        let name = p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        if name.starts_with('.') {
            continue; // 跳过隐藏文件
        }
        let is_dir = p.is_dir();
        let extension = if is_dir {
            String::new()
        } else {
            p.extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase()
        };
        // 过滤扩展名
        if !extensions_filter.is_empty() && !is_dir {
            if !extensions_filter.iter().any(|f| f == &extension) {
                continue;
            }
        }
        let size = if is_dir {
            0
        } else {
            std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0)
        };
        
        let full_path = p.to_string_lossy().to_string();
        
        let modified = match std::fs::metadata(&p).and_then(|m| m.modified()) {
            Ok(t) => {
                if let Ok(duration) = t.duration_since(std::time::UNIX_EPOCH) {
                    format!("{}", duration.as_secs())
                } else {
                    String::new()
                }
            }
            Err(_) => String::new(),
        };
        
        result.push(DirEntry {
            name,
            path: full_path,
            is_dir,
            extension,
            size,
            modified,
        });
    }

    // 目录在前，文件在后；同类按名称排序
    result.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));

    Ok(result)
}

/// 删除实例目录中的指定文件
///
/// - `dir_path`: 文件所在的目录绝对路径
/// - `file_name`: 要删除的文件名
#[tauri::command]
pub async fn vm_delete_file(dir_path: String, file_name: String) -> Result<(), String> {
    let dir = Path::new(&dir_path);
    let file_path = dir.join(&file_name);
    if !file_path.exists() {
        return Err(format!("文件不存在: {}", file_path.display()));
    }
    if file_path.is_dir() {
        std::fs::remove_dir_all(&file_path).map_err(|e| format!("删除目录失败: {}", e))?;
    } else {
        std::fs::remove_file(&file_path).map_err(|e| format!("删除文件失败: {}", e))?;
    }
    Ok(())
}

fn validate_version_folder_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("版本文件夹名不能为空".to_string());
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("版本文件夹名包含非法路径字符".to_string());
    }
    Ok(())
}

fn ensure_version_dir_in_versions_root(
    versions_root: &Path,
    version_dir: &Path,
) -> Result<(), String> {
    if !version_dir.exists() {
        return Err(format!("版本目录不存在: {}", version_dir.display()));
    }
    if !version_dir.is_dir() {
        return Err(format!("目标路径不是目录: {}", version_dir.display()));
    }
    let normalized_target = version_dir
        .canonicalize()
        .unwrap_or_else(|_| version_dir.to_path_buf());
    let normalized_root = versions_root
        .canonicalize()
        .unwrap_or_else(|_| versions_root.to_path_buf());
    if !normalized_target.starts_with(&normalized_root) {
        return Err("拒绝操作：目录不在 versions 目录内".to_string());
    }
    Ok(())
}

fn update_version_json_id(text: &str, new_id: &str) -> Result<String, String> {
    let mut value: Value =
        serde_json::from_str(text).map_err(|e| format!("解析 version.json 失败: {}", e))?;
    let obj = value
        .as_object_mut()
        .ok_or_else(|| "version.json 顶层不是 JSON 对象".to_string())?;
    obj.insert("id".to_string(), Value::String(new_id.to_string()));
    serde_json::to_string_pretty(&value).map_err(|e| format!("序列化 version.json 失败: {}", e))
}

/// 版本目录重命名过程中的中间状态，用于任一步失败时回滚。
struct VersionDirRenameTxn {
    versions_root: PathBuf,
    old_name: String,
    new_name: String,
    original_json: String,
    json_updated: bool,
    jar_renamed: bool,
    natives_renamed: bool,
    dir_renamed: bool,
}

impl VersionDirRenameTxn {
    fn version_dir(&self) -> PathBuf {
        if self.dir_renamed {
            self.versions_root.join(&self.new_name)
        } else {
            self.versions_root.join(&self.old_name)
        }
    }

    fn revert(&mut self) -> Vec<String> {
        let mut failures = Vec::new();

        if self.dir_renamed {
            let from = self.versions_root.join(&self.new_name);
            let to = self.versions_root.join(&self.old_name);
            if let Err(e) = fs::rename(&from, &to) {
                failures.push(format!("还原版本目录失败: {}", e));
            } else {
                self.dir_renamed = false;
            }
        }

        let dir = self.versions_root.join(&self.old_name);

        if self.natives_renamed {
            let from = dir.join(format!("{}-natives", self.new_name));
            let to = dir.join(format!("{}-natives", self.old_name));
            if let Err(e) = fs::rename(&from, &to) {
                failures.push(format!("还原 natives 目录失败: {}", e));
            } else {
                self.natives_renamed = false;
            }
        }

        if self.jar_renamed {
            let from = dir.join(format!("{}.jar", self.new_name));
            let to = dir.join(format!("{}.jar", self.old_name));
            if let Err(e) = fs::rename(&from, &to) {
                failures.push(format!("还原 JAR 失败: {}", e));
            } else {
                self.jar_renamed = false;
            }
        }

        if self.json_updated {
            let old_json = dir.join(format!("{}.json", self.old_name));
            let new_json = dir.join(format!("{}.json", self.new_name));
            if let Err(e) = fs::write(&old_json, &self.original_json) {
                failures.push(format!("还原 version.json 失败: {}", e));
            } else {
                if new_json != old_json {
                    if let Err(e) = fs::remove_file(&new_json) {
                        if e.kind() != io::ErrorKind::NotFound {
                            failures.push(format!("删除临时 version.json 失败: {}", e));
                        }
                    }
                }
                self.json_updated = false;
            }
        }

        failures
    }
}

fn format_rename_error(step_error: String, rollback_failures: Vec<String>) -> String {
    if rollback_failures.is_empty() {
        step_error
    } else {
        format!(
            "{}（已尝试还原先前更改，但部分还原失败: {}）",
            step_error,
            rollback_failures.join("; ")
        )
    }
}

/// 重命名已安装版本目录（versions 下的文件夹及其 json/jar/natives）
#[tauri::command]
pub fn vm_rename_version_dir(
    minecraft_path: String,
    old_folder_name: String,
    new_folder_name: String,
) -> Result<String, String> {
    validate_version_folder_name(&old_folder_name)?;
    let new_name = sanitize_instance_name(new_folder_name.trim());
    validate_version_folder_name(&new_name)?;

    if new_name == old_folder_name {
        return Ok(new_name);
    }

    let mc_path = PathBuf::from(&minecraft_path);
    let versions_root = mc_path.join("versions");
    let old_dir = versions_root.join(&old_folder_name);
    let new_dir = versions_root.join(&new_name);

    ensure_version_dir_in_versions_root(&versions_root, &old_dir)?;

    if new_dir.exists() {
        return Err(format!("目标版本目录已存在: {}", new_dir.display()));
    }

    let old_json = old_dir.join(format!("{}.json", old_folder_name));
    if !old_json.is_file() {
        return Err(format!("找不到版本 JSON: {}", old_json.display()));
    }

    let original_json = fs::read_to_string(&old_json)
        .map_err(|e| format!("读取 version.json 失败: {}", e))?;

    let mut txn = VersionDirRenameTxn {
        versions_root: versions_root.clone(),
        old_name: old_folder_name.clone(),
        new_name: new_name.clone(),
        original_json,
        json_updated: false,
        jar_renamed: false,
        natives_renamed: false,
        dir_renamed: false,
    };

    let result: Result<(), String> = (|| {
        let updated_json = update_version_json_id(&txn.original_json, &txn.new_name)?;
        let work_dir = txn.version_dir();
        let new_json = work_dir.join(format!("{}.json", txn.new_name));
        fs::write(&new_json, updated_json)
            .map_err(|e| format!("写入 version.json 失败: {}", e))?;
        if new_json != old_json {
            fs::remove_file(&old_json).map_err(|e| format!("删除旧 version.json 失败: {}", e))?;
        }
        txn.json_updated = true;

        let old_jar = work_dir.join(format!("{}.jar", txn.old_name));
        if old_jar.is_file() {
            let new_jar = work_dir.join(format!("{}.jar", txn.new_name));
            if new_jar.exists() {
                return Err(format!("目标 JAR 已存在: {}", new_jar.display()));
            }
            fs::rename(&old_jar, &new_jar).map_err(|e| format!("重命名 JAR 失败: {}", e))?;
            txn.jar_renamed = true;
        }

        let old_natives = work_dir.join(format!("{}-natives", txn.old_name));
        if old_natives.is_dir() {
            let new_natives = work_dir.join(format!("{}-natives", txn.new_name));
            if new_natives.exists() {
                return Err(format!(
                    "目标 natives 目录已存在: {}",
                    new_natives.display()
                ));
            }
            fs::rename(&old_natives, &new_natives)
                .map_err(|e| format!("重命名 natives 目录失败: {}", e))?;
            txn.natives_renamed = true;
        }

        let work_dir = txn.version_dir();
        let old_dir = work_dir.clone();
        let new_dir = versions_root.join(&txn.new_name);
        fs::rename(&old_dir, &new_dir).map_err(|e| {
            if e.kind() == io::ErrorKind::PermissionDenied {
                format!("无法重命名版本目录（文件可能正在使用中）: {}", e)
            } else {
                format!("重命名版本目录失败: {}", e)
            }
        })?;
        txn.dir_renamed = true;

        Ok(())
    })();

    if let Err(step_error) = result {
        let rollback_failures = txn.revert();
        return Err(format_rename_error(step_error, rollback_failures));
    }

    println!(
        "[Version] 已重命名版本目录: {} -> {}",
        old_folder_name,
        new_name
    );
    Ok(new_name)
}

/// 重命名实例目录中的文件
///
/// - `dir_path`: 文件所在的目录绝对路径
/// - `old_name`: 原文件名
/// - `new_name`: 新文件名
#[tauri::command]
pub async fn vm_rename_file(
    dir_path: String,
    old_name: String,
    new_name: String,
) -> Result<(), String> {
    let dir = Path::new(&dir_path);
    let old_path = dir.join(&old_name);
    let new_path = dir.join(&new_name);
    if !old_path.exists() {
        return Err(format!("源文件不存在: {}", old_path.display()));
    }
    if new_path.exists() {
        return Err(format!("目标文件已存在: {}", new_path.display()));
    }
    std::fs::rename(&old_path, &new_path).map_err(|e| format!("重命名失败: {}", e))?;
    Ok(())
}

/// 将 Base64 编码的内容写入指定目录的文件
///
/// - `dir_path`: 目标目录绝对路径
/// - `file_name`: 要创建的文件名
/// - `content_base64`: Base64 编码的文件内容
#[tauri::command]
pub async fn vm_write_file_base64(
    dir_path: String,
    file_name: String,
    content_base64: String,
) -> Result<(), String> {
    let dir = Path::new(&dir_path);
    
    // 确保目录存在
    if !dir.exists() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {}", e))?;
    }
    
    let file_path = dir.join(&file_name);
    
    // 解码 Base64
    let content = base64::engine::general_purpose::STANDARD
        .decode(&content_base64)
        .map_err(|e| format!("Base64 解码失败: {}", e))?;
    
    // 写入文件
    std::fs::write(&file_path, content).map_err(|e| format!("写入文件失败: {}", e))?;
    
    Ok(())
}

/// 从 cache 中删除文件（彻底删除，不再移入实例）
///
/// - `kind`: 资源类型（mod, resourcepack, world, shaderpack, datapack, schematic, screenshot）
/// - `mc_version`: Minecraft 版本号
/// - `mod_loader`: 仅 kind = mod 时需要
/// - `file_name`: 要删除的文件名
#[tauri::command]
pub async fn vm_delete_cached_file(
    kind: String,
    mc_version: String,
    mod_loader: Option<String>,
    file_name: String,
) -> Result<(), String> {
    use crate::handler::cache_paths::{
        get_cache_dir_for_version, get_mod_cache_dir, parse_mod_loader, parse_resource_kind,
        CacheResourceKind,
    };

    let resource_kind = parse_resource_kind(&kind)?;

    let cache_dir = if resource_kind == CacheResourceKind::Mod {
        let loader_str = mod_loader.as_ref().map(|s| s.as_str()).unwrap_or("forge");
        let loader = parse_mod_loader(loader_str)?;
        get_mod_cache_dir(&mc_version, loader)?
    } else {
        get_cache_dir_for_version(resource_kind, &mc_version)?
    };

    let file_path = cache_dir.join(&file_name);
    if !file_path.exists() {
        return Err(format!("文件不存在: {}", file_path.display()));
    }
    if file_path.is_dir() {
        std::fs::remove_dir_all(&file_path).map_err(|e| format!("删除目录失败: {}", e))?;
    } else {
        std::fs::remove_file(&file_path).map_err(|e| format!("删除文件失败: {}", e))?;
    }
    Ok(())
}

/// Move all entries in the version-specific cache directory to the system trash/recycle bin.
#[tauri::command]
pub async fn vm_clear_version_cache(
    kind: String,
    mc_version: String,
    mod_loader: Option<String>,
) -> Result<u32, String> {
    use crate::handler::cache_paths::{
        get_cache_dir_for_version, get_mod_cache_dir, parse_mod_loader, parse_resource_kind,
        CacheResourceKind,
    };

    let resource_kind = parse_resource_kind(&kind)?;

    let cache_dir = if resource_kind == CacheResourceKind::Mod {
        let loader_str = mod_loader.as_ref().map(|s| s.as_str()).unwrap_or("forge");
        let loader = parse_mod_loader(loader_str)?;
        get_mod_cache_dir(&mc_version, loader)?
    } else {
        get_cache_dir_for_version(resource_kind, &mc_version)?
    };

    if !cache_dir.exists() {
        return Ok(0);
    }

    let mut removed = 0u32;
    let entries = std::fs::read_dir(&cache_dir).map_err(|e| format!("读取缓存目录失败: {}", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取缓存条目失败: {}", e))?;
        let path = entry.path();
        trash::delete(&path).map_err(|e| format!("移入回收站失败: {} ({})", path.display(), e))?;
        removed += 1;
    }
    Ok(removed)
}
