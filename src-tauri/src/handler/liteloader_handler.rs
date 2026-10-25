use crate::downloader::liteloader_installer;
use crate::downloader::version_install::{cancel_by_task_id, start_loader_legacy, LegacyEventFamily};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Debug, Serialize, Deserialize)]
pub struct LiteLoaderVersion {
    pub id: String,
    pub version: String,
}

#[tauri::command]
pub async fn get_liteloader_versions(mc_version: String) -> Result<Vec<LiteLoaderVersion>, String> {
    let version_names = liteloader_installer::get_liteloader_versions(&mc_version)
        .await
        .map_err(|e| format!("获取 LiteLoader 版本失败: {}", e))?;
    Ok(version_names
        .into_iter()
        .map(|v| LiteLoaderVersion {
            id: v.clone(),
            version: v,
        })
        .collect())
}

#[tauri::command]
pub async fn download_and_install_liteloader(
    app: AppHandle,
    mc_version: String,
    liteloader_version: String,
    instance_name: Option<String>,
) -> Result<u64, String> {
    start_loader_legacy(
        app,
        "liteloader",
        mc_version,
        liteloader_version,
        None,
        instance_name,
        LegacyEventFamily::LiteLoader,
    )
    .await
}

#[tauri::command]
pub async fn cancel_liteloader_download(taskId: u64) -> Result<(), String> {
    let _ = cancel_by_task_id(taskId);
    Ok(())
}
