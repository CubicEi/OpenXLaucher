use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

use crate::downloader::modular_download::{download_file, DownloadTask, SingleDownloadResult};

#[derive(Debug, Serialize, Clone)]
struct CustomDownloadProgressPayload {
    task_id: u64,
    percent: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    downloaded: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    speed: Option<f64>,
}

#[derive(Debug, Serialize, Clone)]
struct CustomDownloadFinishedPayload {
    task_id: u64,
    success: bool,
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
}

struct CustomActiveTask {
    cancel: Arc<std::sync::atomic::AtomicBool>,
}

static CUSTOM_TASK_COUNTER: AtomicU64 = AtomicU64::new(50_000);

fn active_tasks() -> &'static Mutex<HashMap<u64, CustomActiveTask>> {
    static TASKS: OnceLock<Mutex<HashMap<u64, CustomActiveTask>>> = OnceLock::new();
    TASKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn sanitize_file_name(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return "download.bin".to_string();
    }
    let forbidden = ['\\', '/', ':', '*', '?', '"', '<', '>', '|'];
    let mut out = String::with_capacity(trimmed.len());
    for ch in trimmed.chars() {
        if forbidden.contains(&ch) || ch.is_control() {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    if out.is_empty() {
        "download.bin".to_string()
    } else {
        out
    }
}

fn filename_from_url(url: &str) -> String {
    if let Ok(parsed) = url::Url::parse(url) {
        if let Some(segments) = parsed.path_segments() {
            if let Some(last) = segments.filter(|s| !s.is_empty()).last() {
                return sanitize_file_name(last);
            }
        }
    }
    "download.bin".to_string()
}

fn validate_http_url(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url.trim()).map_err(|e| format!("无效的 URL: {}", e))?;
    match parsed.scheme() {
        "http" | "https" => Ok(()),
        other => Err(format!("仅支持 http/https，当前为 {}", other)),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn start_custom_download(
    app: AppHandle,
    url: String,
    directory: String,
    file_name: Option<String>,
) -> Result<u64, String> {
    validate_http_url(&url)?;
    let dir = PathBuf::from(directory.trim());
    if !dir.is_absolute() {
        return Err("保存目录必须是绝对路径".into());
    }
    fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {}", e))?;

    let file_name = file_name
        .filter(|s| !s.trim().is_empty())
        .map(|s| sanitize_file_name(&s))
        .unwrap_or_else(|| filename_from_url(&url));

    let task_id = CUSTOM_TASK_COUNTER.fetch_add(1, Ordering::SeqCst);
    let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let mut tasks = active_tasks().lock().unwrap();
        tasks.insert(
            task_id,
            CustomActiveTask {
                cancel: cancel.clone(),
            },
        );
    }

    let label = format!("自定义下载: {}", file_name);
    let download_task = DownloadTask {
        file_name: file_name.clone(),
        target_dir: dir.clone(),
        urls: vec![url.trim().to_string()],
        sha1: None,
    };

    let app_clone = app.clone();
    let (progress_tx, mut progress_rx) = tokio::sync::mpsc::channel::<(u64, u64)>(32);

    tokio::spawn(async move {
        let tid = task_id;
        let label_for_events = Some(label.clone());
        let app_progress = app_clone.clone();
        let progress_forward = tokio::spawn(async move {
            let mut last_downloaded = 0u64;
            let mut last_at = std::time::Instant::now();
            let mut primed = false;
            const MIN_SPEED_WINDOW_SECS: f64 = 0.3;
            const MAX_PLAUSIBLE_BPS: f64 = 500.0 * 1024.0 * 1024.0;
            while let Some((downloaded, total)) = progress_rx.recv().await {
                let percent = if total > 0 {
                    (downloaded as f64 / total as f64) * 100.0
                } else {
                    downloaded as f64 / 1_000_000.0
                };
                let elapsed = last_at.elapsed().as_secs_f64();
                let speed = if primed && elapsed >= MIN_SPEED_WINDOW_SECS {
                    let rate = (downloaded.saturating_sub(last_downloaded) as f64) / elapsed;
                    if rate > 0.0 && rate <= MAX_PLAUSIBLE_BPS {
                        Some(rate)
                    } else {
                        None
                    }
                } else {
                    None
                };
                if !primed || elapsed >= MIN_SPEED_WINDOW_SECS {
                    last_downloaded = downloaded;
                    last_at = std::time::Instant::now();
                    primed = true;
                }
                let _ = app_progress.emit(
                    "custom-download-progress",
                    CustomDownloadProgressPayload {
                        task_id: tid,
                        percent,
                        label: label_for_events.clone(),
                        downloaded: Some(downloaded),
                        total: if total > 0 { Some(total) } else { None },
                        speed,
                    },
                );
            }
        });

        let result = download_file(&download_task, Some(progress_tx), Some(cancel.clone())).await;
        let _ = progress_forward.await;

        active_tasks().lock().unwrap().remove(&task_id);

        match result {
            SingleDownloadResult::Success { path, .. } => {
                let _ = app_clone.emit(
                    "custom-download-finished",
                    CustomDownloadFinishedPayload {
                        task_id,
                        success: true,
                        error: None,
                        label: Some(label),
                        path: Some(path.to_string_lossy().to_string()),
                    },
                );
            }
            SingleDownloadResult::Failed { error, .. } => {
                let _ = app_clone.emit(
                    "custom-download-finished",
                    CustomDownloadFinishedPayload {
                        task_id,
                        success: false,
                        error: Some(error),
                        label: Some(label),
                        path: None,
                    },
                );
            }
        }
    });

    Ok(task_id)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn cancel_custom_download(task_id: u64) -> Result<(), String> {
    let tasks = active_tasks().lock().unwrap();
    if let Some(info) = tasks.get(&task_id) {
        info.cancel.store(true, Ordering::SeqCst);
        Ok(())
    } else {
        Err("任务不存在或已结束".into())
    }
}
