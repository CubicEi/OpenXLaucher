use crate::handler::config::get_launcher_paths_config;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::AppHandle;

struct ActiveTaskInfo {
    cancel: Arc<AtomicBool>,
    #[allow(dead_code)]
    mc_version: String,
    #[allow(dead_code)]
    minecraft_path: PathBuf,
}

fn active_tasks() -> &'static Mutex<HashMap<u64, ActiveTaskInfo>> {
    static INSTANCE: OnceLock<Mutex<HashMap<u64, ActiveTaskInfo>>> = OnceLock::new();
    INSTANCE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 获取平台默认游戏目录（作为 get_minecraft_dir 的回退值）。
/// Windows 便携版统一使用 exe 旁 `.minecraft`，不回落 APPDATA。
pub fn default_minecraft_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        return std::env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .map(|home| {
                home.join("Library")
                    .join("Application Support")
                    .join("minecraft")
            })
            .unwrap_or_else(|| std::env::temp_dir().join("OpenXLauncher").join("minecraft"));
    }
    #[cfg(target_os = "linux")]
    {
        return crate::app_paths::linux_minecraft_dir();
    }
    #[cfg(target_os = "windows")]
    {
        return crate::app_paths::portable_game_minecraft_dir();
    }
}

/// 获取当前游戏目录。
/// 优先级：launcher.json selected_minecraft_path > 平台默认路径（与 config::default_minecraft_path 一致）
pub fn get_minecraft_dir() -> Result<PathBuf, String> {
    let config = get_launcher_paths_config();
    let selected = config.selected_minecraft_path.trim();
    if !selected.is_empty() {
        return Ok(PathBuf::from(selected));
    }
    let fallback = if !config.default_minecraft_path.trim().is_empty() {
        PathBuf::from(config.default_minecraft_path.trim())
    } else {
        default_minecraft_dir()
    };
    Ok(fallback)
}

#[tauri::command]
pub async fn download_patcher(
    app: AppHandle,
    mcVersion: String,
    instance_name: Option<String>,
) -> Result<u64, String> {
    crate::downloader::version_install::start_vanilla_legacy(app, mcVersion, instance_name).await
}

#[tauri::command]
pub async fn cancel_download(taskId: u64) -> Result<(), String> {
    match crate::downloader::version_install::cancel_by_task_id(taskId) {
        Ok(()) => Ok(()),
        Err(_) => {
            // Fall back to legacy active_tasks map (in-flight pre-migration tasks).
            let tasks = active_tasks().lock().map_err(|e| e.to_string())?;
            if let Some(info) = tasks.get(&taskId) {
                info.cancel.store(true, Ordering::SeqCst);
            }
            Ok(())
        }
    }
}
