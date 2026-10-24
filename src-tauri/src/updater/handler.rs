use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::config::{get_update_config, should_check_update, UpdateConfig};
use super::fetcher::{UpdateCheckResult, UpdateFetcher, UpdateProgressCallback};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherUpdateProgressEvent {
    pub percent: f64,
}

pub const LAUNCHER_UPDATE_PROGRESS_EVENT: &str = "launcher-update-progress";

pub struct UpdaterState {
    fetcher: Arc<Mutex<UpdateFetcher>>,
}

#[tauri::command]
pub fn get_update_status() -> UpdateConfig {
    get_update_config()
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
    let on_progress: UpdateProgressCallback = Arc::new(move |percent| {
        let _ = app.emit(
            LAUNCHER_UPDATE_PROGRESS_EVENT,
            LauncherUpdateProgressEvent { percent },
        );
    });
    fetcher.download_update(Some(on_progress)).await
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

pub fn create_updater_state() -> UpdaterState {
    UpdaterState {
        fetcher: Arc::new(Mutex::new(UpdateFetcher::new())),
    }
}
