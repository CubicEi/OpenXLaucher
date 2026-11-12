use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::config::{get_update_config, should_check_update, UpdateConfig};
use super::fetcher::{
    reconcile_local_update_package, UpdateCheckResult, UpdateFetcher, UpdateProgressCallback,
};
use super::config::save_update_config;

pub const LAUNCHER_UPDATE_PROGRESS_EVENT: &str = "launcher-update-progress";
pub const LAUNCHER_UPDATE_FINISHED_EVENT: &str = "launcher-update-finished";
/// 与前端任务队列共用的固定 task_id（同时仅允许一路启动器更新下载）。
pub const LAUNCHER_UPDATE_TASK_ID: u64 = 900_001;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LauncherUpdateTaskProgressPayload {
    task_id: u64,
    percent: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    downloaded: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LauncherUpdateTaskFinishedPayload {
    task_id: u64,
    success: bool,
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
}

pub struct UpdaterState {
    fetcher: Arc<Mutex<UpdateFetcher>>,
}

#[tauri::command]
pub fn get_update_status() -> UpdateConfig {
    get_update_config()
}

/// 对照 `launcher.json` 中的期望哈希扫描 `OpenX/update`，用于回到更新页时恢复「已下载、可安装」状态。
#[tauri::command(rename_all = "camelCase")]
pub fn sync_local_launcher_update() -> Result<UpdateConfig, String> {
    let mut cfg = get_update_config();
    if reconcile_local_update_package(&mut cfg) {
        let _ = save_update_config(cfg.clone());
    }
    Ok(cfg)
}

/// 设置「有更新时显示弹窗」。
#[tauri::command(rename_all = "camelCase")]
pub fn set_show_update_popup(enabled: bool) -> Result<UpdateConfig, String> {
    let mut cfg = get_update_config();
    cfg.show_update_popup = enabled;
    save_update_config(cfg.clone())?;
    Ok(cfg)
}

#[tauri::command]
pub async fn check_for_updates(
    app: AppHandle,
    state: State<'_, UpdaterState>,
    force: Option<bool>,
) -> Result<UpdateCheckResult, String> {
    let fetcher = {
        let fetcher = state.fetcher.lock().map_err(|e| e.to_string())?;
        fetcher.clone()
    };
    let current_version = app.package_info().version.to_string();
    fetcher
        .check_for_update(force.unwrap_or(false), &current_version)
        .await
}

#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    state: State<'_, UpdaterState>,
) -> Result<super::fetcher::DownloadResult, String> {
    let fetcher = {
        let fetcher = state.fetcher.lock().map_err(|e| e.to_string())?;
        fetcher.clone()
    };
    let label = {
        let cfg = get_update_config();
        cfg.target_version
            .as_ref()
            .map(|v| format!("启动器更新 v{}", v))
            .or_else(|| Some("启动器更新".to_string()))
    };
    let total_bytes = get_update_config().file_size;
    let app_progress = app.clone();
    let label_progress = label.clone();
    // 只发一次带 task_id 的进度事件，避免任务列表出现两条「启动器更新」。
    let on_progress: UpdateProgressCallback = Arc::new(move |percent| {
        let downloaded = total_bytes.map(|total| {
            ((percent / 100.0).clamp(0.0, 1.0) * total as f64) as u64
        });
        let _ = app_progress.emit(
            LAUNCHER_UPDATE_PROGRESS_EVENT,
            LauncherUpdateTaskProgressPayload {
                task_id: LAUNCHER_UPDATE_TASK_ID,
                percent,
                label: label_progress.clone(),
                downloaded,
                total: total_bytes,
            },
        );
    });
    let result = fetcher.download_update(Some(on_progress)).await;
    let finished = LauncherUpdateTaskFinishedPayload {
        task_id: LAUNCHER_UPDATE_TASK_ID,
        success: result.is_ok(),
        error: result.as_ref().err().cloned(),
        label,
    };
    let _ = app.emit(LAUNCHER_UPDATE_FINISHED_EVENT, finished);
    result
}

#[tauri::command]
pub async fn install_update(
    state: State<'_, UpdaterState>,
) -> Result<super::fetcher::InstallResult, String> {
    let fetcher = {
        let fetcher = state.fetcher.lock().map_err(|e| e.to_string())?;
        fetcher.clone()
    };
    fetcher.install_update().await
}

#[tauri::command]
pub fn cancel_update(state: State<'_, UpdaterState>) -> Result<(), String> {
    let fetcher = state.fetcher.lock().map_err(|e| e.to_string())?;
    fetcher.cancel();
    Ok(())
}

#[tauri::command]
pub fn can_check_update() -> bool {
    should_check_update()
}

#[tauri::command]
pub fn take_post_update_success() -> bool {
    super::update_ack::take_post_update_success_pending()
}

#[tauri::command]
pub fn take_post_update_failure() -> Option<String> {
    super::update_ack::take_post_update_failure_message()
}

pub fn create_updater_state() -> UpdaterState {
    UpdaterState {
        fetcher: Arc::new(Mutex::new(UpdateFetcher::new())),
    }
}
