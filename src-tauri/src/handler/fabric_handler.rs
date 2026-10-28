use crate::downloader::dwPatch::get_minecraft_dir;
use crate::downloader::fabric_installer;
use crate::downloader::version_install::{cancel_by_task_id, start_loader_legacy, LegacyEventFamily};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Debug, Serialize, Deserialize)]
pub struct FabricInstallResult {
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FabricVersion {
    pub id: String,
    pub version: String,
}

#[tauri::command]
pub async fn get_fabric_loader_versions(
    mc_version: String,
    use_mirror: bool,
) -> Result<Vec<FabricVersion>, String> {
    let version_names = fabric_installer::get_fabric_loader_versions(&mc_version, use_mirror)
        .await
        .map_err(|e| format!("获取 Fabric Loader 版本失败: {}", e))?;
    Ok(version_names
        .into_iter()
        .map(|v| FabricVersion {
            id: v.clone(),
            version: v,
        })
        .collect())
}

#[tauri::command]
pub async fn get_fabric_api_versions(mc_version: String) -> Result<Vec<FabricVersion>, String> {
    let version_names = fabric_installer::get_fabric_api_versions(&mc_version)
        .await
        .map_err(|e| format!("获取 Fabric API 版本失败: {}", e))?;
    Ok(version_names
        .into_iter()
        .map(|v| FabricVersion {
            id: v.clone(),
            version: v,
        })
        .collect())
}

#[tauri::command]
pub async fn install_fabric_loader(
    mc_version: String,
    loader_version: String,
    use_mirror: bool,
    _window: tauri::Window,
) -> Result<FabricInstallResult, String> {
    let minecraft_path = get_minecraft_dir()?;
    fabric_installer::install_fabric_loader(
        &mc_version,
        &loader_version,
        &minecraft_path.to_string_lossy().to_string(),
        use_mirror,
        None,
        None,
        None,
    )
    .await
    .map_err(|e| format!("安装 Fabric Loader 失败: {}", e))?;
    Ok(FabricInstallResult {
        message: format!(
            "Fabric Loader {} 已成功安装到 Minecraft {}",
            loader_version, mc_version
        ),
    })
}

#[tauri::command]
pub async fn install_fabric_api(
    mc_version: String,
    api_version: String,
    _window: tauri::Window,
) -> Result<FabricInstallResult, String> {
    let minecraft_path = get_minecraft_dir()?;
    fabric_installer::install_fabric_api(
        &mc_version,
        &api_version,
        &minecraft_path.to_string_lossy().to_string(),
        None,
    )
    .await
    .map_err(|e| format!("安装 Fabric API 失败: {}", e))?;
    Ok(FabricInstallResult {
        message: format!(
            "Fabric API {} 已成功安装到 Minecraft {}",
            api_version, mc_version
        ),
    })
}

#[tauri::command]
pub async fn download_and_install_fabric(
    app: AppHandle,
    mc_version: String,
    loader_version: String,
    api_version: Option<String>,
    instance_name: Option<String>,
) -> Result<u64, String> {
    start_loader_legacy(
        app,
        "fabric",
        mc_version,
        loader_version,
        api_version,
        instance_name,
        LegacyEventFamily::Fabric,
    )
    .await
}

#[tauri::command]
pub async fn cancel_fabric_download(taskId: u64) -> Result<(), String> {
    let _ = cancel_by_task_id(taskId);
    Ok(())
}
