use anyhow::{anyhow, Context, Result};
use sha1::{Digest, Sha1};
use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, Semaphore};

use super::download_runtime_config;

pub const MAX_CONCURRENT_FILES: usize = 24;
pub const THROTTLE_MS_AFTER_FILE: u64 = 0;

pub fn is_download_cancelled(cancel: &Option<Arc<AtomicBool>>) -> bool {
    cancel.as_ref().is_some_and(|c| c.load(Ordering::SeqCst))
}
const SMART_INITIAL_CONCURRENCY: usize = 5;
const SMART_MIN_CONCURRENCY: usize = 2;
pub(crate) const SMART_MAX_CONCURRENCY: usize = 12;
const SMART_ADJUST_BATCH: usize = 8;
const CHUNKED_THRESHOLD: u64 = 256 * 1024;
const SMALL_CHUNK: u64 = 256 * 1024;
const MEDIUM_CHUNK: u64 = 1 * 1024 * 1024;
const LARGE_CHUNK: u64 = 4 * 1024 * 1024;
const STALL_BYTES_PER_SEC: u64 = 30 * 1024;
const MAX_RETRIES_PER_URL: u32 = 8;
const MAX_RETRIES_PER_CHUNK: u32 = 5;

fn workers_for_size(size: u64) -> usize {
    download_runtime_config::workers_for_file_size(size, CHUNKED_THRESHOLD)
}

/// 从 `Content-Range: bytes start-end/total` 解析整文件大小。
/// `total` 为 `*` 或缺失时返回 `None`——切勿用分片响应的 `Content-Length` 冒充整文件大小。
fn parse_content_range_total(header: &str) -> Option<u64> {
    let total = header.split('/').nth(1)?.trim();
    if total.is_empty() || total == "*" {
        return None;
    }
    total.parse::<u64>().ok().filter(|&n| n > 0)
}

fn chunk_size_for(size: u64) -> u64 {
    if size < 2 * 1024 * 1024 {
        SMALL_CHUNK
    } else if size < 20 * 1024 * 1024 {
        MEDIUM_CHUNK
    } else {
        LARGE_CHUNK
    }
}

#[derive(Debug, Clone)]
pub struct DownloadTask {
    pub file_name: String,
    pub target_dir: PathBuf,
    pub urls: Vec<String>,
    pub sha1: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DownloadFailure {
    pub file_name: String,
    pub error: String,
    pub urls_tried: Vec<String>,
}

#[derive(Debug)]
pub struct DownloadResult {
    pub success_count: usize,
    pub failures: Vec<DownloadFailure>,
}

#[derive(Debug)]
pub enum SingleDownloadResult {
    Success {
        path: PathBuf,
        used_url: String,
        sha1: Option<String>,
        size: u64,
    },
    Failed {
        error: String,
        urls_tried: Vec<String>,
    },
}

#[derive(Debug, Clone, Copy)]
struct ByteRange {
    /// Inclusive start offset.
    start: u64,
    /// Inclusive end offset.
    end: u64,
}

impl ByteRange {
    fn size(self) -> u64 {
        self.end.saturating_sub(self.start) + 1
    }
}

#[derive(Debug, Clone, Copy)]
struct ChunkJob {
    range: ByteRange,
    attempts: u32,
}

struct TempFileGuard {
    temp_path: PathBuf,
    target_path: PathBuf,
    cancel: Arc<AtomicBool>,
    armed: bool,
}

impl TempFileGuard {
    fn new(temp_path: PathBuf, target_path: PathBuf, cancel: Arc<AtomicBool>) -> Self {
        Self {
            temp_path,
            target_path,
            cancel,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }

    fn temp_path(&self) -> &Path {
        &self.temp_path
    }

    fn ensure_cleanup(&self) {
        if self.temp_path.exists() {
            let _ = fs::remove_file(&self.temp_path);
        }
        let part_path = self.target_path.with_extension(format!(
            "{}.part",
            self.target_path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("download")
        ));
        if part_path.exists() {
            let _ = fs::remove_file(&part_path);
        }
    }
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        if self.armed {
            self.cancel.store(true, Ordering::SeqCst);
            self.ensure_cleanup();
        }
    }
}

fn generate_temp_path(target: &Path) -> PathBuf {
    let base_name = target
        .file_name()
        .map(|s| s.to_string_lossy())
        .unwrap_or_default();
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    parent.join(format!(".downloading_{}", base_name))
}

fn verify_sha1(path: &Path, expected: &str) -> bool {
    match fs::read(path) {
        Ok(data) => {
            let mut hasher = Sha1::new();
            hasher.update(&data);
            let result = hasher.finalize();
            hex::encode(result).to_lowercase() == expected.to_lowercase()
        }
        Err(_) => false,
    }
}

pub async fn download_file(
    task: &DownloadTask,
    progress_tx: Option<mpsc::Sender<(u64, u64)>>,
    cancel: Option<Arc<AtomicBool>>,
) -> SingleDownloadResult {
    let total_start = Instant::now();
    let idle_secs = crate::http_client::DOWNLOAD_IDLE_TIMEOUT.as_secs();
    let file_name_for_log = if task.file_name.is_empty() {
        task.urls.first().cloned().unwrap_or_default()
    } else {
        task.file_name.clone()
    };

    println!(
        "[Download] ═══ 开始下载: {} | URL数: {} | 空闲超时: {}s ═══",
        file_name_for_log,
        task.urls.len(),
        idle_secs
    );

    let result = download_file_internal(task, progress_tx, cancel).await;

    println!(
        "[Download] ═══ 结束: {} | 总耗时: {:.1}s ═══",
        file_name_for_log,
        total_start.elapsed().as_secs_f64()
    );
    result
}

async fn download_file_internal(
    task: &DownloadTask,
    progress_tx: Option<mpsc::Sender<(u64, u64)>>,
    cancel: Option<Arc<AtomicBool>>,
) -> SingleDownloadResult {
    let mut resolved_file_name = task.file_name.clone();
    let mut resolved_sha1 = task.sha1.clone();
    let mut url_pool = task.urls.clone();
    
    if resolved_file_name.is_empty() {
        let first_url = task.urls.first().cloned().unwrap_or_default();
        println!("[Download] 文件名为空, 尝试识别: first_url={}", first_url);
        
        if is_cf_api_url(&first_url) {
            if let Some((pid, fid)) = extract_cf_ids(&first_url) {
                println!(
                    "[Download] 识别为 CurseForge: pid={}, fid={}, 开始解析真实文件名...",
                    pid, fid
                );

                if let Some((cf_file_name, cf_sha1, cdn_url)) =
                    resolve_cf_download_info(pid, fid).await
                {
                    resolved_file_name = cf_file_name;
                    if resolved_sha1.is_none() {
                        resolved_sha1 = cf_sha1;
                    }
                    if !cdn_url.is_empty() {
                        url_pool.insert(0, cdn_url.clone());
                    }
                    println!(
                        "[Download] CurseForge 解析完成: 文件名={}, CDN={}",
                        resolved_file_name, cdn_url
                    );
                } else {
                    // 兜底: 使用 format!("mod_{}.jar", fid)
                    let first4 = fid / 1000;
                    let last3 = fid % 1000;
                    let fallback_cdn = format!(
                        "https://edge.forgecdn.net/files/{}/{:03}/mod.jar",
                        first4, last3
                    );
                    url_pool.insert(0, fallback_cdn);
                    resolved_file_name = format!("mod_{}.jar", fid);
                    println!(
                        "[Download] CurseForge 解析失败, 使用兜底文件名: {}",
                        resolved_file_name
                    );
                }
            }
        }
        
        if resolved_file_name.is_empty() {
            if let Ok(url_obj) = reqwest::Url::parse(&first_url) {
                if let Some(last_segment) = url_obj.path_segments().and_then(|s| s.last()) {
                    if !last_segment.is_empty()
                        && last_segment != "file"
                        && last_segment != "download"
                        && !last_segment.starts_with("file.")
                    {
                        resolved_file_name = last_segment.to_string();
                    }
                }
            }
        }

        if resolved_file_name.is_empty() {
            resolved_file_name = format!(
                "file_{}.bin",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0)
            );
        }
    }
    
    let target = task.target_dir.join(&resolved_file_name);
    let cancel_arc = cancel.unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
    
    println!(
        "[Download] 开始: {} | 目标: {} | URL数: {}",
        resolved_file_name,
        target.display(),
        url_pool.len()
    );
    for (i, u) in url_pool.iter().enumerate() {
        println!("[Download]   [{}] {}", i, u);
    }
    
    if let Err(e) = fs::create_dir_all(&task.target_dir) {
        println!("[Download] ✗ 创建目录失败: {}", e);
        return SingleDownloadResult::Failed {
            error: format!("创建目录失败: {}", e),
            urls_tried: Vec::new(),
        };
    }
    
    if target.exists() {
        if let Some(sha) = &resolved_sha1 {
            if verify_sha1(&target, sha) {
                let size = fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
                println!(
                    "[Download] ✓ 已存在 (SHA1匹配): {} ({} bytes)",
                    resolved_file_name, size
                );
                if let Some(tx) = progress_tx.as_ref() {
                    let _ = tx.send((size, size)).await;
                }
                return SingleDownloadResult::Success {
                    path: target,
                    used_url: "(已存在)".to_string(),
                    sha1: Some(sha.clone()),
                    size,
                };
            }
            println!(
                "[Download] ! 文件存在但SHA1不匹配, 重新下载: {}",
                resolved_file_name
            );
            let _ = fs::remove_file(&target);
        } else {
            let size = fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
            println!(
                "[Download] ✓ 已存在 (无SHA1校验): {} ({} bytes)",
                resolved_file_name, size
            );
            if let Some(tx) = progress_tx.as_ref() {
                let _ = tx.send((size, size)).await;
            }
            return SingleDownloadResult::Success {
                path: target,
                used_url: "(已存在)".to_string(),
                sha1: resolved_sha1.clone(),
                size,
            };
        }
    }
    
    // 走到这里说明必须真正下载了，先推送一次 0% 让前端显示进度条
    if let Some(tx) = progress_tx.as_ref() {
        let _ = tx.try_send((0, 0));
    }
    
    let temp_path = generate_temp_path(&target);
    let mut guard = TempFileGuard::new(temp_path.clone(), target.clone(), cancel_arc.clone());
    
    let mut last_err: Option<String> = None;
    let mut urls_tried: Vec<String> = Vec::new();
    let mut url_idx = 0usize;
    
    for attempt in 0..MAX_RETRIES_PER_URL.max(1) {
        if url_pool.is_empty() {
            break;
        }
        
        let url = url_pool[url_idx % url_pool.len()].clone();
        urls_tried.push(url.clone());
        
        println!(
            "[Download] [{}] 尝试URL[{}]: {} | 文件: {}",
            attempt + 1,
            url_idx % url_pool.len(),
            url,
            resolved_file_name
        );
        url_idx += 1;
        
        match try_download_to_temp(
            &url,
            &temp_path,
            &target,
            &resolved_sha1,
            progress_tx.clone(),
            cancel_arc.clone(),
        )
        .await
        {
            Ok(()) => {
                if let Err(e) = finalize_download(&temp_path, &target) {
                    last_err = Some(format!("文件最终化失败: {}", e));
                    println!("[Download] ✗ 文件最终化失败: {}", e);
                    let _ = fs::remove_file(&temp_path);
                    let part_path = target.with_extension(format!(
                        "{}.part",
                        target
                            .extension()
                            .and_then(|e| e.to_str())
                            .unwrap_or("download")
                    ));
                    let _ = fs::remove_file(&part_path);
                    continue;
                }

                guard.disarm();
                remove_stale_downloading_temp(&target);

                if let Some(tx) = progress_tx.as_ref() {
                    let size = fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
                    let _ = tx.send((size, size.max(1))).await;
                }

                let size = fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
                println!(
                    "[Download] ✓ 成功: {} ({} bytes) | URL: {}",
                    resolved_file_name, size, url
                );
                return SingleDownloadResult::Success {
                    path: target,
                    used_url: url,
                    sha1: resolved_sha1.clone(),
                    size,
                };
            }
            Err(e) => {
                last_err = Some(e.to_string());
                println!("[Download] ✗ 失败: {} | 错误: {}", resolved_file_name, e);
                let _ = fs::remove_file(&temp_path);
                let part_path = target.with_extension(format!(
                    "{}.part",
                    target
                        .extension()
                        .and_then(|e| e.to_str())
                        .unwrap_or("download")
                ));
                let _ = fs::remove_file(&part_path);
            }
        }
    }
    
    println!(
        "[Download] ✗ 全部URL失败: {} | 最后错误: {}",
        resolved_file_name,
        last_err.as_ref().unwrap_or(&String::new())
    );
    let _ = fs::remove_file(&temp_path);
    let part_path = target.with_extension(format!(
        "{}.part",
        target
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("download")
    ));
    let _ = fs::remove_file(&part_path);
    
    SingleDownloadResult::Failed {
        error: last_err.unwrap_or_else(|| "未知错误".to_string()),
        urls_tried,
    }
}

async fn try_download_to_temp(
    url: &str,
    temp_path: &Path,
    _target: &Path,
    sha1: &Option<String>,
    progress_tx: Option<mpsc::Sender<(u64, u64)>>,
    cancel: Arc<AtomicBool>,
) -> Result<()> {
    let mut url_to_use = url.to_string();
    
    // CurseForge: 尝试多个 CDN 备用地址
    let mut curseforge_urls: Vec<String> = Vec::new();
    if url.contains("curseforge.com")
        || url.contains("edge.forgecdn.net")
        || url.contains("files-cf.curseforge.com")
    {
        if let Some((pid, fid)) = extract_cf_ids(url) {
            let first4 = fid / 1000;
            let last3 = fid % 1000;
            curseforge_urls.push(format!(
                "https://edge.forgecdn.net/files/{}/{:03}/",
                first4, last3
            ));
            curseforge_urls.push(format!(
                "https://files-cf.curseforge.com/file/curseforge-files/{}/{:03}/",
                first4, last3
            ));
            curseforge_urls.push(format!(
                "https://www.curseforge.com/minecraft/mc-mods/{}/download/{}/file",
                pid, fid
            ));
            curseforge_urls.push(format!(
                "https://www.curseforge.com/api/v1/mods/{}/files/{}/download",
                pid, fid
            ));
        }
    }
    
    // 如果是 CurseForge API URL，解析为 CDN 列表
    if url.contains("api.curseforge.com/v1/mods/") {
        if let Some((pid, fid)) = extract_cf_ids(url) {
            if let Some((_, _, cdn)) = resolve_cf_download_info(pid, fid).await {
                url_to_use = cdn.clone();
                let first4 = fid / 1000;
                let last3 = fid % 1000;
                curseforge_urls.push(cdn);
                curseforge_urls.push(format!(
                    "https://edge.forgecdn.net/files/{}/{:03}/",
                    first4, last3
                ));
                curseforge_urls.push(format!(
                    "https://files-cf.curseforge.com/file/curseforge-files/{}/{:03}/",
                    first4, last3
                ));
            }
        }
    }
    
    // 处理 Modrinth CDN 重定向
    if url_to_use.contains("cdn.modrinth.com")
        || url_to_use.contains("github.com")
        || url_to_use.contains("//cdn")
    {
        if let Ok(resolved) = crate::http_client::resolve_redirect_url(&url_to_use).await {
            if resolved != url_to_use {
                println!("[Download]   解析重定向: {} -> {}", url_to_use, resolved);
                url_to_use = resolved;
            }
        }
    }
    
    // Modrinth CDN
    if url_to_use.contains("cdn.modrinth.com") {
        println!("[Download]   使用浏览器风格下载 (Modrinth CDN)");
        return browser_style_download(
            &url_to_use,
            temp_path,
            sha1,
            progress_tx,
            cancel,
            "modrinth",
        )
        .await;
    }
    
    // CurseForge 多 CDN 容错：逐个尝试不同的 CDN 地址
    if !curseforge_urls.is_empty() {
        let mut last_err: Option<String> = None;
        for (i, cdn_url) in curseforge_urls.iter().enumerate() {
            println!("[Download]   尝试 CurseForge CDN [{}]: {}", i + 1, cdn_url);
            match browser_style_download(
                cdn_url,
                temp_path,
                sha1,
                progress_tx.clone(),
                cancel.clone(),
                "curseforge",
            )
            .await
            {
                Ok(()) => return Ok(()),
                Err(e) => {
                    last_err = Some(e.to_string());
                    println!("[Download]   ✗ CurseForge CDN [{}] 失败: {}", i + 1, e);
                    let _ = std::fs::remove_file(&temp_path);
                }
            }
        }
        return Err(anyhow!(
            "所有 CurseForge CDN 均失败: {}",
            last_err.unwrap_or_else(|| "未知错误".to_string())
        ));
    }
    
    if url_to_use.contains("curseforge.com") || url_to_use.contains("edge.forgecdn.net") {
        println!("[Download]   使用浏览器风格下载 (CurseForge)");
        return browser_style_download(
            &url_to_use,
            temp_path,
            sha1,
            progress_tx,
            cancel,
            "curseforge",
        )
        .await;
    }

    let is_maven_repo = url_to_use.contains("maven.neoforged.net/releases/")
        || url_to_use.contains("files.minecraftforge.net/maven/")
        || url_to_use.contains("bmclapi2.bangbang93.com/maven/")
        || url_to_use.contains("repo1.maven.org/maven2/")
        || url_to_use.contains("maven.fabricmc.net/");
    if is_maven_repo {
        println!("[Download]   使用单线程下载 (Maven 仓库)");
        let client = crate::http_client::shared_client().await;
        return single_threaded_download(&client, &url_to_use, temp_path, progress_tx, cancel)
            .await;
    }

    let client = crate::http_client::shared_client().await;
    let first_range_end = (MEDIUM_CHUNK - 1).min(u32::MAX as u64);
    
    println!(
        "[Download]   探测 Range请求: bytes=0-{} | URL: {}",
        first_range_end, url_to_use
    );
    let probe_resp = client
        .get(&url_to_use)
        .header(
            reqwest::header::RANGE,
            format!("bytes=0-{}", first_range_end),
        )
        .timeout(Duration::from_secs(10))
        .send()
        .await;
    
    let (total_size, mut first_chunk_data) = match probe_resp {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let final_url = resp.url().to_string();
            println!(
                "[Download]   探测响应: HTTP {} | 最终URL: {}",
                status, final_url
            );
            
            if status == 206 {
                let range_total = resp
                    .headers()
                    .get(reqwest::header::CONTENT_RANGE)
                    .and_then(|v| v.to_str().ok())
                    .and_then(parse_content_range_total);
                let header_partial_len = resp.content_length();

                // 没有明确整文件大小时，Content-Length 只是本次分片长度（常为 ~1MB），
                // 绝不能当作完整文件大小，否则会提前 finalize 出残缺文件。
                let Some(size) = range_total else {
                    println!(
                        "[Download]   ! HTTP 206 但缺少有效 Content-Range 总量 (partial≈{:?} bytes)，回退单线程下载",
                        header_partial_len
                    );
                    drop(resp);
                    return single_threaded_download(
                        &client,
                        &url_to_use,
                        temp_path,
                        progress_tx,
                        cancel,
                    )
                    .await;
                };

                let body = resp.bytes().await.unwrap_or_default();
                println!(
                    "[Download]   ✓ 支持Range (HTTP 206) | 文件大小: {} bytes | first_chunk: {} bytes",
                    size,
                    body.len()
                );

                if body.is_empty() {
                    println!("[Download]   ! Range请求返回空body，回退到单线程下载");
                    return single_threaded_download(
                        &client,
                        &url_to_use,
                        temp_path,
                        progress_tx,
                        cancel,
                    )
                    .await;
                }
                (size, Some(body.to_vec()))
            } else if status == 200 {
                let size = resp.content_length().unwrap_or(0);
                println!(
                    "[Download]   ! 不支持Range (HTTP 200) | 文件大小: {} bytes | 改用单线程下载",
                    size
                );
                drop(resp);
                return single_threaded_download(
                    &client,
                    &url_to_use,
                    temp_path,
                    progress_tx,
                    cancel,
                )
                .await;
            } else if (300..400).contains(&status) {
                println!(
                    "[Download]   ! 重定向响应 (HTTP {})，改用单线程下载",
                    status
                );
                drop(resp);
                return single_threaded_download(
                    &client,
                    &url_to_use,
                    temp_path,
                    progress_tx,
                    cancel,
                )
                .await;
            } else {
                return Err(anyhow!("HTTP {}", status));
            }
        }
        Err(e) => {
            println!("[Download]   ✗ 探测请求失败: {} | 改用单线程下载", e);
            return single_threaded_download(&client, &url_to_use, temp_path, progress_tx, cancel)
                .await;
        }
    };
    
    if total_size == 0 {
        return Err(anyhow!("文件大小为 0，无法下载"));
    }
    
    if total_size <= first_range_end + 1 {
        if let Some(data) = first_chunk_data {
            // 仅当探测分片已覆盖整文件时才可直接落盘；长度不足说明总量不可信或响应被截断。
            if !data.is_empty() && data.len() as u64 == total_size {
                println!("[Download]   小文件 ({} bytes), 直接写入", total_size);
                fs::write(temp_path, &data).with_context(|| "写入文件失败")?;

                if let Some(sha) = sha1 {
                    if !verify_sha1(temp_path, sha) {
                        let _ = fs::remove_file(temp_path);
                        return Err(anyhow!("SHA1 不匹配"));
                    }
                }
                if let Some(tx) = progress_tx.as_ref() {
                    let _ = tx.try_send((total_size, total_size));
                }
                return Ok(());
            }
            println!(
                "[Download]   ! 小文件探测不完整 (body={} / total={}), 回退单线程下载",
                data.len(),
                total_size
            );
        }
        println!("[Download]   走单线程下载");
        return single_threaded_download(&client, &url_to_use, temp_path, progress_tx, cancel)
            .await;
    }
    
    if total_size < CHUNKED_THRESHOLD {
        println!(
            "[Download]   文件小于 CHUNKED_THRESHOLD ({} bytes), 走单线程下载",
            total_size
        );
        return single_threaded_download(&client, &url_to_use, temp_path, progress_tx, cancel)
            .await;
    }
    
    parallel_range_download(
        &client,
        &url_to_use,
        temp_path,
        total_size,
        first_chunk_data.take(),
        sha1,
        progress_tx,
        cancel,
    )
    .await
}

/// 多线程 Range 下载：分片拉齐后按偏移直接写盘，仅在落盘成功后计入进度。
async fn parallel_range_download(
    client: &reqwest::Client,
    url: &str,
    temp_path: &Path,
    total_size: u64,
    first_chunk: Option<Vec<u8>>,
    sha1: &Option<String>,
    progress_tx: Option<mpsc::Sender<(u64, u64)>>,
    cancel: Arc<AtomicBool>,
) -> Result<()> {
    let workers = workers_for_size(total_size).max(1);
    let chunk_len = chunk_size_for(total_size).max(32 * 1024);
    println!(
        "[Download]   分片模式下载 | 总大小: {} bytes | workers: {} | chunk: {} bytes",
        total_size, workers, chunk_len
    );

    preallocate_file(temp_path, total_size).context("预分配文件失败")?;

    let file = Arc::new(StdMutex::new({
        use std::fs::OpenOptions;
        use std::io::{Seek, SeekFrom, Write};
        let mut f = OpenOptions::new()
            .write(true)
            .read(true)
            .open(temp_path)
            .with_context(|| format!("打开临时文件失败: {}", temp_path.display()))?;
        // 确保不会因其它句柄截断；长度已由 preallocate 设定。
        let _ = f.seek(SeekFrom::Start(0));
        let _ = Write::flush(&mut f);
        f
    }));

    // written：已成功落盘字节（完成校验用）
    // progress：含在途分片已接收字节（UI 进度/速度用），失败分片会回滚
    let written = Arc::new(AtomicU64::new(0));
    let progress = Arc::new(AtomicU64::new(0));
    let failed = Arc::new(AtomicBool::new(false));
    let error_msg: Arc<StdMutex<Option<String>>> = Arc::new(StdMutex::new(None));

    let mut cursor = 0u64;
    if let Some(data) = first_chunk {
        if !data.is_empty() {
            let n = data.len() as u64;
            if n > total_size {
                return Err(anyhow!(
                    "探测分片大于声明文件大小: {} > {}",
                    n,
                    total_size
                ));
            }
            write_at_offset(&file, 0, &data)?;
            written.fetch_add(n, Ordering::SeqCst);
            progress.fetch_add(n, Ordering::SeqCst);
            cursor = n;
            if let Some(tx) = progress_tx.as_ref() {
                let _ = tx.send((n, total_size)).await;
            }
            println!("[Download]   已写入探测分片: {} bytes", n);
        }
    }

    let jobs: Arc<StdMutex<VecDeque<ChunkJob>>> = Arc::new(StdMutex::new({
        let mut q = VecDeque::new();
        while cursor < total_size {
            let end = (cursor + chunk_len - 1).min(total_size - 1);
            q.push_back(ChunkJob {
                range: ByteRange {
                    start: cursor,
                    end,
                },
                attempts: 0,
            });
            cursor = end + 1;
        }
        q
    }));
    let in_flight = Arc::new(AtomicU64::new(0));

    let progress_tx_mon = progress_tx.clone();
    let progress_mon = progress.clone();
    let written_mon = written.clone();
    let failed_mon = failed.clone();
    let cancel_mon = cancel.clone();
    let progress_monitor = tokio::spawn(async move {
        let mut last_sent = u64::MAX;
        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if cancel_mon.load(Ordering::SeqCst) || failed_mon.load(Ordering::SeqCst) {
                break;
            }
            let done = progress_mon
                .load(Ordering::SeqCst)
                .max(written_mon.load(Ordering::SeqCst))
                .min(total_size);
            // 只在字节变化时推送，避免塞满有界 channel 导致后续进度被 try_send 丢掉
            if done != last_sent {
                if let Some(tx) = progress_tx_mon.as_ref() {
                    if tx.send((done, total_size)).await.is_err() {
                        break;
                    }
                }
                last_sent = done;
            }
            if written_mon.load(Ordering::SeqCst) >= total_size {
                break;
            }
        }
    });

    let mut handles = Vec::with_capacity(workers);
    for _ in 0..workers {
        let client = client.clone();
        let url = url.to_string();
        let file = file.clone();
        let jobs = jobs.clone();
        let written = written.clone();
        let progress = progress.clone();
        let failed = failed.clone();
        let error_msg = error_msg.clone();
        let cancel = cancel.clone();
        let in_flight = in_flight.clone();

        handles.push(tokio::spawn(async move {
            loop {
                if cancel.load(Ordering::SeqCst) || failed.load(Ordering::SeqCst) {
                    return;
                }

                let job = {
                    let mut q = jobs.lock().unwrap();
                    q.pop_front()
                };
                let Some(job) = job else {
                    if in_flight.load(Ordering::SeqCst) == 0 {
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(40)).await;
                    continue;
                };

                in_flight.fetch_add(1, Ordering::SeqCst);
                let range = job.range;
                let result = fetch_and_write_range(
                    &client,
                    &url,
                    &file,
                    range,
                    &progress,
                    &cancel,
                    &failed,
                )
                .await;

                match result {
                    Ok(()) => {
                        in_flight.fetch_sub(1, Ordering::SeqCst);
                        let n = range.size();
                        written.fetch_add(n, Ordering::SeqCst);
                        println!(
                            "[Download]     ✓ chunk {}-{} 落盘 ({} bytes)",
                            range.start, range.end, n
                        );
                    }
                    Err(e) => {
                        if cancel.load(Ordering::SeqCst) {
                            in_flight.fetch_sub(1, Ordering::SeqCst);
                            return;
                        }
                        let attempts = job.attempts + 1;
                        println!(
                            "[Download]     ✗ chunk {}-{} 失败 ({}/{}): {}",
                            range.start, range.end, attempts, MAX_RETRIES_PER_CHUNK, e
                        );
                        if attempts >= MAX_RETRIES_PER_CHUNK {
                            failed.store(true, Ordering::SeqCst);
                            if let Ok(mut guard) = error_msg.lock() {
                                *guard = Some(format!(
                                    "chunk {}-{} 重试耗尽: {}",
                                    range.start, range.end, e
                                ));
                            }
                            in_flight.fetch_sub(1, Ordering::SeqCst);
                            return;
                        }
                        // 先入队再减少 in_flight，避免其它 worker 误判“队列空且无在途”而提前退出。
                        {
                            let mut q = jobs.lock().unwrap();
                            q.push_back(ChunkJob { range, attempts });
                        }
                        in_flight.fetch_sub(1, Ordering::SeqCst);
                    }
                }
            }
        }));
    }

    for h in handles {
        let _ = h.await;
    }
    let _ = progress_monitor.await;

    // flush + 释放句柄，便于后续 rename / 校验。
    {
        use std::io::Write;
        if let Ok(mut guard) = file.lock() {
            let _ = guard.flush();
            let _ = guard.sync_all();
        }
    }
    drop(file);

    if cancel.load(Ordering::SeqCst) {
        return Err(anyhow!("已取消"));
    }
    if failed.load(Ordering::SeqCst) {
        let msg = error_msg
            .lock()
            .ok()
            .and_then(|g| g.clone())
            .unwrap_or_else(|| "分片下载失败".to_string());
        return Err(anyhow!(msg));
    }

    // 队列必须清空，否则仍有未完成分片。
    {
        let pending = jobs.lock().unwrap().len();
        if pending > 0 {
            return Err(anyhow!("分片下载未完成: 仍有 {} 个分片待处理", pending));
        }
    }

    let counted = written.load(Ordering::SeqCst);
    if counted != total_size {
        return Err(anyhow!(
            "写入计数不匹配: {}/{} 字节",
            counted,
            total_size
        ));
    }

    let on_disk = fs::metadata(temp_path)
        .map(|m| m.len())
        .unwrap_or(0);
    if on_disk != total_size {
        return Err(anyhow!(
            "磁盘文件大小不匹配: {}/{} 字节 ({})",
            on_disk,
            total_size,
            temp_path.display()
        ));
    }

    if let Some(sha) = sha1 {
        println!("[Download]   校验SHA1: {}", sha);
        if !verify_sha1(temp_path, sha) {
            return Err(anyhow!("SHA1 不匹配"));
        }
        println!("[Download]   ✓ SHA1匹配");
    }

    if let Some(tx) = progress_tx.as_ref() {
        let _ = tx.send((total_size, total_size)).await;
    }
    println!(
        "[Download]   ✓ 分片下载完成: {} bytes → {}",
        total_size,
        temp_path.display()
    );
    Ok(())
}

fn write_at_offset(file: &Arc<StdMutex<std::fs::File>>, offset: u64, data: &[u8]) -> Result<()> {
    use std::io::{Seek, SeekFrom, Write};
    let mut guard = file
        .lock()
        .map_err(|_| anyhow!("写文件锁中毒"))?;
    guard
        .seek(SeekFrom::Start(offset))
        .with_context(|| format!("seek 到 {} 失败", offset))?;
    guard.write_all(data).context("写入分片失败")?;
    Ok(())
}

async fn fetch_and_write_range(
    client: &reqwest::Client,
    url: &str,
    file: &Arc<StdMutex<std::fs::File>>,
    range: ByteRange,
    progress: &AtomicU64,
    cancel: &AtomicBool,
    failed: &AtomicBool,
) -> Result<()> {
    let _permit = download_runtime_config::worker_semaphore()
        .acquire_owned()
        .await
        .map_err(|_| anyhow!("下载 worker 池已关闭"))?;

    if cancel.load(Ordering::SeqCst) || failed.load(Ordering::SeqCst) {
        return Err(anyhow!("已取消或已失败"));
    }

    let range_header = format!("bytes={}-{}", range.start, range.end);
    let resp = client
        .get(url)
        .header(reqwest::header::RANGE, &range_header)
        .send()
        .await
        .with_context(|| format!("请求 chunk {}-{} 失败", range.start, range.end))?;

    let status = resp.status().as_u16();
    if status != 206 && status != 200 {
        return Err(anyhow!(
            "HTTP {} (bytes {}-{})",
            status,
            range.start,
            range.end
        ));
    }

    // 必须是分片响应；若服务端忽略 Range 返回整文件，长度会对不上并失败重试/回退。
    if status == 200 {
        let len = resp.content_length().unwrap_or(0);
        if len != range.size() {
            return Err(anyhow!(
                "服务端未按 Range 返回分片 (HTTP 200, len={}, expected={})",
                len,
                range.size()
            ));
        }
    }

    use futures::stream::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut buffer = Vec::with_capacity(range.size() as usize);
    let idle_timeout = crate::http_client::DOWNLOAD_IDLE_TIMEOUT;
    let mut last_bytes = Instant::now();
    let mut credited: u64 = 0;

    let rollback = |credited: u64| {
        if credited > 0 {
            progress.fetch_sub(credited, Ordering::SeqCst);
        }
    };

    loop {
        if cancel.load(Ordering::SeqCst) || failed.load(Ordering::SeqCst) {
            rollback(credited);
            return Err(anyhow!("已取消或已失败"));
        }
        match tokio::time::timeout(idle_timeout, stream.next()).await {
            Err(_) => {
                rollback(credited);
                return Err(anyhow!(
                    "chunk 读取超时 ({}s 内未收到数据)",
                    idle_timeout.as_secs()
                ));
            }
            Ok(None) => break,
            Ok(Some(Ok(data))) => {
                if data.is_empty() {
                    continue;
                }
                let n = data.len() as u64;
                buffer.extend_from_slice(&data);
                progress.fetch_add(n, Ordering::SeqCst);
                credited += n;
                last_bytes = Instant::now();
                if buffer.len() as u64 > range.size() {
                    rollback(credited);
                    return Err(anyhow!(
                        "chunk 数据过长 (bytes {}-{}): {} > {}",
                        range.start,
                        range.end,
                        buffer.len(),
                        range.size()
                    ));
                }
            }
            Ok(Some(Err(e))) => {
                rollback(credited);
                if last_bytes.elapsed() > idle_timeout {
                    return Err(anyhow!("chunk 读取错误且停滞: {}", e));
                }
                return Err(anyhow!("chunk 读取错误: {}", e));
            }
        }
    }

    if buffer.len() as u64 != range.size() {
        rollback(credited);
        return Err(anyhow!(
            "chunk 不完整 (bytes {}-{}): 期望 {}, 实际 {}",
            range.start,
            range.end,
            range.size(),
            buffer.len()
        ));
    }

    // 在阻塞线程写盘，避免长时间占用 async worker。
    let file = file.clone();
    let offset = range.start;
    match tokio::task::spawn_blocking(move || write_at_offset(&file, offset, &buffer))
        .await
        .map_err(|e| anyhow!("写盘任务失败: {}", e))
    {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => {
            rollback(credited);
            Err(e)
        }
        Err(e) => {
            rollback(credited);
            Err(e)
        }
    }
}

async fn single_threaded_download(
    client: &reqwest::Client,
    url: &str,
    temp_path: &Path,
    progress_tx: Option<mpsc::Sender<(u64, u64)>>,
    cancel: Arc<AtomicBool>,
) -> Result<()> {
    println!("[Download]   单线程下载: {}", url);
    let start = Instant::now();
    let idle_timeout = crate::http_client::DOWNLOAD_IDLE_TIMEOUT;
    
    let resp = client
        .get(url)
        .send()
        .await
        .with_context(|| format!("请求失败: {}", url))?;
    
    if !resp.status().is_success() {
        return Err(anyhow!("HTTP {}: {}", resp.status(), url));
    }
    
    let total_size = resp.content_length().unwrap_or(0);
    println!("[Download]   文件大小: {} bytes", total_size);
    
    // 立刻推送一次初始进度，让前端立刻显示进度条而不是等满 3 秒
    if let Some(ref tx) = progress_tx {
        let _ = tx.try_send((0, total_size));
    }
    
    let mut file = tokio::fs::File::create(temp_path)
        .await
        .with_context(|| format!("创建文件失败: {}", temp_path.display()))?;
    
    use futures::stream::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut received: u64 = 0;
    let mut reporter_tick = Instant::now();
    let mut last_bytes_tick = Instant::now();
    let mut last_received: u64 = 0;
    let mut chunk_error_count: u32 = 0;
    const MAX_CHUNK_ERRORS: u32 = 25;

    loop {
        let chunk_with_timeout = tokio::time::timeout(idle_timeout, stream.next()).await;

        match chunk_with_timeout {
            Err(_) => {
                return Err(anyhow!(
                    "读取超时 ({}s 内未收到数据)",
                    idle_timeout.as_secs()
                ));
            }
            Ok(None) => break,
            Ok(Some(chunk_result)) => {
                if cancel.load(Ordering::SeqCst) {
                    return Err(anyhow!("已取消"));
                }

                let data = match chunk_result {
                    Ok(d) => d,
                    Err(e) => {
                        chunk_error_count += 1;
                        if chunk_error_count > MAX_CHUNK_ERRORS {
                            return Err(anyhow!(
                                "读取字节流失败 (连续 {} 次错误): {}",
                                MAX_CHUNK_ERRORS,
                                e
                            ));
                        }
                        let sleep_ms = 300u64 + (chunk_error_count as u64) * 150;
                        println!(
                            "[Download]   ! chunk错误 ({}/{}): {}, 等待 {}ms 后继续...",
                            chunk_error_count, MAX_CHUNK_ERRORS, e, sleep_ms
                        );
                        tokio::time::sleep(Duration::from_millis(sleep_ms)).await;
                        continue;
                    }
                };
                
                chunk_error_count = 0;
                
                if data.is_empty() {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    continue;
                }
                
                file.write_all(&data).await.with_context(|| "写入失败")?;
                received += data.len() as u64;
                
                if reporter_tick.elapsed() > Duration::from_millis(500) {
                    if let Some(ref tx) = progress_tx {
                        let _ = tx.try_send((received, total_size));
                    }
                    
                    let pct = if total_size > 0 {
                        received as f64 / total_size as f64 * 100.0
                    } else {
                        0.0
                    };
                    let speed_kb =
                        received as f64 / 1024.0 / start.elapsed().as_secs_f64().max(0.1);
                    
                    println!(
                        "[Download]     ↓ 单线程进度: {:.1}% ({}/{} bytes) | 速度: {:.0} KB/s",
                        pct, received, total_size, speed_kb
                    );
                    
                    reporter_tick = Instant::now();
                }
                
                if received > last_received {
                    last_received = received;
                    last_bytes_tick = Instant::now();
                } else if last_bytes_tick.elapsed() > idle_timeout {
                    return Err(anyhow!(
                        "下载停滞超过 {}s",
                        idle_timeout.as_secs()
                    ));
                }
            }
        }
    }
    
    file.flush().await.ok();
    drop(file);

    if total_size > 0 && received != total_size {
        return Err(anyhow!(
            "大小不匹配: 期望 {}, 实际 {}",
            total_size,
            received
        ));
    }
    
    println!("[Download]   ✓ 单线程下载完成: {} bytes", received);
    Ok(())
}

async fn browser_style_download(
    url: &str,
    temp_path: &Path,
    sha1: &Option<String>,
    progress_tx: Option<mpsc::Sender<(u64, u64)>>,
    cancel: Arc<AtomicBool>,
    site_type: &str,
) -> Result<()> {
    println!("[Download]   浏览器风格下载: {} | 类型: {}", url, site_type);
    let start = Instant::now();
    let idle_timeout = crate::http_client::DOWNLOAD_IDLE_TIMEOUT;
    
    let client = crate::http_client::base_client_builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .connect_timeout(Duration::from_secs(30))
        .build()
        .with_context(|| "创建浏览器风格客户端失败")?;
    
    let mut request = client
        .get(url)
        .header("Accept", "*/*")
        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .header("Accept-Encoding", "identity")
        .header("Connection", "keep-alive");
    
    request = match site_type {
        "curseforge" => request
            .header("Referer", "https://www.curseforge.com/")
            .header("Origin", "https://www.curseforge.com"),
        "modrinth" => request
            .header("Referer", "https://modrinth.com/")
            .header("Origin", "https://modrinth.com"),
        _ => request.header("Referer", "https://www.google.com/"),
    };
    
    let resp = request
        .send()
        .await
        .with_context(|| format!("请求失败: {}", url))?;
    
    if !resp.status().is_success() {
        return Err(anyhow!("HTTP {}: {}", resp.status(), url));
    }
    
    let total_size = resp.content_length().unwrap_or(0);
    println!("[Download]   文件大小: {} bytes", total_size);
    
    // 立刻推送一次初始进度
    if let Some(ref tx) = progress_tx {
        let _ = tx.try_send((0, total_size));
    }
    
    let mut file = tokio::fs::File::create(temp_path)
        .await
        .with_context(|| format!("创建文件失败: {}", temp_path.display()))?;
    
    use futures::stream::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut received: u64 = 0;
    let mut reporter_tick = Instant::now();
    let mut last_bytes_tick = Instant::now();
    let mut last_received: u64 = 0;
    let mut chunk_error_count: u32 = 0;
    const MAX_CHUNK_ERRORS: u32 = 30;

    loop {
        let chunk_with_timeout = tokio::time::timeout(idle_timeout, stream.next()).await;

        match chunk_with_timeout {
            Err(_) => {
                return Err(anyhow!(
                    "读取超时 ({}s 内未收到数据)",
                    idle_timeout.as_secs()
                ));
            }
            Ok(None) => {
                // 流结束
                break;
            }
            Ok(Some(chunk_result)) => {
                if cancel.load(Ordering::SeqCst) {
                    return Err(anyhow!("已取消"));
                }

                let data = match chunk_result {
                    Ok(d) => d,
                    Err(e) => {
                        chunk_error_count += 1;
                        if chunk_error_count > MAX_CHUNK_ERRORS {
                            return Err(anyhow!(
                                "读取字节流失败 (连续 {} 次错误): {}",
                                MAX_CHUNK_ERRORS,
                                e
                            ));
                        }
                        let sleep_ms = 300u64 + (chunk_error_count as u64) * 150;
                        println!(
                            "[Download]   ! chunk错误 ({}/{}): {}, 等待 {}ms 后继续...",
                            chunk_error_count, MAX_CHUNK_ERRORS, e, sleep_ms
                        );
                        tokio::time::sleep(Duration::from_millis(sleep_ms)).await;
                        continue;
                    }
                };
                
                chunk_error_count = 0;
                
                if data.is_empty() {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    continue;
                }
                
                file.write_all(&data).await.with_context(|| "写入失败")?;
                received += data.len() as u64;
                
                if reporter_tick.elapsed() > Duration::from_millis(500) {
                    if let Some(ref tx) = progress_tx {
                        let _ = tx.try_send((received, total_size));
                    }
                    
                    let pct = if total_size > 0 {
                        received as f64 / total_size as f64 * 100.0
                    } else {
                        0.0
                    };
                    let speed_kb =
                        received as f64 / 1024.0 / start.elapsed().as_secs_f64().max(0.1);
                    
                    println!(
                        "[Download]     ↓ 浏览器风格进度: {:.1}% ({}/{} bytes) | 速度: {:.0} KB/s",
                        pct, received, total_size, speed_kb
                    );
                    
                    reporter_tick = Instant::now();
                }
                
                if received > last_received {
                    last_received = received;
                    last_bytes_tick = Instant::now();
                } else if last_bytes_tick.elapsed() > idle_timeout {
                    return Err(anyhow!(
                        "下载停滞超过 {}s",
                        idle_timeout.as_secs()
                    ));
                }
            }
        }
    }
    
    file.flush().await.ok();
    drop(file);

    if total_size > 0 && received != total_size {
        return Err(anyhow!(
            "大小不匹配: 期望 {}, 实际 {}",
            total_size,
            received
        ));
    }
    
    if let Some(sha) = sha1 {
        println!("[Download]   校验SHA1: {}", sha);
        if !verify_sha1(temp_path, sha) {
            return Err(anyhow!("SHA1 不匹配"));
        }
        println!("[Download]   ✓ SHA1匹配");
    }
    
    println!("[Download]   ✓ 浏览器风格下载完成: {} bytes", received);
    Ok(())
}

fn preallocate_file(path: &Path, size: u64) -> Result<()> {
    use std::fs::OpenOptions;
    let f = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
        .with_context(|| format!("创建文件失败: {}", path.display()))?;
    
    f.set_len(size)
        .with_context(|| format!("设置文件大小失败: {}", path.display()))?;
    
    f.sync_all().ok();
    drop(f);
    Ok(())
}

fn rename_error_transient(err: &std::io::Error) -> bool {
    matches!(
        err.raw_os_error(),
        Some(5) | Some(32) | Some(33) // Windows: access denied / sharing violation
    )
}

/// 删除可能残留的 `.downloading_<目标文件名>`（重命名失败或杀软扫描延迟时）。
fn remove_stale_downloading_temp(target: &Path) {
    let Some(parent) = target.parent() else {
        return;
    };
    let Some(name) = target.file_name() else {
        return;
    };
    let stale = parent.join(format!(".downloading_{}", name.to_string_lossy()));
    if stale.is_file() {
        let _ = fs::remove_file(stale);
    }
}

fn finalize_download(temp_path: &Path, target: &Path) -> Result<()> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).context("创建目标目录失败")?;
    }

    let temp_len = fs::metadata(temp_path).map(|m| m.len()).unwrap_or(0);
    if !temp_path.is_file() || temp_len == 0 {
        // 不把“目标已存在”当作成功：可能是旧残缺文件。
        return Err(anyhow!(
            "临时下载文件无效: {} (exists={}, size={})",
            temp_path.display(),
            temp_path.exists(),
            temp_len
        ));
    }

    if target.is_file() {
        fs::remove_file(target).context("删除已存在的目标文件失败")?;
    }

    const MAX_ATTEMPTS: u32 = 10;
    for attempt in 0..MAX_ATTEMPTS {
        match fs::rename(temp_path, target) {
            Ok(()) => {
                if !target.is_file() {
                    return Err(anyhow!(
                        "重命名后目标文件不存在: {}",
                        target.display()
                    ));
                }
                let final_len = fs::metadata(target).map(|m| m.len()).unwrap_or(0);
                if final_len != temp_len {
                    return Err(anyhow!(
                        "重命名后文件大小异常: {} → {} bytes",
                        temp_len,
                        final_len
                    ));
                }
                remove_stale_downloading_temp(target);
                return Ok(());
            }
            Err(err) if attempt + 1 < MAX_ATTEMPTS && rename_error_transient(&err) => {
                std::thread::sleep(Duration::from_millis(40 * (attempt as u64 + 1)));
            }
            Err(err) => {
                // rename 跨卷失败时回退为 copy + 删除临时文件。
                println!(
                    "[Download]   rename 失败 ({})，尝试 copy: {} → {}",
                    err,
                    temp_path.display(),
                    target.display()
                );
                fs::copy(temp_path, target).with_context(|| {
                    format!(
                        "复制下载文件失败: {} → {}",
                        temp_path.display(),
                        target.display()
                    )
                })?;
                let final_len = fs::metadata(target).map(|m| m.len()).unwrap_or(0);
                if final_len != temp_len {
                    let _ = fs::remove_file(target);
                    return Err(anyhow!(
                        "复制后文件大小异常: {} → {} bytes",
                        temp_len,
                        final_len
                    ));
                }
                let _ = fs::remove_file(temp_path);
                remove_stale_downloading_temp(target);
                return Ok(());
            }
        }
    }

    Err(anyhow!(
        "重命名下载文件失败: {} → {}",
        temp_path.display(),
        target.display()
    ))
}

fn rand_id() -> usize {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as usize)
        .unwrap_or(0)
}

fn is_cf_api_url(url: &str) -> bool {
    url.contains("api.curseforge.com")
        || url.contains("www.curseforge.com")
        || url.contains("files.curseforge.com")
        || url.contains("files-cf.curseforge.com")
        || url.contains("edge.forgecdn.net")
}

fn extract_cf_ids(url: &str) -> Option<(u64, u64)> {
    // 匹配 api.curseforge.com/v1/mods/{pid}/files/{fid} 和
    // www.curseforge.com/minecraft/mc-mods/{pid}/.../files/{fid}/... 等
    let re1 = regex::Regex::new(r"/mods/(\d+)/files/(\d+)").ok()?;
    if let Some(caps) = re1.captures(url) {
        let pid = caps.get(1)?.as_str().parse().ok()?;
        let fid = caps.get(2)?.as_str().parse().ok()?;
        return Some((pid, fid));
    }

    // 匹配 www.curseforge.com/minecraft/mc-mods/{pid}/download/{fid}/file
    // （CurseForge 整合包生成的 URL 就是这种格式）
    let re2 = regex::Regex::new(r"/mc-mods/(\d+)/download/(\d+)").ok()?;
    if let Some(caps) = re2.captures(url) {
        let pid = caps.get(1)?.as_str().parse().ok()?;
        let fid = caps.get(2)?.as_str().parse().ok()?;
        return Some((pid, fid));
    }

    None
}

pub async fn resolve_cf_download_info(
    pid: u64,
    fid: u64,
) -> Option<(String, Option<String>, String)> {
    use serde_json::Value;
    let first4 = fid / 1000;
    let last3 = fid % 1000;

    let client = crate::http_client::client_builder_with_timeout(Duration::from_secs(10))
        .connect_timeout(Duration::from_secs(5))
        .build()
        .ok()?;

    let api_url = format!("https://api.curseforge.com/v1/mods/{}/files/{}", pid, fid);
    let resp = match client
        .get(&api_url)
        .header(
            "x-api-key",
            "$2a$10$VTAFCxje5a1Jkqv0aGWjQ.fULedAEPctDqppOkNMRvV.edVnG7KQ6",
        )
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            println!(
                "[Download] CF-API 请求失败: pid={}, fid={}, error={}",
                pid, fid, e
            );
            return None;
        }
    };

    if !resp.status().is_success() {
        println!(
            "[Download] CF-API 返回状态 {}: pid={}, fid={}",
            resp.status(),
            pid,
            fid
        );
        return None;
    }

    let text = match resp.text().await {
        Ok(t) => t,
        Err(_) => return None,
    };

    let json = match serde_json::from_str::<Value>(&text) {
        Ok(j) => j,
        Err(_) => return None,
    };

    let is_valid = |name: &str| -> bool {
        !name.is_empty()
            && name != "file"
            && name != "download"
            && !name.starts_with("file.")
            && name.contains('.')
    };

    let file_name = json
        .get("data")
        .and_then(|d| d.get("fileName"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| is_valid(s));

    let download_url = json
        .get("data")
        .and_then(|d| d.get("downloadUrl"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());

    match file_name {
        Some(name) => {
            let cdn = download_url.unwrap_or_else(|| {
                format!(
                    "https://edge.forgecdn.net/files/{}/{:03}/{}",
                    first4, last3, name
                )
            });
            println!("[Download] CF-API: pid={}, fid={}, name={}", pid, fid, name);
            Some((name, None, cdn))
        }
        None => None,
    }
}

pub async fn download_all_with_file_info(
    tasks: Vec<DownloadTask>,
    on_file_done: Option<mpsc::Sender<(usize, usize, String)>>,
) -> DownloadResult {
    download_all_with_file_info_and_bytes(tasks, on_file_done, None, None).await
}

pub async fn download_all_with_file_info_and_bytes(
    tasks: Vec<DownloadTask>,
    on_file_done: Option<mpsc::Sender<(usize, usize, String)>>,
    byte_tracker: Option<crate::downloader::install_progress::ByteBatchTracker>,
    cancel: Option<Arc<AtomicBool>>,
) -> DownloadResult {
    let total = tasks.len();
    if total == 0 {
        return DownloadResult {
            success_count: 0,
            failures: Vec::new(),
        };
    }

    let done_counter = Arc::new(AtomicU64::new(0));

    let (success_count, failures) = smart_batch_download(
        tasks,
        total,
        done_counter.clone(),
        move |done, total_file_count, fname| {
            if let Some(ref tx) = on_file_done {
                let _ = tx.try_send((done, total_file_count, fname));
            }
        },
        Option::<fn(f64) -> ()>::None,
        byte_tracker,
        cancel,
    )
    .await;

    DownloadResult {
        success_count,
        failures,
    }
}

pub async fn download_all(
    tasks: Vec<DownloadTask>,
    progress_tx: Option<mpsc::Sender<f64>>,
    cancel: Option<Arc<AtomicBool>>,
) -> DownloadResult {
    download_all_with_bytes(tasks, progress_tx, None, cancel).await
}

/// Like `download_all`, but also forwards per-file byte progress `(downloaded, total)` when known.
pub async fn download_all_with_bytes(
    tasks: Vec<DownloadTask>,
    progress_tx: Option<mpsc::Sender<f64>>,
    byte_tracker: Option<crate::downloader::install_progress::ByteBatchTracker>,
    cancel: Option<Arc<AtomicBool>>,
) -> DownloadResult {
    let total = tasks.len();
    if total == 0 {
        return DownloadResult {
            success_count: 0,
            failures: Vec::new(),
        };
    }

    let done_counter = Arc::new(AtomicU64::new(0));

    let (success_count, failures) = smart_batch_download(
        tasks,
        total,
        done_counter.clone(),
        |_done, _total, _fname| {},
        Some(move |percent| {
            if let Some(ref tx) = progress_tx {
                let _ = tx.try_send(percent);
            }
        }),
        byte_tracker,
        cancel,
    )
    .await;

    DownloadResult {
        success_count,
        failures,
    }
}

pub async fn download_one(task: DownloadTask) -> Result<PathBuf> {
    match download_file(&task, None, None).await {
        SingleDownloadResult::Success { path, .. } => Ok(path),
        SingleDownloadResult::Failed { error, .. } => Err(anyhow!(error)),
    }
}

#[derive(Clone)]
struct AdaptiveSemaphore {
    sem: Arc<Semaphore>,
    completed: Arc<AtomicU64>,
    target_permits: Arc<AtomicU64>,
}

impl AdaptiveSemaphore {
    fn new(initial: usize) -> Self {
        Self {
            sem: Arc::new(Semaphore::new(initial.min(MAX_CONCURRENT_FILES))),
            completed: Arc::new(AtomicU64::new(0)),
            target_permits: Arc::new(AtomicU64::new(initial as u64)),
        }
    }
}

async fn spawn_adaptive_tuner(sem: AdaptiveSemaphore) {
    tokio::spawn(async move {
        let mut last_throughput: VecDeque<u64> = VecDeque::new();
        let mut last_time = Instant::now();
        let mut last_done: u64 = 0;
        let mut stable_high_count = 0usize;
        let mut low_count = 0usize;
        
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            
            let completed = sem.completed.load(Ordering::SeqCst);
            let target = sem.target_permits.load(Ordering::SeqCst) as usize;
            
            let now = Instant::now();
            let dt = now.duration_since(last_time).as_secs_f64().max(0.1);
            let dd = completed.saturating_sub(last_done);
            let current_bps = (dd as f64 / dt) as u64;
            
            last_throughput.push_back(current_bps);
            if last_throughput.len() > 5 {
                last_throughput.pop_front();
            }
            
            let avg_bps = if !last_throughput.is_empty() {
                last_throughput.iter().sum::<u64>() / last_throughput.len() as u64
            } else {
                0
            };
            
            last_done = completed;
            last_time = now;
            
            let current_permits = sem.sem.available_permits();
            let total_in_flight = target.saturating_sub(current_permits);
            
            // 吞吐量低时小幅降低并发（更温和）
            if avg_bps < STALL_BYTES_PER_SEC && total_in_flight > 0 {
                low_count += 1;
                if low_count >= 3 {
                    let new_target = (target as f64 * 0.85).max(4.0) as usize;
                    sem.target_permits
                        .store(new_target as u64, Ordering::SeqCst);
                    low_count = 0;
                }
            } else if avg_bps > STALL_BYTES_PER_SEC * 5 && current_permits == 0 {
                // 高吞吐量且满负载时，更激进地增加并发
                stable_high_count += 1;
                if stable_high_count >= 1 {
                    let multiplier = if avg_bps > STALL_BYTES_PER_SEC * 20 {
                        1.5
                    } else if avg_bps > STALL_BYTES_PER_SEC * 10 {
                        1.4
                    } else {
                        1.25
                    };
                    let new_target =
                        (target as f64 * multiplier).min(MAX_CONCURRENT_FILES as f64) as usize;
                    if new_target > target {
                        sem.target_permits
                            .store(new_target as u64, Ordering::SeqCst);
                    }
                    stable_high_count = 0;
                }
            } else {
                stable_high_count = 0;
                low_count = 0;
            }
        }
    });
}

fn global_connection_semaphore() -> Arc<Semaphore> {
    download_runtime_config::file_connection_semaphore()
}

fn is_server_overload_error(err: &str) -> bool {
    let lower = err.to_lowercase();
    lower.contains("429")
        || lower.contains("too many request")
        || lower.contains("rate limit")
        || lower.contains("503")
        || lower.contains("service unavailable")
        || lower.contains("connection refused")
        || lower.contains("connection reset")
        || lower.contains("connection closed")
        || lower.contains("timeout")
        || lower.contains("timed out")
}

async fn smart_batch_download(
    tasks: Vec<DownloadTask>,
    total: usize,
    done_counter: Arc<AtomicU64>,
    on_any_done: impl Fn(usize, usize, String) + Clone + Send + Sync + 'static,
    on_percent: Option<impl Fn(f64) + Clone + Send + Sync + 'static>,
    byte_tracker: Option<crate::downloader::install_progress::ByteBatchTracker>,
    cancel: Option<Arc<AtomicBool>>,
) -> (usize, Vec<DownloadFailure>) {
    if tasks.is_empty() {
        return (0, Vec::new());
    }

    let concurrency = Arc::new(AtomicU64::new(SMART_INITIAL_CONCURRENCY as u64));
    let conn_sem = global_connection_semaphore();

    let tasks_wrapped: Vec<DownloadTask> = tasks.into_iter().collect();
    let total_tasks = tasks_wrapped.len();
    let pending = Arc::new(StdMutex::new(VecDeque::from(tasks_wrapped)));
    let in_flight = Arc::new(AtomicU64::new(0));
    let successes_arc = Arc::new(AtomicU64::new(0));
    let recent_results: Arc<StdMutex<VecDeque<bool>>> = Arc::new(StdMutex::new(VecDeque::new()));
    let failures: Arc<StdMutex<Vec<DownloadFailure>>> = Arc::new(StdMutex::new(Vec::new()));
    let overload_detected = Arc::new(AtomicBool::new(false));

    let (done_tx, mut done_rx) = mpsc::unbounded_channel::<(bool, String, String, Vec<String>)>();

    let on_any_done_clone = on_any_done.clone();
    let percent_tx = on_percent.clone();
    let done_counter_clone = done_counter.clone();
    let successes_clone = successes_arc.clone();
    let recent_clone = recent_results.clone();
    let failures_clone = failures.clone();
    let overload_detected_clone = overload_detected.clone();

    tokio::spawn(async move {
        while let Some((success, fname, err, urls_tried)) = done_rx.recv().await {
            let done = done_counter_clone.fetch_add(1, Ordering::SeqCst) + 1;
            on_any_done_clone(done as usize, total, fname.clone());
            if let Some(ref pt) = percent_tx {
                pt(if total > 0 {
                    (done as f64 / total as f64) * 100.0
                } else {
                    100.0
                });
            }
            if success {
                successes_clone.fetch_add(1, Ordering::SeqCst);
                if let Ok(mut rr) = recent_clone.lock() {
                    rr.push_back(true);
                    if rr.len() > SMART_ADJUST_BATCH * 2 {
                        rr.pop_front();
                    }
                }
            } else {
                if is_server_overload_error(&err) {
                    overload_detected_clone.store(true, Ordering::SeqCst);
                }
                if let Ok(mut rr) = recent_clone.lock() {
                    rr.push_back(false);
                    if rr.len() > SMART_ADJUST_BATCH * 2 {
                        rr.pop_front();
                    }
                }
                if let Ok(mut fails) = failures_clone.lock() {
                    fails.push(DownloadFailure {
                        file_name: fname,
                        error: err,
                        urls_tried,
                    });
                }
            }
        }
    });

    let last_adjust_done = Arc::new(AtomicU64::new(0));

    println!(
        "[SmartDownload] 初始化: 并发={}, 总文件={}, 每{}个调整一次",
        SMART_INITIAL_CONCURRENCY, total_tasks, SMART_ADJUST_BATCH
    );

    let mut spawn_count: u64 = 0;
    loop {
        if is_download_cancelled(&cancel) {
            println!("[SmartDownload] 已取消，停止调度新下载");
            break;
        }

        let current_concurrency = concurrency.load(Ordering::SeqCst) as usize;
        let current_in_flight = in_flight.load(Ordering::SeqCst) as usize;
        let done_count = done_counter.load(Ordering::SeqCst) as usize;

        let pending_empty = pending.lock().ok().map(|q| q.is_empty()).unwrap_or(true);
        let nothing_left = pending_empty && current_in_flight == 0;
        if nothing_left {
            break;
        }

        if done_count >= total_tasks {
            break;
        }

        let adjust_delta = done_count as u64 - last_adjust_done.load(Ordering::SeqCst);
        if adjust_delta >= SMART_ADJUST_BATCH as u64
            || (adjust_delta > 0 && overload_detected.swap(false, Ordering::SeqCst))
        {
            last_adjust_done.store(done_count as u64, Ordering::SeqCst);
            let recent = recent_results
                .lock()
                .ok()
                .map(|q| q.iter().cloned().collect::<Vec<bool>>())
                .unwrap_or_default();
            let recent_count = recent.len().max(1);
            let recent_successes = recent.iter().filter(|&&x| x).count();
            let success_rate = recent_successes as f64 / recent_count as f64;

            let new_conc = if success_rate >= 0.9
                && current_in_flight >= current_concurrency.saturating_sub(1)
            {
                (((current_concurrency as f64) * 1.25).round() as usize)
                    .max(current_concurrency + 1)
                    .min(SMART_MAX_CONCURRENCY)
            } else if success_rate >= 0.5 {
                (((current_concurrency as f64) * 0.75).round() as usize)
                    .max(SMART_MIN_CONCURRENCY)
            } else {
                (((current_concurrency as f64) * 0.55).round() as usize)
                    .max(SMART_MIN_CONCURRENCY)
            };
            if new_conc != current_concurrency {
                concurrency.store(new_conc as u64, Ordering::SeqCst);
                println!(
                    "[SmartDownload] 调整并发: {} → {} | 最近{}个成功率={:.0}% | 已完成{}/{}",
                    current_concurrency,
                    new_conc,
                    recent_count,
                    success_rate * 100.0,
                    done_count,
                    total_tasks
                );
            }
        }

        let can_spawn_more = {
            let queue_empty = pending.lock().ok().map(|q| q.is_empty()).unwrap_or(true);
            !queue_empty && current_in_flight < concurrency.load(Ordering::SeqCst) as usize
        };

        if can_spawn_more {
            let next_task = pending.lock().ok().and_then(|mut q| q.pop_front());
            if let Some(task) = next_task {
                in_flight.fetch_add(1, Ordering::SeqCst);
                let fname = task.file_name.clone();
                let done_tx_clone = done_tx.clone();
                let in_flight_clone = in_flight.clone();
                let conn_sem_clone = conn_sem.clone();
                spawn_count += 1;

                let file_prog = byte_tracker
                    .clone()
                    .map(|t| t.file_progress_sender(fname.clone()));
                let cancel_spawn = cancel.clone();
                tokio::spawn(async move {
                    let _conn_permit = conn_sem_clone.acquire_owned().await;
                    if is_download_cancelled(&cancel_spawn) {
                        in_flight_clone.fetch_sub(1, Ordering::SeqCst);
                        let _ = done_tx_clone.send((
                            false,
                            fname.clone(),
                            "已取消".to_string(),
                            Vec::new(),
                        ));
                        return;
                    }
                    let result = download_file(&task, file_prog, cancel_spawn).await;
                    in_flight_clone.fetch_sub(1, Ordering::SeqCst);

                    match result {
                        SingleDownloadResult::Success { .. } => {
                            let _ = done_tx_clone.send((
                                true,
                                fname.clone(),
                                String::new(),
                                Vec::new(),
                            ));
                        }
                        SingleDownloadResult::Failed {
                            error, urls_tried, ..
                        } => {
                            let _ = done_tx_clone.send((false, fname.clone(), error, urls_tried));
                        }
                    }
                });
                if spawn_count % 10 == 1 {
                    tokio::time::sleep(Duration::from_millis(80)).await;
                }
                continue;
            }
        }

        tokio::time::sleep(Duration::from_millis(150)).await;
    }

    let success_count = successes_arc.load(Ordering::SeqCst) as usize;
    let fail_list = failures.lock().ok().map(|m| m.clone()).unwrap_or_default();
    (success_count, fail_list)
}

#[cfg(test)]
mod tests {
    use super::parse_content_range_total;

    #[test]
    fn content_range_total_requires_definite_size() {
        assert_eq!(
            parse_content_range_total("bytes 0-1048575/5242880"),
            Some(5_242_880)
        );
        assert_eq!(parse_content_range_total("bytes 0-1048575/*"), None);
        assert_eq!(parse_content_range_total("bytes 0-100/0"), None);
        assert_eq!(parse_content_range_total("bytes 0-100"), None);
    }
}