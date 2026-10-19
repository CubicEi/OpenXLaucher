use crate::downloader::original_dwl::process_version;
use crate::handler::config::get_launcher_paths_config;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};
static TASK_COUNTER: AtomicU64 = AtomicU64::new(1);
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
#[derive(Clone, Serialize)]
struct DownloadProgressPayload {
    task_id: u64,
    percent: f64,
}
#[derive(Clone, Serialize)]
struct DownloadFinishedPayload {
    task_id: u64,
    success: bool,
    error: Option<String>,
    failed_count: usize,
}
/// 获取平台默认游戏目录（作为 get_minecraft_dir 的回退值）
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
            .unwrap_or_else(|| std::env::temp_dir().join("RTLauncher").join("minecraft"));
    }
    #[cfg(target_os = "linux")]
    {
        return crate::app_paths::linux_minecraft_dir();
    }
    #[cfg(target_os = "windows")]
    {
        return std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .map(|appdata| appdata.join(".minecraft"))
            .unwrap_or_else(|| std::env::temp_dir().join("RTLauncher").join("minecraft"));
    }
}

/// 获取当前游戏目录。
/// 优先级：launcher.json -> selected_minecraft_path > 平台默认路径
pub fn get_minecraft_dir() -> Result<PathBuf, String> {
    let config = get_launcher_paths_config();
    if !config.selected_minecraft_path.trim().is_empty() {
        return Ok(PathBuf::from(config.selected_minecraft_path));
    }
    Ok(default_minecraft_dir())
}
#[tauri::command]
pub async fn download_patcher(
    app: AppHandle,
    mcVersion: String,
    instance_name: Option<String>,
) -> Result<u64, String> {
    let task_id = TASK_COUNTER.fetch_add(1, Ordering::SeqCst);
    let minecraft_path = get_minecraft_dir()?;
    std::fs::create_dir_all(&minecraft_path).map_err(|e| format!("创建目录失败: {}", e))?;
    let (tx, mut rx) = tokio::sync::mpsc::channel::<f64>(64);
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut tasks = active_tasks().lock().unwrap();
        tasks.insert(
            task_id,
            ActiveTaskInfo {
                cancel: cancel.clone(),
                mc_version: mcVersion.clone(),
                minecraft_path: minecraft_path.clone(),
            },
        );
    }
    let app_clone = app.clone();
    tokio::spawn(async move {
        while let Some(percent) = rx.recv().await {
            let _ = app_clone.emit(
                "download-progress",
                DownloadProgressPayload { task_id, percent },
            );
        }
    });
    let app_finish = app.clone();
    let version = mcVersion.clone();
    let cancel_clone = cancel.clone();
    let minecraft_path_cloned = minecraft_path.clone();
    let instance_name_cloned = instance_name.clone();
    tokio::spawn(async move {
        let result =
            process_version(&version, &minecraft_path_cloned, tx, cancel_clone.clone()).await;
        {
            let mut tasks = active_tasks().lock().unwrap();
            tasks.remove(&task_id);
        }
        let was_cancelled = cancel_clone.load(Ordering::SeqCst);
        if was_cancelled {
            let version_dir = minecraft_path_cloned.join("versions").join(&version);
            let _ = std::fs::remove_dir_all(&version_dir);
            let _ = app_finish.emit(
                "download-finished",
                DownloadFinishedPayload {
                    task_id,
                    success: false,
                    error: Some("已取消".to_string()),
                    failed_count: 0,
                },
            );
        } else {
            match result {
                Ok(warnings) => {
                    // 如果有自定义实例名，则创建单独的实例目录（复制原版json）
                    if let Some(inst_name) = instance_name_cloned {
                        let clean_name = super::shared_utils::sanitize_instance_name(&inst_name);
                        println!("[Vanilla] 创建实例目录: {}", clean_name);
                        let final_name = if clean_name.trim().is_empty() {
                            version.clone()
                        } else {
                            clean_name
                        };
                        if final_name != version {
                            let versions_dir = minecraft_path_cloned.join("versions");
                            let src_dir = versions_dir.join(&version);
                            let dst_dir = versions_dir.join(&final_name);
                            if src_dir.exists() && !dst_dir.exists() {
                                let _ = std::fs::create_dir_all(&dst_dir);
                                // 复制 version.json 和 jar
                                for ext in ["json", "jar"] {
                                    let src_file = src_dir.join(format!("{}.{}", version, ext));
                                    let dst_file = dst_dir.join(format!("{}.{}", final_name, ext));
                                    if src_file.exists() {
                                        let _ = std::fs::copy(&src_file, &dst_file);
                                    }
                                }
                                // 修改复制的 version.json 中的 id 字段
                                let dst_json = dst_dir.join(format!("{}.json", final_name));
                                if let Ok(content) = std::fs::read_to_string(&dst_json) {
                                    if let Ok(mut json) =
                                        serde_json::from_str::<serde_json::Value>(&content)
                                    {
                                        json["id"] = serde_json::Value::String(final_name.clone());
                                        if let Ok(new_content) = serde_json::to_string_pretty(&json)
                                        {
                                            let _ = std::fs::write(&dst_json, new_content);
                                            println!("[Vanilla] 实例创建完成: {}", final_name);
                                        }
                                    }
                                }
                            }
                        }
                    }
                    let failed_count = warnings.len();
                    let _ = app_finish.emit(
                        "download-finished",
                        DownloadFinishedPayload {
                            task_id,
                            success: true,
                            error: if failed_count > 0 {
                                Some(format!("{} 个文件下载失败", failed_count))
                            } else {
                                None
                            },
                            failed_count,
                        },
                    );
                }
                Err(e) => {
                    let _ = app_finish.emit(
                        "download-finished",
                        DownloadFinishedPayload {
                            task_id,
                            success: false,
                            error: Some(e.to_string()),
                            failed_count: 0,
                        },
                    );
                }
            }
        }
    });
    Ok(task_id)
}
#[tauri::command]
pub async fn cancel_download(taskId: u64) -> Result<(), String> {
    let tasks = active_tasks().lock().map_err(|e| e.to_string())?;
    if let Some(info) = tasks.get(&taskId) {
        info.cancel.store(true, Ordering::SeqCst);
    }
    Ok(())
}
