use crate::downloader::optifine_installer::{self, OptiFineVersionInfo};
use crate::downloader::version_install::{cancel_by_task_id, start_loader_legacy, LegacyEventFamily};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Debug, Serialize, Deserialize)]
pub struct OptifineInstallResult {
    pub message: String,
    pub version_folder: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OptifineVersion {
    pub id: String,
    pub filename: String,
    pub self_version: String,
    pub full_version: String,
    pub download_url: String,
    pub official_url: String,
    pub is_pre: bool,
}

#[tauri::command]
pub async fn get_optifine_versions(mc_version: String) -> Result<Vec<OptifineVersion>, String> {
    let versions = optifine_installer::get_optifine_versions(&mc_version)
        .await
        .map_err(|e| format!("获取 OptiFine 版本列表失败: {}", e))?;

    Ok(versions
        .into_iter()
        .map(|v: OptiFineVersionInfo| OptifineVersion {
            id: v.download_url.clone(),
            filename: format!("OptiFine_{}_{}.jar", v.game_version, v.self_version),
            self_version: v.self_version,
            full_version: v.full_version,
            download_url: v.download_url,
            official_url: v.official_url,
            is_pre: v.is_pre,
        })
        .collect())
}

#[tauri::command]
pub async fn get_optifine_version_names(mc_version: String) -> Result<Vec<String>, String> {
    let versions = optifine_installer::get_optifine_versions(&mc_version)
        .await
        .map_err(|e| format!("获取 OptiFine 版本列表失败: {}", e))?;
    Ok(versions
        .into_iter()
        .map(|v| format!("OptiFine_{}_{}.jar", v.game_version, v.self_version))
        .collect())
}

#[tauri::command]
pub async fn install_optifine(
    optifine_version: String,
    minecraft_dir: String,
    mc_version: String,
    optifine_fallback_url: Option<String>,
    _window: tauri::Window,
) -> Result<OptifineInstallResult, String> {
    let mc_dir = std::path::PathBuf::from(&minecraft_dir);
    let version_folder = if optifine_version.starts_with("http://")
        || optifine_version.starts_with("https://")
    {
        let fallback = optifine_fallback_url.unwrap_or_else(|| optifine_version.clone());
        optifine_installer::install_optifine_from_bmcl_with_fallback(
            &mc_version,
            &optifine_version,
            &fallback,
            &mc_dir,
        )
        .await
        .map_err(|e| format!("安装 OptiFine 失败: {}", e))?
    } else {
        let installer_path = std::path::PathBuf::from(&optifine_version);
        optifine_installer::install_optifine_from_local(&installer_path, &mc_dir, &mc_version)
            .await
            .map_err(|e| format!("安装 OptiFine 失败: {}", e))?
    };

    Ok(OptifineInstallResult {
        message: format!("OptiFine {} 已成功安装", optifine_version),
        version_folder: Some(version_folder),
    })
}

#[tauri::command]
pub async fn download_and_install_optifine(
    app: AppHandle,
    optifine_version: String,
    mc_version: String,
    instance_name: Option<String>,
    _optifine_fallback_url: Option<String>,
) -> Result<u64, String> {
    // Prefer the download URL / path as loader_version; fallback URL is best-effort
    // inside install_optifine_from_bmcl_with_fallback (same URL used as fallback).
    start_loader_legacy(
        app,
        "optifine",
        mc_version,
        optifine_version,
        None,
        instance_name,
        LegacyEventFamily::OptiFine,
    )
    .await
}

#[tauri::command]
pub async fn cancel_optifine_download(taskId: u64) -> Result<(), String> {
    let _ = cancel_by_task_id(taskId);
    Ok(())
}
