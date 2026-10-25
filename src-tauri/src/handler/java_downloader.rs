//! Multi-vendor Java JDK download / install helpers.
//!
//! Zulu & Adoptium: resolve a direct installer URL → download to temp → launch installer.
//! Oracle / Microsoft: open the vendor download page (no stable free direct link).

use futures::stream::StreamExt;
use serde::{Deserialize, Serialize};
use std::env;
use std::path::Path;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::Emitter;
use tokio::fs::File;
use tokio::io::AsyncWriteExt;

const JAVA_MAJORS: &[u32] = &[8, 11, 17, 21, 25];
const DOWNLOAD_BUFFER_SIZE: usize = 65536;
const MAX_DOWNLOAD_RETRIES: usize = 5;
const INITIAL_RETRY_DELAY_MS: u64 = 500;
const MAX_RETRY_DELAY_MS: u64 = 8000;

struct JavaActiveTaskInfo {
    cancel: Arc<AtomicBool>,
}

fn java_active_tasks() -> &'static Mutex<HashMap<u64, JavaActiveTaskInfo>> {
    static INSTANCE: OnceLock<Mutex<HashMap<u64, JavaActiveTaskInfo>>> = OnceLock::new();
    INSTANCE.get_or_init(|| Mutex::new(HashMap::new()))
}

struct JavaTaskRegistration {
    task_id: u64,
}

impl Drop for JavaTaskRegistration {
    fn drop(&mut self) {
        let mut tasks = java_active_tasks().lock().unwrap_or_else(|e| e.into_inner());
        tasks.remove(&self.task_id);
    }
}

fn register_java_task(task_id: u64, cancel: Arc<AtomicBool>) {
    let mut tasks = java_active_tasks().lock().unwrap_or_else(|e| e.into_inner());
    tasks.insert(task_id, JavaActiveTaskInfo { cancel });
}

fn java_cancelled(cancel: &Arc<AtomicBool>) -> bool {
    cancel.load(Ordering::SeqCst)
}

#[tauri::command]
pub async fn cancel_java_download(task_id: u64) -> Result<(), String> {
    let tasks = java_active_tasks().lock().map_err(|e| e.to_string())?;
    if let Some(info) = tasks.get(&task_id) {
        info.cancel.store(true, Ordering::SeqCst);
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum JavaVendor {
    Zulu,
    Adoptium,
    Oracle,
    Microsoft,
}

impl JavaVendor {
    fn parse(s: &str) -> Result<Self, String> {
        match s.trim().to_ascii_lowercase().as_str() {
            "zulu" | "azul" | "azul-zulu" => Ok(Self::Zulu),
            "adoptium" | "temurin" | "eclipse-temurin" => Ok(Self::Adoptium),
            "oracle" => Ok(Self::Oracle),
            "microsoft" | "msft" | "microsoft-openjdk" => Ok(Self::Microsoft),
            other => Err(format!("不支持的 Java 发行版: {}", other)),
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::Zulu => "zulu",
            Self::Adoptium => "adoptium",
            Self::Oracle => "oracle",
            Self::Microsoft => "microsoft",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Zulu => "Zulu JDK",
            Self::Adoptium => "Temurin",
            Self::Oracle => "Oracle JDK",
            Self::Microsoft => "Microsoft OpenJDK",
        }
    }

    fn offer_label(self, major: u32) -> String {
        format!("{} {}", self.label(), major)
    }
}

#[derive(Debug, Clone, Copy)]
struct PlatformInfo {
    /// Azul metadata `os`
    zulu_os: &'static str,
    /// Azul metadata `arch`
    zulu_arch: &'static str,
    /// Azul `archive_type` for installer packages
    zulu_archive: &'static str,
    /// Adoptium `os`
    adoptium_os: &'static str,
    /// Adoptium `architecture`
    adoptium_arch: &'static str,
}

fn current_platform() -> Option<PlatformInfo> {
    match (env::consts::OS, env::consts::ARCH) {
        ("windows", "x86_64") => Some(PlatformInfo {
            zulu_os: "windows",
            zulu_arch: "x64",
            zulu_archive: "msi",
            adoptium_os: "windows",
            adoptium_arch: "x64",
        }),
        ("windows", "aarch64") => Some(PlatformInfo {
            zulu_os: "windows",
            zulu_arch: "aarch64",
            zulu_archive: "msi",
            adoptium_os: "windows",
            adoptium_arch: "aarch64",
        }),
        ("windows", "x86") => Some(PlatformInfo {
            zulu_os: "windows",
            zulu_arch: "x86",
            zulu_archive: "msi",
            adoptium_os: "windows",
            adoptium_arch: "x86",
        }),
        ("linux", "x86_64") => Some(PlatformInfo {
            zulu_os: "linux",
            zulu_arch: "x64",
            zulu_archive: "deb",
            adoptium_os: "linux",
            adoptium_arch: "x64",
        }),
        ("linux", "aarch64") => Some(PlatformInfo {
            zulu_os: "linux",
            zulu_arch: "aarch64",
            zulu_archive: "deb",
            adoptium_os: "linux",
            adoptium_arch: "aarch64",
        }),
        ("macos", "x86_64") => Some(PlatformInfo {
            zulu_os: "macos",
            zulu_arch: "x64",
            zulu_archive: "dmg",
            adoptium_os: "mac",
            adoptium_arch: "x64",
        }),
        ("macos", "aarch64") => Some(PlatformInfo {
            zulu_os: "macos",
            zulu_arch: "aarch64",
            zulu_archive: "dmg",
            adoptium_os: "mac",
            adoptium_arch: "aarch64",
        }),
        _ => None,
    }
}

/// Majors known to be generally available for the current platform.
fn majors_for_platform(platform: &PlatformInfo) -> Vec<u32> {
    let mut majors = JAVA_MAJORS.to_vec();
    // Older 32-bit Windows builds rarely ship Java 25.
    if platform.zulu_arch == "x86" {
        majors.retain(|m| *m <= 21);
    }
    majors
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct JavaDistributionOffer {
    pub vendor: String,
    pub vendor_label: String,
    pub major: u32,
    pub label: String,
    /// `installer` = download+launch; `external` = open browser page
    pub download_mode: String,
    pub external_url: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct JavaInstallResult {
    pub message: String,
    pub label: String,
    pub installer_path: Option<String>,
    pub opened_external: bool,
}

fn oracle_download_page(major: u32) -> String {
    format!(
        "https://www.oracle.com/java/technologies/downloads/#java{}",
        major
    )
}

fn microsoft_download_page(major: u32) -> String {
    format!(
        "https://learn.microsoft.com/java/openjdk/download#{}--lts",
        major
    )
}

#[tauri::command]
pub async fn list_java_distributions() -> Result<Vec<JavaDistributionOffer>, String> {
    let platform = current_platform().ok_or_else(|| "不支持的系统或架构".to_string())?;
    let majors = majors_for_platform(&platform);
    let mut offers = Vec::new();

    for vendor in [
        JavaVendor::Zulu,
        JavaVendor::Adoptium,
        JavaVendor::Oracle,
        JavaVendor::Microsoft,
    ] {
        for &major in &majors {
            let (download_mode, external_url) = match vendor {
                JavaVendor::Zulu | JavaVendor::Adoptium => ("installer".to_string(), None),
                JavaVendor::Oracle => ("external".to_string(), Some(oracle_download_page(major))),
                JavaVendor::Microsoft => {
                    ("external".to_string(), Some(microsoft_download_page(major)))
                }
            };
            offers.push(JavaDistributionOffer {
                vendor: vendor.id().to_string(),
                vendor_label: vendor.label().to_string(),
                major,
                label: vendor.offer_label(major),
                download_mode,
                external_url,
            });
        }
    }

    Ok(offers)
}

/// One-click Zulu install (download center + launch-time incompatible dialog).
#[tauri::command]
pub async fn install_zulu_jdk(
    major: u32,
    task_id: u64,
    window: tauri::WebviewWindow,
) -> Result<JavaInstallResult, String> {
    download_and_install_java("zulu".to_string(), major, task_id, window).await
}

#[tauri::command]
pub async fn download_and_install_java(
    vendor: String,
    major: u32,
    task_id: u64,
    window: tauri::WebviewWindow,
) -> Result<JavaInstallResult, String> {
    let vendor = JavaVendor::parse(&vendor)?;
    let label = vendor.offer_label(major);

    match vendor {
        JavaVendor::Oracle | JavaVendor::Microsoft => {
            let url = match vendor {
                JavaVendor::Oracle => oracle_download_page(major),
                JavaVendor::Microsoft => microsoft_download_page(major),
                _ => unreachable!(),
            };
            webbrowser::open(&url).map_err(|e| format!("打开下载页面失败: {}", e))?;
            let _ = window.emit(
                "java-download-finished",
                serde_json::json!({
                    "task_id": task_id,
                    "success": true,
                    "error": null,
                    "label": label,
                }),
            );
            return Ok(JavaInstallResult {
                message: format!("{} 需手动下载安装，已打开官网页面", label),
                label,
                installer_path: None,
                opened_external: true,
            });
        }
        JavaVendor::Zulu | JavaVendor::Adoptium => {}
    }

    let platform = current_platform().ok_or_else(|| "不支持的系统或架构".to_string())?;
    if !majors_for_platform(&platform).contains(&major) {
        return Err(format!("当前平台不提供 Java {}", major));
    }

    let cancel = Arc::new(AtomicBool::new(false));
    register_java_task(task_id, cancel.clone());
    let _java_task_guard = JavaTaskRegistration { task_id };

    if java_cancelled(&cancel) {
        let msg = "已取消".to_string();
        let _ = window.emit(
            "java-download-finished",
            serde_json::json!({
                "task_id": task_id,
                "success": false,
                "error": msg,
                "label": label,
            }),
        );
        return Err(msg);
    }

    let resolve_result = match vendor {
        JavaVendor::Zulu => resolve_zulu_installer(&platform, major).await,
        JavaVendor::Adoptium => resolve_adoptium_installer(&platform, major).await,
        _ => unreachable!(),
    };

    if java_cancelled(&cancel) {
        let msg = "已取消".to_string();
        let _ = window.emit(
            "java-download-finished",
            serde_json::json!({
                "task_id": task_id,
                "success": false,
                "error": msg,
                "label": label,
            }),
        );
        return Err(msg);
    }

    let (download_url, file_name) = match resolve_result {
        Ok(v) => v,
        Err(e) => {
            // Fallback: open vendor download page
            let fallback = match vendor {
                JavaVendor::Zulu => format!(
                    "https://www.azul.com/downloads/?version=java-{}-lts&package=jdk#zulu",
                    major
                ),
                JavaVendor::Adoptium => format!(
                    "https://adoptium.net/temurin/releases/?version={}",
                    major
                ),
                _ => oracle_download_page(major),
            };
            let _ = webbrowser::open(&fallback);
            let _ = window.emit(
                "java-download-finished",
                serde_json::json!({
                    "task_id": task_id,
                    "success": false,
                    "error": e,
                    "label": label,
                }),
            );
            return Err(format!("{}：{}（已打开下载页面）", label, e));
        }
    };

    let temp_dir = env::temp_dir().join("OpenXLauncher").join("java-installers");
    tokio::fs::create_dir_all(&temp_dir)
        .await
        .map_err(|e| format!("创建临时目录失败: {}", e))?;
    let installer_path = temp_dir.join(&file_name);

    let download_outcome = download_installer_with_progress(
        &download_url,
        &installer_path,
        task_id,
        &label,
        window.clone(),
        cancel.clone(),
    )
    .await;

    if let Err(e) = download_outcome {
        let _ = window.emit(
            "java-download-finished",
            serde_json::json!({
                "task_id": task_id,
                "success": false,
                "error": e,
                "label": label,
            }),
        );
        return Err(e);
    }

    if let Err(e) = launch_installer(&installer_path) {
        // UAC cancel / missing association → open page as fallback
        let fallback = match vendor {
            JavaVendor::Zulu => format!(
                "https://www.azul.com/downloads/?version=java-{}-lts&package=jdk#zulu",
                major
            ),
            JavaVendor::Adoptium => {
                format!("https://adoptium.net/temurin/releases/?version={}", major)
            }
            _ => oracle_download_page(major),
        };
        let _ = webbrowser::open(&fallback);
        let msg = format!("已下载安装包，但启动安装程序失败: {}（已打开下载页面）", e);
        let _ = window.emit(
            "java-download-finished",
            serde_json::json!({
                "task_id": task_id,
                "success": false,
                "error": msg,
                "label": label,
            }),
        );
        return Err(msg);
    }

    let _ = window.emit(
        "java-download-finished",
        serde_json::json!({
            "task_id": task_id,
            "success": true,
            "error": null,
            "label": label,
        }),
    );

    Ok(JavaInstallResult {
        message: format!(
            "{} 安装程序已启动，请按提示完成安装后重新扫描 Java",
            label
        ),
        label,
        installer_path: Some(installer_path.to_string_lossy().to_string()),
        opened_external: false,
    })
}

#[derive(Debug, Deserialize)]
struct ZuluPackage {
    download_url: String,
    name: String,
}

async fn resolve_zulu_installer(
    platform: &PlatformInfo,
    major: u32,
) -> Result<(String, String), String> {
    let client = crate::http_client::shared_client().await;
    let url = format!(
        "https://api.azul.com/metadata/v1/zulu/packages/?java_version={}&os={}&arch={}&archive_type={}&java_package_type=jdk&latest=true&release_status=ga&javafx_bundled=false&availability_types=CA&page=1&page_size=5",
        major, platform.zulu_os, platform.zulu_arch, platform.zulu_archive
    );
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("请求 Zulu API 失败: {}", e))?;
    if !response.status().is_success() {
        return Err(format!("Zulu API HTTP {}", response.status()));
    }
    let packages: Vec<ZuluPackage> = response
        .json()
        .await
        .map_err(|e| format!("解析 Zulu API 失败: {}", e))?;
    let pkg = packages
        .into_iter()
        .next()
        .ok_or_else(|| format!("未找到 Zulu JDK {} 安装包", major))?;
    Ok((pkg.download_url, pkg.name))
}

async fn resolve_adoptium_installer(
    platform: &PlatformInfo,
    major: u32,
) -> Result<(String, String), String> {
    // Installer endpoint redirects to the GitHub release asset; shared client
    // follows redirects when downloading. Probe with HEAD first.
    let installer_api = format!(
        "https://api.adoptium.net/v3/installer/latest/{}/ga/{}/{}/jdk/hotspot/normal/eclipse?project=jdk",
        major, platform.adoptium_os, platform.adoptium_arch
    );

    let client = crate::http_client::shared_client().await;
    let response = client
        .head(&installer_api)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("请求 Adoptium installer API 失败: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Adoptium installer API HTTP {}（Java {}）",
            response.status(),
            major
        ));
    }

    let ext = match platform.adoptium_os {
        "windows" => "msi",
        "mac" => "pkg",
        _ => "deb",
    };
    let file_name = format!(
        "OpenJDK{}U-jdk_{}_{}_hotspot.{}",
        major, platform.adoptium_arch, platform.adoptium_os, ext
    );
    Ok((installer_api, file_name))
}

async fn download_installer_with_progress(
    url: &str,
    target: &Path,
    task_id: u64,
    label: &str,
    window: tauri::WebviewWindow,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let client = crate::http_client::shared_client().await;
    let mut last_error = None;

    for attempt in 0..MAX_DOWNLOAD_RETRIES {
        if java_cancelled(&cancel) {
            let _ = tokio::fs::remove_file(target).await;
            return Err("已取消".to_string());
        }

        if attempt > 0 {
            let backoff = std::cmp::min(
                INITIAL_RETRY_DELAY_MS * (1u64 << (attempt - 1)),
                MAX_RETRY_DELAY_MS,
            );
            tokio::time::sleep(Duration::from_millis(backoff)).await;
            let _ = tokio::fs::remove_file(target).await;
        }

        match download_once(&client, url, target, task_id, label, window.clone(), cancel.clone())
            .await
        {
            Ok(()) => {
                let _ = window.emit(
                    "java-download-progress",
                    serde_json::json!({
                        "task_id": task_id,
                        "percent": 100.0,
                        "label": label,
                    }),
                );
                return Ok(());
            }
            Err(e) => {
                if e == "已取消" {
                    let _ = tokio::fs::remove_file(target).await;
                    return Err(e);
                }
                eprintln!(
                    "[Java下载] {} 尝试 {}/{} 失败: {}",
                    label,
                    attempt + 1,
                    MAX_DOWNLOAD_RETRIES,
                    e
                );
                last_error = Some(e);
            }
        }
    }

    Err(format!(
        "下载失败: {}（已重试 {} 次）",
        last_error.unwrap_or_else(|| "未知错误".to_string()),
        MAX_DOWNLOAD_RETRIES
    ))
}

async fn download_once(
    client: &reqwest::Client,
    url: &str,
    target: &Path,
    task_id: u64,
    label: &str,
    window: tauri::WebviewWindow,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("创建目录失败: {}", e))?;
    }

    let response = client
        .get(url)
        .timeout(Duration::from_secs(600))
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }

    let total = response.content_length().unwrap_or(0);
    let downloaded = Arc::new(AtomicU64::new(0));
    let downloaded_for_report = downloaded.clone();
    let label_owned = label.to_string();
    let window_clone = window.clone();
    let reporter = tokio::spawn(async move {
        let mut last_done = 0u64;
        let mut last_at = std::time::Instant::now();
        let mut primed = false;
        const MIN_SPEED_WINDOW_SECS: f64 = 0.35;
        const MAX_PLAUSIBLE_BPS: f64 = 500.0 * 1024.0 * 1024.0;
        loop {
            let done = downloaded_for_report.load(Ordering::Relaxed);
            let percent = if total > 0 {
                (done as f64 / total as f64) * 100.0
            } else {
                0.0
            };
            let elapsed = last_at.elapsed().as_secs_f64();
            let speed = if primed && elapsed >= MIN_SPEED_WINDOW_SECS {
                let rate = (done.saturating_sub(last_done) as f64) / elapsed;
                if rate > 0.0 && rate <= MAX_PLAUSIBLE_BPS {
                    Some(rate)
                } else {
                    None
                }
            } else {
                None
            };
            if !primed || elapsed >= MIN_SPEED_WINDOW_SECS {
                last_done = done;
                last_at = std::time::Instant::now();
                primed = true;
            }
            let _ = window_clone.emit(
                "java-download-progress",
                serde_json::json!({
                    "task_id": task_id,
                    "percent": percent.min(99.0),
                    "label": label_owned,
                    "stage": "下载",
                    "downloaded": done,
                    "total": total,
                    "speed": speed,
                }),
            );
            if total > 0 && done >= total {
                break;
            }
            tokio::time::sleep(Duration::from_millis(350)).await;
        }
    });

    let mut stream = response.bytes_stream();
    let file = File::create(target)
        .await
        .map_err(|e| format!("创建文件失败: {}", e))?;
    let mut writer = tokio::io::BufWriter::with_capacity(DOWNLOAD_BUFFER_SIZE, file);

    let mut cancelled = false;
    while let Some(chunk) = stream.next().await {
        if java_cancelled(&cancel) {
            cancelled = true;
            break;
        }
        let chunk = chunk.map_err(|e| format!("读取数据失败: {}", e))?;
        downloaded.fetch_add(chunk.len() as u64, Ordering::Relaxed);
        writer
            .write_all(&chunk)
            .await
            .map_err(|e| format!("写入文件失败: {}", e))?;
    }

    reporter.abort();
    let _ = reporter.await;

    if cancelled || java_cancelled(&cancel) {
        let _ = writer.flush().await;
        let _ = writer.into_inner();
        let _ = tokio::fs::remove_file(target).await;
        return Err("已取消".to_string());
    }

    writer
        .flush()
        .await
        .map_err(|e| format!("刷新缓冲区失败: {}", e))?;
    writer
        .into_inner()
        .sync_all()
        .await
        .map_err(|e| format!("同步文件失败: {}", e))?;

    Ok(())
}

fn launch_installer(path: &Path) -> Result<(), String> {
    let path_str = path
        .to_str()
        .ok_or_else(|| "安装包路径无效".to_string())?;

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW for the helper; the MSI UI still shows via ShellExecute association.
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let status = if ext == "msi" {
            std::process::Command::new("msiexec")
                .args(["/i", path_str])
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
        } else {
            std::process::Command::new("cmd")
                .args(["/C", "start", "", path_str])
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
        };
        status.map_err(|e| format!("启动安装程序失败: {}", e))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("启动安装程序失败: {}", e))?;
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        // Prefer xdg-open so .deb/.rpm open with the system package UI when available.
        let result = std::process::Command::new("xdg-open").arg(path).spawn();
        if result.is_err() {
            std::process::Command::new("gio")
                .args(["open", path_str])
                .spawn()
                .map_err(|e| format!("启动安装程序失败: {}", e))?;
        }
        return Ok(());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = path_str;
        Err("当前平台不支持自动启动安装程序".to_string())
    }
}
