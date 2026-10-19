use crate::downloader::dwPatch::get_minecraft_dir;
use crate::downloader::modpack_installer::{self, ModpackFormat, ModpackLoaderType, ParsedModpack};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};
#[derive(Debug, Serialize, Deserialize)]
pub struct ModpackDetectResult {
    pub format: String, 
    pub recognizable: bool,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct ModpackInstallResult {
    pub success: bool,
    pub message: String,
    pub instance_name: Option<String>,
    pub file_count: Option<usize>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedModpackInfo {
    pub name: String,
    pub mc_version: String,
    pub loader_type: String, 
    pub loader_version: Option<String>,
    pub source_file: String,
    pub file_size: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedModpackEntry {
    pub name: String,
    pub mc_version: String,
    pub file_name: String,
    pub full_path: String,
    pub file_size: u64,
    pub format: String,
}
impl From<ModpackLoaderType> for String {
    fn from(value: ModpackLoaderType) -> Self {
        match value {
            ModpackLoaderType::Vanilla => "vanilla".to_string(),
            ModpackLoaderType::Forge => "forge".to_string(),
            ModpackLoaderType::Neoforge => "neoforge".to_string(),
            ModpackLoaderType::Fabric => "fabric".to_string(),
            ModpackLoaderType::Quilt => "quilt".to_string(),
            ModpackLoaderType::LiteLoader => "liteloader".to_string(),
            ModpackLoaderType::Optifine => "optifine".to_string(),
        }
    }
}
static MODPACK_TASK_COUNTER: AtomicU64 = AtomicU64::new(1000000);
struct ModpackActiveTask {
    cancel: Arc<AtomicBool>,
    _path: String,
}
fn active_tasks() -> &'static Mutex<std::collections::HashMap<u64, ModpackActiveTask>> {
    static INSTANCE: OnceLock<Mutex<std::collections::HashMap<u64, ModpackActiveTask>>> =
        OnceLock::new();
    INSTANCE.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}
fn get_modpack_cache_dir(minecraft_path_override: Option<String>) -> Result<PathBuf, String> {
    let mc_path = match minecraft_path_override {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => get_minecraft_dir().map_err(|e| e.to_string())?,
    };
    Ok(mc_path.join("cache").join("modpacks"))
}
#[tauri::command]
pub fn detect_modpack_format_cmd(path: String) -> Result<ModpackDetectResult, String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Ok(ModpackDetectResult {
            format: "unknown".to_string(),
            recognizable: false,
        });
    }
    let format = modpack_installer::detect_modpack_format(&p);
    match format {
        ModpackFormat::Modrinth => Ok(ModpackDetectResult {
            format: "modrinth".to_string(),
            recognizable: true,
        }),
        ModpackFormat::CurseForge => Ok(ModpackDetectResult {
            format: "curseforge".to_string(),
            recognizable: true,
        }),
        ModpackFormat::Unknown => Ok(ModpackDetectResult {
            format: "unknown".to_string(),
            recognizable: false,
        }),
    }
}
#[tauri::command]
pub fn parse_modpack_cmd(path: String) -> Result<ParsedModpackInfo, String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("文件不存在: {}", path));
    }
    let parsed: ParsedModpack =
        modpack_installer::parse_modpack_from_zip(&p).map_err(|e| e.to_string())?;
    let file_size = p.metadata().map(|m| m.len()).unwrap_or(0);
    Ok(ParsedModpackInfo {
        name: parsed.name,
        mc_version: parsed.mc_version,
        loader_type: parsed.loader_type.into(),
        loader_version: parsed.loader_version,
        source_file: p.to_string_lossy().to_string(),
        file_size,
    })
}
#[tauri::command]
pub fn save_modpack_to_cache_cmd(
    source_path: String,
    target_file_name: String,
) -> Result<String, String> {
    let src = PathBuf::from(&source_path);
    if !src.exists() {
        return Err(format!("源文件不存在: {}", source_path));
    }
    let parsed = modpack_installer::parse_modpack_from_zip(&src)
        .map_err(|e| format!("解析整合包失败: {}", e))?;
    let cache_dir = get_modpack_cache_dir(None)?.join(&parsed.mc_version);
    std::fs::create_dir_all(&cache_dir).map_err(|e| format!("创建缓存目录失败: {}", e))?;
    let file_name = if target_file_name.trim().is_empty() {
        src.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| format!("{}.mrpack", parsed.name))
    } else {
        let mut name = target_file_name;
        if !name.to_lowercase().ends_with(".zip")
            && !name.to_lowercase().ends_with(".mrpack")
            && !name.to_lowercase().ends_with(".jar")
        {
            name.push_str(".mrpack");
        }
        name
    };
    let target = cache_dir.join(&file_name);
    let final_target = if target.exists() {
        let stem = target
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "modpack".to_string());
        let ext = target
            .extension()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "mrpack".to_string());
        cache_dir.join(format!("{}_{}.{}", stem, chrono_now(), ext))
    } else {
        target
    };
    std::fs::copy(&src, &final_target).map_err(|e| format!("复制文件到缓存失败: {}", e))?;
    println!(
        "[Modpack] 已缓存整合包: {} -> {}",
        src.display(),
        final_target.display()
    );
    Ok(final_target.to_string_lossy().to_string())
}
#[tauri::command]
pub fn list_cached_modpacks_cmd(
    minecraft_path_override: Option<String>,
) -> Result<Vec<CachedModpackEntry>, String> {
    let cache_root = get_modpack_cache_dir(minecraft_path_override)?;
    let mut results: Vec<CachedModpackEntry> = Vec::new();
    if !cache_root.exists() {
        return Ok(results);
    }
    let mc_ver_dirs = match std::fs::read_dir(&cache_root) {
        Ok(d) => d,
        Err(e) => return Err(format!("读取缓存目录失败: {}", e)),
    };
    for mc_ver_entry in mc_ver_dirs.flatten() {
        let mc_ver_path = mc_ver_entry.path();
        if !mc_ver_path.is_dir() {
            continue;
        }
        let mc_version = mc_ver_path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        if let Ok(inner) = std::fs::read_dir(&mc_ver_path) {
            for file_entry in inner.flatten() {
                let file_path = file_entry.path();
                if !file_path.is_file() {
                    continue;
                }
                let lower = file_path.to_string_lossy().to_lowercase();
                if !lower.ends_with(".zip") && !lower.ends_with(".mrpack") {
                    continue;
                }
                let file_name = file_path
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();
                let stem = file_path
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| file_name.clone());
                let file_size = file_path.metadata().map(|m| m.len()).unwrap_or(0);
                let fmt = modpack_installer::detect_modpack_format(&file_path);
                let format_str = match fmt {
                    ModpackFormat::Modrinth => "modrinth".to_string(),
                    ModpackFormat::CurseForge => "curseforge".to_string(),
                    ModpackFormat::Unknown => "unknown".to_string(),
                };
                results.push(CachedModpackEntry {
                    name: stem,
                    mc_version: mc_version.clone(),
                    file_name: file_name.clone(),
                    full_path: file_path.to_string_lossy().to_string(),
                    file_size,
                    format: format_str,
                });
            }
        }
    }
    results.sort_by(|a, b| a.mc_version.cmp(&b.mc_version).then(a.name.cmp(&b.name)));
    Ok(results)
}
#[tauri::command]
pub fn install_modpack_from_zip_cmd(app: AppHandle, path: String) -> Result<u64, String> {
    let task_id = MODPACK_TASK_COUNTER.fetch_add(1, Ordering::SeqCst);
    let minecraft_dir = get_minecraft_dir().map_err(|e| e.to_string())?;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut tasks = active_tasks().lock().unwrap();
        tasks.insert(
            task_id,
            ModpackActiveTask {
                cancel: cancel.clone(),
                _path: path.clone(),
            },
        );
    }
    let app_clone = app.clone();
    let path_clone = path.clone();
    let minecraft_dir_clone = minecraft_dir.clone();
    tauri::async_runtime::spawn(async move {
        println!("[Modpack] 开始安装任务 {}: {}", task_id, path_clone);
        let _ = app_clone.emit(
            "modpack-progress",
            ModpackProgressPayload {
                task_id,
                percent: 0.0,
                stage: "初始化".to_string(),
                total_files: 0,
                downloaded_files: 0,
                current_file: String::new(),
            },
        );
        let (tx, mut rx) = tokio::sync::mpsc::channel::<(usize, usize, String, String)>(64);
        let app_for_progress = app_clone.clone();
        let progress_task = tokio::spawn(async move {
            while let Some((downloaded, total, fname, stage)) = rx.recv().await {
                let percent = if total <= 2 {
                    (downloaded as f64 / 2.0) * 100.0
                } else {
                    let external_count = (total - 2) as f64;
                    if downloaded == 0 {
                        0.0
                    } else if downloaded == 1 {
                        50.0
                    } else if downloaded == 2 {
                        60.0
                    } else {
                        let k = (downloaded - 2) as f64;
                        60.0 + (k / external_count) * 40.0
                    }
                };
                let percent = percent.clamp(0.0, 100.0);
                let _ = app_for_progress.emit(
                    "modpack-progress",
                    ModpackProgressPayload {
                        task_id,
                        percent,
                        stage,
                        total_files: total,
                        downloaded_files: downloaded,
                        current_file: fname,
                    },
                );
            }
        });
        let result = modpack_installer::install_modpack_from_zip(
            &PathBuf::from(&path_clone),
            &PathBuf::from(&minecraft_dir_clone),
            Some(tx),
            None, 
        )
        .await;
        progress_task.abort();
        let result_payload = match result {
            Ok((instance_name, file_count)) => {
                println!(
                    "[Modpack] 任务 {} 完成: 实例 {}, {} 个外部文件",
                    task_id, instance_name, file_count
                );
                ModpackFinishedPayload {
                    task_id,
                    success: true,
                    message: "整合包安装完成".to_string(),
                    instance_name: Some(instance_name),
                    file_count: Some(file_count),
                }
            }
            Err(e) => {
                println!("[Modpack] 任务 {} 失败: {}", task_id, e);
                ModpackFinishedPayload {
                    task_id,
                    success: false,
                    message: format!("安装失败: {}", e),
                    instance_name: None,
                    file_count: None,
                }
            }
        };
        let _ = app_clone.emit(
            "modpack-progress",
            ModpackProgressPayload {
                task_id,
                percent: 100.0,
                stage: "完成".to_string(),
                total_files: 0,
                downloaded_files: 0,
                current_file: String::new(),
            },
        );
        let _ = app_clone.emit("modpack-finished", result_payload);
        {
            let mut tasks = active_tasks().lock().unwrap();
            tasks.remove(&task_id);
        }
    });
    Ok(task_id)
}
#[tauri::command]
pub fn cancel_modpack_install(taskId: u64) -> Result<(), String> {
    let tasks = active_tasks().lock().unwrap();
    if let Some(task) = tasks.get(&taskId) {
        task.cancel.store(true, Ordering::SeqCst);
        return Ok(());
    }
    Ok(())
}
#[tauri::command]
pub fn delete_cached_modpack_cmd(full_path: String) -> Result<(), String> {
    let p = PathBuf::from(&full_path);
    if !p.exists() {
        return Err(format!("文件不存在: {}", full_path));
    }
    let cache_root = get_modpack_cache_dir(None)?;
    let normalized_target = p.canonicalize().unwrap_or_else(|_| p.clone());
    let normalized_root = cache_root
        .canonicalize()
        .unwrap_or_else(|_| cache_root.clone());
    if !normalized_target.starts_with(&normalized_root) {
        return Err(format!("拒绝删除：文件不在整合包缓存目录内"));
    }
    std::fs::remove_file(&p).map_err(|e| format!("删除文件失败: {}", e))?;
    println!("[Modpack] 已删除缓存整合包: {}", full_path);
    Ok(())
}
#[tauri::command]
pub fn delete_version_dir_cmd(minecraft_path: String, version_name: String) -> Result<(), String> {
    if version_name.is_empty() {
        return Err("版本名称不能为空".to_string());
    }
    let mc_path = PathBuf::from(&minecraft_path);
    let version_dir = mc_path.join("versions").join(&version_name);
    if !version_dir.exists() {
        return Err(format!("版本目录不存在: {}", version_dir.display()));
    }
    if !version_dir.is_dir() {
        return Err(format!("目标路径不是目录: {}", version_dir.display()));
    }
    let versions_root = mc_path.join("versions");
    let normalized_target = version_dir
        .canonicalize()
        .unwrap_or_else(|_| version_dir.clone());
    let normalized_root = versions_root
        .canonicalize()
        .unwrap_or_else(|_| versions_root.clone());
    if !normalized_target.starts_with(&normalized_root) {
        return Err("拒绝删除：目录不在 versions 目录内".to_string());
    }
    std::fs::remove_dir_all(&version_dir).map_err(|e| format!("删除版本目录失败: {}", e))?;
    println!("[Version] 已删除版本目录: {}", version_dir.display());
    Ok(())
}
fn chrono_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}
#[derive(Debug, Clone, Serialize)]
struct ModpackProgressPayload {
    task_id: u64,
    percent: f64,
    stage: String,
    total_files: usize,
    downloaded_files: usize,
    current_file: String,
}
#[derive(Debug, Clone, Serialize)]
struct ModpackFinishedPayload {
    task_id: u64,
    success: bool,
    message: String,
    instance_name: Option<String>,
    file_count: Option<usize>,
}