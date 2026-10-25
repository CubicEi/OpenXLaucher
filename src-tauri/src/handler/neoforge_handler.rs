use crate::downloader::neoforge_installer;
use crate::downloader::version_install::{cancel_by_task_id, start_loader_legacy, LegacyEventFamily};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Debug, Serialize, Deserialize)]
pub struct NeoForgeInstallResult {
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct NeoForgeVersion {
    pub id: String,
    pub version: String,
}

#[tauri::command]
pub async fn get_neoforge_versions(mc_version: String) -> Result<Vec<NeoForgeVersion>, String> {
    let version_names = neoforge_installer::get_neoforge_versions(&mc_version)
        .await
        .map_err(|e| format!("获取 NeoForge 版本失败: {}", e))?;
    Ok(version_names
        .into_iter()
        .map(|v| NeoForgeVersion {
            id: v.clone(),
            version: v,
        })
        .collect())
}

#[tauri::command]
pub async fn download_and_install_neoforge(
    app: AppHandle,
    mc_version: String,
    neoforge_version: String,
    instance_name: Option<String>,
) -> Result<u64, String> {
    start_loader_legacy(
        app,
        "neoforge",
        mc_version,
        neoforge_version,
        None,
        instance_name,
        LegacyEventFamily::NeoForge,
    )
    .await
}

#[tauri::command]
pub async fn cancel_neoforge_download(taskId: u64) -> Result<(), String> {
    let _ = cancel_by_task_id(taskId);
    Ok(())
}
