//! 单文件下载入口：封装多线程 / 单线程 Range 下载，供自定义下载与启动器更新共用。

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use tokio::sync::mpsc;

use super::modular_download::{download_file, DownloadTask, SingleDownloadResult};

/// 单文件下载请求。
#[derive(Debug, Clone)]
pub struct SingleFileDownloadRequest {
    pub url: String,
    pub target_dir: PathBuf,
    pub file_name: String,
    pub sha1: Option<String>,
    pub cancel: Option<Arc<AtomicBool>>,
}

/// 下载成功结果。
#[derive(Debug, Clone)]
pub struct SingleFileDownloadOutcome {
    pub path: PathBuf,
    pub size: u64,
    pub used_url: String,
}

pub fn error_is_cancelled(err: &str) -> bool {
    err.contains("已取消") || err.contains("取消")
}

/// 下载单个 URL 到 `target_dir/file_name`。
/// 进度通过 `progress_tx` 推送 `(downloaded_bytes, total_bytes)`。
pub async fn download_single_file(
    req: SingleFileDownloadRequest,
    progress_tx: Option<mpsc::Sender<(u64, u64)>>,
) -> Result<SingleFileDownloadOutcome, String> {
    if req.url.trim().is_empty() {
        return Err("下载地址为空".into());
    }
    if req.file_name.trim().is_empty() {
        return Err("文件名为空".into());
    }
    if req
        .file_name
        .contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
        || req.file_name.contains("..")
    {
        return Err(format!("非法的文件名: {}", req.file_name));
    }

    std::fs::create_dir_all(&req.target_dir).map_err(|e| format!("创建目录失败: {}", e))?;

    let task = DownloadTask {
        file_name: req.file_name,
        target_dir: req.target_dir,
        urls: vec![req.url.trim().to_string()],
        sha1: req.sha1,
    };

    match download_file(&task, progress_tx, req.cancel).await {
        SingleDownloadResult::Success {
            path,
            size,
            used_url,
            ..
        } => {
            if !path.is_file() {
                return Err(format!("下载完成但文件不存在: {}", path.display()));
            }
            Ok(SingleFileDownloadOutcome {
                path,
                size,
                used_url,
            })
        }
        SingleDownloadResult::Failed { error, .. } => Err(error),
    }
}

/// 下载到明确目标路径。
pub async fn download_url_to_path(
    url: &str,
    dest: &Path,
    cancel: Option<Arc<AtomicBool>>,
    progress_tx: Option<mpsc::Sender<(u64, u64)>>,
) -> Result<SingleFileDownloadOutcome, String> {
    let parent = dest
        .parent()
        .ok_or_else(|| "目标路径缺少父目录".to_string())?;
    let file_name = dest
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "目标路径缺少文件名".to_string())?
        .to_string();
    download_single_file(
        SingleFileDownloadRequest {
            url: url.to_string(),
            target_dir: parent.to_path_buf(),
            file_name,
            sha1: None,
            cancel,
        },
        progress_tx,
    )
    .await
}
