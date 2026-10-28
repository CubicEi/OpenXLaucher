use crate::downloader::dwPatch::get_minecraft_dir;
use crate::downloader::quilt_installer;
use crate::downloader::version_install::{cancel_by_task_id, start_loader_legacy, LegacyEventFamily};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Debug, Serialize, Deserialize)]
pub struct QuiltInstallResult {
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct QuiltVersion {
    pub id: String,
    pub version: String,
}

#[tauri::command]
pub async fn get_quilt_loader_versions(mc_version: String) -> Result<Vec<QuiltVersion>, String> {
    let version_names = quilt_installer::get_quilt_loader_versions(&mc_version)
        .await
        .map_err(|e| format!("获取 Quilt Loader 版本失败: {}", e))?;
    Ok(version_names
        .into_iter()
        .map(|v| QuiltVersion {
            id: v.clone(),
            version: v,
        })
        .collect())
}

#[tauri::command]
pub async fn get_quilt_api_versions(mc_version: String) -> Result<Vec<QuiltVersion>, String> {
    let version_names = quilt_installer::get_quilt_api_versions(&mc_version)
        .await
        .map_err(|e| format!("获取 Quilt API 版本失败: {}", e))?;
    Ok(version_names
        .into_iter()
        .map(|v| QuiltVersion {
            id: v.clone(),
            version: v,
        })
        .collect())
}

#[tauri::command]
pub async fn install_quilt_loader(
    mc_version: String,
    loader_version: String,
    _window: tauri::Window,
) -> Result<QuiltInstallResult, String> {
    let minecraft_path = get_minecraft_dir()?;
    quilt_installer::install_quilt_loader(
        &mc_version,
        &loader_version,
        &minecraft_path.to_string_lossy().to_string(),
        None,
        None,
        None,
    )
    .await
    .map_err(|e| format!("安装 Quilt Loader 失败: {}", e))?;
    Ok(QuiltInstallResult {
        message: format!(
            "Quilt Loader {} 已成功安装到 Minecraft {}",
            loader_version, mc_version
        ),
    })
}

#[tauri::command]
pub async fn install_quilt_api(
    mc_version: String,
    api_version: String,
    _window: tauri::Window,
) -> Result<QuiltInstallResult, String> {
    let minecraft_path = get_minecraft_dir()?;
    quilt_installer::install_quilt_api(
        &mc_version,
        &api_version,
        &minecraft_path.to_string_lossy().to_string(),
        None,
    )
    .await
    .map_err(|e| format!("安装 Quilt API 失败: {}", e))?;
    Ok(QuiltInstallResult {
        message: format!(
            "Quilt API {} 已成功安装到 Minecraft {}",
            api_version, mc_version
        ),
    })
}

#[tauri::command]
pub async fn download_and_install_quilt(
    app: AppHandle,
    mc_version: String,
    loader_version: String,
    api_version: Option<String>,
    instance_name: Option<String>,
) -> Result<u64, String> {
    start_loader_legacy(
        app,
        "quilt",
        mc_version,
        loader_version,
        api_version,
        instance_name,
        LegacyEventFamily::Quilt,
    )
    .await
}

#[tauri::command]
pub async fn cancel_quilt_download(taskId: u64) -> Result<(), String> {
    let _ = cancel_by_task_id(taskId);
    Ok(())
}
