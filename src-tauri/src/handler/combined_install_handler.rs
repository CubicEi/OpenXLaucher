//! 组合安装入口：委托统一 version-install 会话（双任务下载/安装）。

use crate::downloader::version_install::{
    cancel_by_task_id, start_combined_legacy, LoaderSelection,
};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CombinedSelection {
    /// "forge" | "neoforge" | "fabric" | "quilt" | "liteloader" | "optifine" | "fabric_api"
    pub loader_type: String,
    pub version: String,
}

#[tauri::command]
pub async fn install_combined_package(
    app: AppHandle,
    mc_version: String,
    selections: Vec<CombinedSelection>,
    instance_name: Option<String>,
) -> Result<u64, String> {
    let sels: Vec<LoaderSelection> = selections
        .into_iter()
        .map(|s| LoaderSelection {
            loader_type: s.loader_type,
            version: s.version,
        })
        .collect();
    start_combined_legacy(app, mc_version, sels, instance_name).await
}

#[tauri::command]
pub async fn cancel_combined_download(taskId: u64) -> Result<(), String> {
    match cancel_by_task_id(taskId) {
        Ok(()) => Ok(()),
        Err(_) => {
            // Task may have finished or never registered.
            println!(
                "[Combined] 取消时未找到会话任务 {}（可能已结束）",
                taskId
            );
        Ok(())
        }
    }
}
