use super::decompression::extract_library_paths;
use crate::http_client::shared_client;
use futures::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::env;
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Semaphore};
const MOJANG_MANIFEST: &str = "https://launchermeta.mojang.com/mc/game/version_manifest.json";
const MIRROR_URL: &str = "https://bmclapi2.bangbang93.com";

// 过高的文件级并发会争用 Tokio 线程、文件描述符和磁盘，拖慢整个启动器。
const MAX_CONCURRENT_DOWNLOADS: usize = 16;

/// 安装/下载进度更新（percent 必填；stage/message 用于 UI 详情）。
#[derive(Debug, Clone, Default)]
pub struct ProgressUpdate {
    pub percent: f64,
    pub stage: Option<String>,
    pub message: Option<String>,
    /// Cumulative downloaded bytes when known (for UI speed).
    pub downloaded: Option<u64>,
    /// Instantaneous bytes/sec when known.
    pub speed: Option<f64>,
}

impl ProgressUpdate {
    pub fn percent(percent: f64) -> Self {
        Self {
            percent,
            ..Default::default()
        }
    }

    pub fn with_stage(percent: f64, stage: impl Into<String>) -> Self {
        Self {
            percent,
            stage: Some(stage.into()),
            ..Default::default()
        }
    }

    pub fn with_detail(
        percent: f64,
        stage: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            percent,
            stage: Some(stage.into()),
            message: Some(message.into()),
            ..Default::default()
        }
    }

    pub fn remap(&self, base: f64, scale: f64) -> Self {
        Self {
            percent: base + self.percent * scale,
            stage: self.stage.clone(),
            message: self.message.clone(),
            // Absolute transfer metrics — do not scale with percent remap.
            downloaded: self.downloaded,
            speed: self.speed,
        }
    }
}

#[derive(Debug)]
struct DownloadTask {
    urls: Vec<String>,
    target_path: PathBuf,
    sha1: String,
    size: u64,
}
struct DownloadProgress {
    done: Arc<AtomicUsize>,
    /// Bytes actually transferred over the network (drives speed).
    bytes_network: Arc<AtomicU64>,
    /// Bytes credited from local cache / reuse (drives percent, NOT speed).
    bytes_local: Arc<AtomicU64>,
}
impl DownloadProgress {
    fn new() -> Self {
        Self {
            done: Arc::new(AtomicUsize::new(0)),
            bytes_network: Arc::new(AtomicU64::new(0)),
            bytes_local: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Count network bytes as they arrive (for live speed). Callers that use this
    /// during transfer should pass `transferred: 0` to `mark_file_done` on completion
    /// to avoid double-counting.
    fn add_transferred(&self, n: u64) {
        if n > 0 {
            self.bytes_network.fetch_add(n, Ordering::SeqCst);
        }
    }

    /// Count a finished file toward progress.
    /// - Network completion: `transferred` already counted via `add_transferred` → pass 0.
    /// - Legacy paths that only count at end: pass network byte count as `transferred`.
    /// Prefer `mark_local_done` for cache hits.
    fn mark_file_done(&self, transferred: u64) {
        self.done.fetch_add(1, Ordering::SeqCst);
        if transferred > 0 {
            self.bytes_network.fetch_add(transferred, Ordering::SeqCst);
        }
    }

    /// Cache hit / local reuse: advance percent without inflating speed.
    fn mark_local_done(&self, credited: u64) {
        self.done.fetch_add(1, Ordering::SeqCst);
        if credited > 0 {
            self.bytes_local.fetch_add(credited, Ordering::SeqCst);
        }
    }

    fn total_credited(&self) -> u64 {
        self.bytes_network
            .load(Ordering::SeqCst)
            .saturating_add(self.bytes_local.load(Ordering::SeqCst))
    }
}
#[derive(Debug, Deserialize, Serialize)]
struct VersionManifest {
    versions: Vec<VersionEntry>,
}
#[derive(Debug, Deserialize, Serialize)]
struct VersionEntry {
    id: String,
    url: String,
}
#[derive(Debug, Deserialize, Serialize)]
struct VersionJson {
    downloads: Downloads,
    #[serde(default)]
    logging: Option<Logging>,
    #[serde(rename = "assetIndex")]
    asset_index: AssetIndex,
    libraries: Vec<Library>,
    #[serde(flatten)]
    other: serde_json::Value,
}
#[derive(Debug, Deserialize, Serialize)]
struct AssetIndex {
    url: String,
    id: String,
}
#[derive(Debug, Deserialize, Serialize)]
struct AssetsJson {
    objects: HashMap<String, AssetObject>,
}
#[derive(Debug, Deserialize, Serialize)]
struct AssetObject {
    hash: String,
    #[serde(default)]
    size: u64,
}
#[derive(Debug, Deserialize, Serialize)]
struct Downloads {
    client: ClientDownload,
}
#[derive(Debug, Deserialize, Serialize)]
struct ClientDownload {
    url: String,
    sha1: String,
    size: u64,
}
#[derive(Debug, Deserialize, Serialize)]
struct Logging {
    client: LoggingClient,
}
#[derive(Debug, Deserialize, Serialize)]
struct LoggingClient {
    file: LogFile,
}
#[derive(Debug, Deserialize, Serialize)]
struct LogFile {
    url: String,
    sha1: String,
}
#[derive(Debug, Deserialize, Serialize)]
struct Library {
    name: String,
    downloads: LibraryDownloads,
    #[serde(default)]
    rules: Vec<Rule>,
}
#[derive(Debug, Deserialize, Serialize)]
struct LibraryDownloads {
    artifact: Option<Artifact>,
    #[serde(default)]
    classifiers: HashMap<String, Artifact>,
}
#[derive(Debug, Deserialize, Serialize)]
struct Artifact {
    path: String,
    sha1: String,
    size: u64,
}
#[derive(Debug, Deserialize, Serialize)]
struct Rule {
    action: String,
    #[serde(default)]
    os: Option<OsRule>,
}
#[derive(Debug, Deserialize, Serialize)]
struct OsRule {
    name: Option<String>,
}
async fn download_task(
    task: DownloadTask,
    client: Arc<reqwest::Client>,
    semaphore: Arc<Semaphore>,
    progress: Option<Arc<DownloadProgress>>,
    cancel: Arc<AtomicBool>,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let _permit = semaphore.acquire().await?;
    if cancel.load(Ordering::SeqCst) {
        if let Some(p) = &progress {
            p.mark_file_done(0);
        }
        return Err("已取消".into());
    }
    const MAX_RETRIES: u8 = 5;
    let mut retry_count = 0;
    let mut used_urls: Vec<String> = Vec::new();
    if let Ok(mut file) = File::open(&task.target_path).await {
        match check_sha1(&mut file, &task.sha1).await {
            Ok(true) => {
                // Cache hit — credit local bytes for percent; do NOT count as network speed.
                if let Some(p) = &progress {
                    let credited = if task.size > 0 { task.size } else { 64 * 1024 };
                    p.mark_local_done(credited);
                }
                return Ok(());
            }
            _ => {
                let _ = fs::remove_file(&task.target_path);
            }
        }
    }
    if let Some(parent) = task.target_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    for url in &task.urls {
        if cancel.load(Ordering::SeqCst) {
            if let Some(p) = &progress {
                p.mark_file_done(0);
            }
            return Err("已取消".into());
        }
        if used_urls.contains(url) {
            continue;
        }
        let result = download_with_url(url, &task, &client, &cancel, progress.as_ref()).await;
        used_urls.push(url.clone());
        match result {
            Ok(true) => {
                // Bytes already counted mid-transfer via add_transferred.
                if let Some(p) = &progress {
                    p.mark_file_done(0);
                }
                return Ok(());
            }
            Ok(false) => {
                let _ = fs::remove_file(&task.target_path);
            }
            Err(e) => {
                if e.to_string().contains("已取消") || cancel.load(Ordering::SeqCst) {
                    if let Some(p) = &progress {
                        p.mark_file_done(0);
                    }
                    return Err("已取消".into());
                }
                eprintln!("下载失败 [{}]: {}", url, e);
            }
        }
        retry_count += 1;
        if retry_count >= MAX_RETRIES {
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    if cancel.load(Ordering::SeqCst) {
        if let Some(p) = &progress {
            p.mark_file_done(0);
        }
        return Err("已取消".into());
    }
    if let Some(p) = &progress {
        p.mark_file_done(0);
    }
    Err(format!("文件 {} 下载失败，已尝试所有源", task.target_path.display()).into())
}
async fn download_with_url(
    url: &str,
    task: &DownloadTask,
    client: &reqwest::Client,
    cancel: &Arc<AtomicBool>,
    progress: Option<&Arc<DownloadProgress>>,
) -> Result<bool, Box<dyn Error + Send + Sync>> {
    let response = client.get(url).send().await?.error_for_status()?;
    let content_length = response.content_length().unwrap_or(0);
    if task.size > 0 && content_length != task.size {
        return Err(format!("文件大小不匹配: 预期{} 实际{}", task.size, content_length).into());
    }
    let mut file = tokio::fs::File::create(&task.target_path).await?;
    let mut stream = response.bytes_stream();
    let mut hasher = Sha1::new();
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            let _ = fs::remove_file(&task.target_path);
            return Err("已取消".into());
        }
        let chunk = chunk?;
        let n = chunk.len() as u64;
        hasher.update(&chunk);
        file.write_all(&chunk).await?;
        if let Some(p) = progress {
            p.add_transferred(n);
        }
    }
    file.sync_all().await?;
    let computed = format!("{:x}", hasher.finalize());
    Ok(computed == task.sha1)
}
async fn check_sha1(file: &mut File, expected: &str) -> Result<bool, Box<dyn Error + Send + Sync>> {
    let mut hasher = Sha1::new();
    let mut buf = vec![0u8; 8192];
    let mut reader = tokio::io::BufReader::new(file);
    loop {
        let n = reader.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()) == expected)
}
pub async fn process_version(
    version: &str,
    minecraft_path: &Path,
    progress_tx: mpsc::Sender<ProgressUpdate>,
    cancel: Arc<AtomicBool>,
) -> Result<Vec<String>, Box<dyn Error + Send + Sync>> {
    if cancel.load(Ordering::SeqCst) {
        return Err("已取消".into());
    }
    let version_dir = minecraft_path.join("versions").join(version);
    fs::create_dir_all(&version_dir)?;
    let natives_dir = &version_dir.join(format!("{}-natives", version));
    fs::create_dir_all(&natives_dir)?;
    let _ = progress_tx
        .send(ProgressUpdate::with_detail(
            0.0,
            "获取版本清单",
            format!("正在获取 {} 的版本信息", version),
        ))
        .await;
    let json_url = fetch_version_url(version).await?;
    if cancel.load(Ordering::SeqCst) {
        return Err("已取消".into());
    }
    let json_content = reqwest::get(&json_url).await?.text().await?;
    fs::write(version_dir.join(format!("{}.json", version)), &json_content)?;
    let version_data: VersionJson = serde_json::from_str(&json_content)?;
    let _ = progress_tx
        .send(ProgressUpdate::with_stage(1.0, "下载原版文件"))
        .await;
    if cancel.load(Ordering::SeqCst) {
        return Err("已取消".into());
    }
    let assets_content = reqwest::get(&version_data.asset_index.url)
        .await?
        .text()
        .await?;
    let indexes_dir = minecraft_path.join("assets").join("indexes");
    fs::create_dir_all(&indexes_dir)?;
    let index_path = indexes_dir.join(format!("{}.json", version_data.asset_index.id));
    fs::write(index_path, &assets_content)?;
    let assets_data: AssetsJson = serde_json::from_str(&assets_content)?;
    let mut tasks: Vec<DownloadTask> = Vec::new();
    let client_download = &version_data.downloads.client;
    tasks.push(DownloadTask {
        urls: vec![
            client_download.url.clone(),
            format!("{}/version/{}/client", MIRROR_URL, version),
        ],
        target_path: version_dir.join(format!("{}.jar", version)),
        sha1: client_download.sha1.clone(),
        size: client_download.size,
    });
    if let Some(logging) = &version_data.logging {
        tasks.push(DownloadTask {
            urls: vec![logging.client.file.url.clone()],
            target_path: version_dir.join(
                &logging
                    .client
                    .file
                    .url
                    .split('/')
                    .last()
                    .unwrap_or("log_config.xml")
                    .to_string(),
            ),
            sha1: logging.client.file.sha1.clone(),
            size: 0,
        });
    }
    let os_type = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "osx"
    } else {
        "linux"
    };
    for lib in version_data.libraries {
        if check_rules(&lib.rules, os_type) {
            if let Some(artifact) = lib.downloads.artifact {
                let official_url = format!("https://libraries.minecraft.net/{}", artifact.path);
                let mirror_url = format!("{}/maven/{}", MIRROR_URL, artifact.path);
                tasks.push(DownloadTask {
                    urls: vec![official_url, mirror_url],
                    target_path: minecraft_path.join("libraries").join(&artifact.path),
                    sha1: artifact.sha1,
                    size: artifact.size,
                });
            }
        }
        for native in lib.downloads.classifiers.values() {
            if should_download_native(&native.path) {
                let official_url = format!("https://libraries.minecraft.net/{}", native.path);
                let mirror_url = format!("{}/maven/{}", MIRROR_URL, native.path);
                tasks.push(DownloadTask {
                    urls: vec![official_url, mirror_url],
                    target_path: minecraft_path.join("libraries").join(&native.path),
                    sha1: native.sha1.clone(),
                    size: native.size,
                });
            }
        }
    }
    for (_, obj) in assets_data.objects {
        let prefix = &obj.hash[0..2];
        let official_url = format!(
            "https://resources.download.minecraft.net/{}/{}",
            prefix, obj.hash
        );
        let mirror_url = format!("{}/assets/{}/{}", MIRROR_URL, prefix, obj.hash);
        tasks.push(DownloadTask {
            urls: vec![official_url, mirror_url],
            target_path: minecraft_path
                .join("assets")
                .join("objects")
                .join(prefix)
                .join(&obj.hash),
            sha1: obj.hash,
            size: obj.size,
        });
    }
    let total = tasks.len();
    let total_bytes: u64 = tasks
        .iter()
        .map(|t| if t.size > 0 { t.size } else { 64 * 1024 })
        .sum();
    let progress = Arc::new(DownloadProgress::new());
    let semaphore = Arc::new(Semaphore::new(MAX_CONCURRENT_DOWNLOADS));
    let client = shared_client().await;
    let progress_reporter = {
        let done_counter = progress.done.clone();
        let network_counter = progress.bytes_network.clone();
        let local_counter = progress.bytes_local.clone();
        let tx = progress_tx.clone();
        let total_bytes_for_reporter = total_bytes;
        tokio::spawn(async move {
            let mut last_network = 0u64;
            let mut last_at = std::time::Instant::now();
            let mut primed = false;
            let mut last_logged_percent = -1.0f64;
            // Short window so UI gets ≥1 good interval quickly without near-zero-dt spikes.
            const MIN_SPEED_WINDOW_SECS: f64 = 0.35;
            const MAX_PLAUSIBLE_BPS: f64 = 500.0 * 1024.0 * 1024.0;
            loop {
                let done = done_counter.load(Ordering::SeqCst);
                let network = network_counter.load(Ordering::SeqCst);
                let local = local_counter.load(Ordering::SeqCst);
                let bytes = network.saturating_add(local);
                let file_percent = if total > 0 {
                    (done as f64 / total as f64) * 100.0
                } else {
                    100.0
                };
                let byte_percent = if total_bytes_for_reporter > 0 {
                    (bytes as f64 / total_bytes_for_reporter as f64) * 100.0
                } else {
                    file_percent
                };
                let percent = if done >= total {
                    100.0
                } else if total_bytes_for_reporter > 0 {
                    byte_percent.min(99.5)
                } else {
                    file_percent
                };
                // Speed from network bytes only — local cache reuse must not inflate B/s.
                let elapsed = last_at.elapsed().as_secs_f64();
                let speed = if primed && elapsed >= MIN_SPEED_WINDOW_SECS {
                    let rate = (network.saturating_sub(last_network) as f64) / elapsed;
                    if rate > 0.0 && rate <= MAX_PLAUSIBLE_BPS {
                        Some(rate)
                    } else {
                        None
                    }
                } else {
                    None
                };
                // Hold the sample window open until we have a usable interval.
                if !primed || elapsed >= MIN_SPEED_WINDOW_SECS {
                    last_network = network;
                    last_at = std::time::Instant::now();
                    primed = true;
                }
                // #region agent log
                if (percent - last_logged_percent).abs() >= 2.0 || done == 0 || done >= total {
                    crate::progress_trace_log::progress_trace(
                        "A",
                        "original_dwl.rs:progress_reporter",
                        "vanilla_file_percent",
                        json!({
                            "percent_by_files": file_percent,
                            "percent_by_bytes": byte_percent,
                            "percent_reported": percent,
                            "files_done": done,
                            "files_total": total,
                            "bytes_network": network,
                            "bytes_local": local,
                            "bytes_credited": bytes,
                            "bytes_total": total_bytes_for_reporter,
                            "speed_bps": speed,
                        }),
                    );
                    last_logged_percent = percent;
                }
                // #endregion
                if tx
                    .send(ProgressUpdate {
                        percent,
                        stage: Some("下载原版文件".to_string()),
                        message: Some(format!("已下载 {}/{} 个文件", done, total)),
                        // Report network bytes for UI speed estimators that delta `downloaded`.
                        downloaded: Some(network),
                        speed,
                    })
                    .await
                    .is_err()
                {
                    break;
                }
                if done >= total {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(400)).await;
            }
        })
    };
    let mut futures = Vec::new();
    for task in tasks {
        let semaphore = semaphore.clone();
        let progress = progress.clone();
        let client = client.clone();
        let cancel = cancel.clone();
        futures.push(download_task(
            task,
            client,
            semaphore,
            Some(progress),
            cancel,
        ));
    }
    let results = stream::iter(futures)
        .buffer_unordered(MAX_CONCURRENT_DOWNLOADS)
        .collect::<Vec<_>>()
        .await;
    progress_reporter.abort();
    if cancel.load(Ordering::SeqCst) {
        return Err("已取消".into());
    }
    let mut errors = Vec::new();
    for result in results {
        if let Err(e) = result {
            let msg = e.to_string();
            if msg.contains("已取消") {
                return Err("已取消".into());
            }
            errors.push(msg);
        }
    }
    let done = progress.done.load(Ordering::SeqCst);
    let failed = errors.len();
    println!(
        "下载完成: {}/{} ({:.1}%), 失败: {}",
        done,
        total,
        (done as f64 / total as f64) * 100.0,
        failed
    );
    if cancel.load(Ordering::SeqCst) {
        return Err("已取消".into());
    }
    let _ = progress_tx
        .send(ProgressUpdate::with_stage(98.0, "解压原生库"))
        .await;
    let extract_result = extract_library_paths(
        minecraft_path.to_string_lossy().to_string(),
        version.to_string(),
    )
    .await;
    match extract_result {
        Ok(paths) => {
            println!("成功解压 {} 个原生库", paths.len());
        }
        Err(e) => {
            println!("解压原生库失败: {}", e);
        }
    }
    ensure_options_lang(&version_dir).await?;
    let _ = progress_tx
        .send(ProgressUpdate::with_stage(100.0, "安装原版 Minecraft"))
        .await;
    drop(progress_tx);
    Ok(errors)
}

async fn ensure_options_lang(version_dir: &Path) -> Result<(), Box<dyn Error + Send + Sync>> {
    let options_path = version_dir.join("options.txt");
    if options_path.exists() {
        let content = fs::read_to_string(&options_path)?;
        if content.contains("lang:") {
            let new_content = content
                .lines()
                .map(|line| {
                    if line.trim().starts_with("lang:") {
                        "lang:zh_cn"
                    } else {
                        line
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");
            fs::write(&options_path, new_content)?;
        } else {
            fs::write(&options_path, format!("{}\nlang:zh_cn", content))?;
        }
    } else {
        fs::write(&options_path, "lang:zh_cn")?;
    }
    Ok(())
}
fn check_rules(rules: &[Rule], os_type: &str) -> bool {
    let mut allowed = true;
    for rule in rules {
        let os_match = rule
            .os
            .as_ref()
            .map_or(true, |os| os.name.as_deref() == Some(os_type));
        match rule.action.as_str() {
            "allow" => allowed = os_match,
            "disallow" => allowed = !os_match,
            _ => (),
        }
    }
    allowed
}
fn get_system_tags() -> Vec<&'static str> {
    match env::consts::OS {
        "windows" => vec!["-windows"],
        "linux" => vec!["-linux"],
        "macos" => vec!["-macos", "-osx"],
        _ => vec![],
    }
}
fn match_native_system(path: &str) -> bool {
    let system_tags = get_system_tags();
    if system_tags.is_empty() {
        return false;
    }
    let parts: Vec<&str> = path.split("-natives").collect();
    if parts.len() < 2 {
        return false;
    }
    let post_native = parts[1];
    system_tags.iter().any(|&tag| post_native.starts_with(tag))
}
fn extract_arch_info(path: &str) -> (Option<String>, bool) {
    const OS_NAMES: [&str; 4] = ["windows", "linux", "macos", "osx"];
    let segments: Vec<&str> = path.split('-').collect();
    let (arch_part, has_arch) = segments
        .iter()
        .rev()
        .find(|s| !s.is_empty())
        .and_then(|s| s.split('.').next())
        .map(|s| {
            let is_os = OS_NAMES.contains(&s);
            (s, !is_os)
        })
        .unwrap_or(("", false));
    (
        if has_arch {
            Some(arch_part.to_lowercase())
        } else {
            None
        },
        !has_arch,
    )
}
fn should_download_native(path: &str) -> bool {
    if !path.contains("-natives") {
        return false;
    }
    let is_windows = env::consts::OS == "windows";
    let is_win64_case = is_windows && path.contains("natives-windows-64");
    if !match_native_system(path) && !is_win64_case {
        return false;
    }
    let current_arch = env::consts::ARCH;
    let (arch_opt, is_implicit) = extract_arch_info(path);
    is_win64_case
        || match (arch_opt.as_deref(), is_implicit) {
            (_, true) => current_arch == "x86_64",
            (Some(arch), false) => match current_arch {
                "x86_64" => arch == "x86_64",
                "x86" => arch == "x86",
                "aarch64" => arch == "arm64" || arch == "aarch_64",
                _ => false,
            },
            _ => false,
        }
}
async fn fetch_version_url(version: &str) -> Result<String, Box<dyn Error + Send + Sync>> {
    let client = shared_client().await;
    let response = match client.get(MOJANG_MANIFEST).send().await {
        Ok(res) if res.status().is_success() => res,
        _ => {
            return Ok(format!("{}/mc/game/version_manifest.json", MIRROR_URL));
        }
    };
    let manifest = response
        .json::<VersionManifest>()
        .await
        .map_err(|_| "Failed to parse version manifest")?;
    manifest
        .versions
        .iter()
        .find(|v| v.id == version)
        .map(|e| e.url.clone())
        .or_else(|| {
            manifest
                .versions
                .iter()
                .find(|v| v.id.replace(".", "") == version.replace(".", ""))
                .map(|e| e.url.clone())
        })
        .map(Ok)
        .unwrap_or_else(|| Ok(format!("{}/version/{}/json", MIRROR_URL, version)))
}
