use crate::downloader::forge_installer;
use crate::downloader::version_install::{cancel_by_task_id, start_loader_legacy, LegacyEventFamily};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Debug, Serialize, Deserialize)]
pub struct ForgeInstallResult {
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ForgeVersion {
    pub id: String,
    pub version: String,
}

#[tauri::command]
pub async fn get_forge_versions(mc_version: String) -> Result<Vec<ForgeVersion>, String> {
    let version_names = forge_installer::get_forge_versions(&mc_version)
        .await
        .map_err(|e| format!("获取 Forge 版本失败: {}", e))?;
    Ok(version_names
        .into_iter()
        .map(|v| ForgeVersion {
            id: v.clone(),
            version: v,
        })
        .collect())
}

#[tauri::command]
pub async fn download_and_install_forge(
    app: AppHandle,
    mc_version: String,
    forge_version: String,
    instance_name: Option<String>,
) -> Result<u64, String> {
    start_loader_legacy(
        app,
        "forge",
        mc_version,
        forge_version,
        None,
        instance_name,
        LegacyEventFamily::Forge,
    )
    .await
}

#[tauri::command]
pub async fn cancel_forge_download(taskId: u64) -> Result<(), String> {
    let _ = cancel_by_task_id(taskId);
    Ok(())
}
