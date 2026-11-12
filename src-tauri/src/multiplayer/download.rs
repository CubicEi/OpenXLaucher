use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{command, AppHandle, Emitter};
use tokio::sync::mpsc;
use zip::ZipArchive;

use crate::downloader::single_file_download::{download_single_file, SingleFileDownloadRequest};
use crate::http_client;

use super::logs::append_text;
use super::paths::{ensure_bridge_dir, read_installed_version, tool_path, write_installed_version};
use super::EASYTIER_BIN;

const GITHUB_LATEST: &str = "https://api.github.com/repos/EasyTier/EasyTier/releases/latest";
const DOWNLOAD_PROGRESS_EVENT: &str = "mp-download-progress";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MpDownloadProgress {
    pub state: String,
    pub percent: f64,
    pub downloaded: Option<u64>,
    pub total: Option<u64>,
    pub message: String,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureInstalledResult {
    pub installed: bool,
    pub path: String,
    pub version: Option<String>,
    pub message: String,
}

struct DownloadState {
    state: String,
    percent: f64,
    downloaded: Option<u64>,
    total: Option<u64>,
    message: String,
    version: Option<String>,
}

static DOWNLOAD_STATE: Mutex<DownloadState> = Mutex::new(DownloadState {
    state: String::new(),
    percent: 0.0,
    downloaded: None,
    total: None,
    message: String::new(),
    version: None,
});
static INSTALL_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

fn set_state(
    app: Option<&AppHandle>,
    state: &str,
    percent: f64,
    downloaded: Option<u64>,
    total: Option<u64>,
    message: &str,
    version: Option<String>,
) {
    if let Ok(mut guard) = DOWNLOAD_STATE.lock() {
        guard.state = state.to_string();
        guard.percent = percent;
        guard.downloaded = downloaded;
        guard.total = total;
        guard.message = message.to_string();
        guard.version = version.clone();
    }
    let payload = MpDownloadProgress {
        state: state.to_string(),
        percent,
        downloaded,
        total,
        message: message.to_string(),
        version,
    };
    if let Some(app) = app {
        let _ = app.emit(DOWNLOAD_PROGRESS_EVENT, payload);
    }
}

pub fn current_download_progress() -> MpDownloadProgress {
    if let Ok(guard) = DOWNLOAD_STATE.lock() {
        if !guard.state.is_empty() {
            return MpDownloadProgress {
                state: guard.state.clone(),
                percent: guard.percent,
                downloaded: guard.downloaded,
                total: guard.total,
                message: guard.message.clone(),
                version: guard.version.clone(),
            };
        }
    }
    let installed = tool_path().map(|p| p.is_file()).unwrap_or(false);
    MpDownloadProgress {
        state: if installed {
            "ready".into()
        } else {
            "idle".into()
        },
        percent: if installed { 100.0 } else { 0.0 },
        downloaded: None,
        total: None,
        message: if installed {
            "已安装".into()
        } else {
            "未安装".into()
        },
        version: read_installed_version(),
    }
}

#[derive(Debug, Deserialize)]
struct ApiAssetRaw {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Deserialize)]
struct ApiRelease {
    tag_name: String,
    #[serde(default)]
    assets: Vec<ApiAssetRaw>,
}

fn target_asset_prefix() -> Result<String, String> {
    let os = match std::env::consts::OS {
        "windows" => "windows",
        "linux" => "linux",
        "macos" => "macos",
        other => return Err(format!("不支持的操作系统: {}", other)),
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => {
            if os == "windows" {
                "arm64"
            } else {
                "aarch64"
            }
        }
        "x86" => {
            if os == "windows" {
                "i686"
            } else {
                return Err("当前 Linux/macOS x86 架构无官方 EasyTier 构建".to_string());
            }
        }
        other => return Err(format!("不支持的 CPU 架构: {}", other)),
    };
    Ok(format!("easytier-{}-{}", os, arch))
}

async fn resolve_latest_asset() -> Result<(String, String, String), String> {
    let client = http_client::shared_client().await;
    let response = client
        .get(GITHUB_LATEST)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "OpenXLauncher-EasyTier")
        .send()
        .await
        .map_err(|e| format!("请求 EasyTier Release 失败: {}", e))?;
    if !response.status().is_success() {
        return Err(format!(
            "GitHub Releases API 返回 HTTP {}",
            response.status()
        ));
    }
    let release: ApiRelease = response
        .json()
        .await
        .map_err(|e| format!("解析 EasyTier Release 失败: {}", e))?;
    let prefix = target_asset_prefix()?;
    let expected_name = format!("{}-{}.zip", prefix, release.tag_name);
    let asset = release
        .assets
        .iter()
        .find(|a| a.name == expected_name)
        .or_else(|| {
            release.assets.iter().find(|a| {
                a.name.starts_with(&prefix) && a.name.ends_with(".zip") && !a.name.contains("gui")
            })
        })
        .ok_or_else(|| format!("未找到匹配资源 {}（或 {}-*.zip）", expected_name, prefix))?;
    Ok((
        release.tag_name,
        asset.name.clone(),
        asset.browser_download_url.clone(),
    ))
}

fn extract_zip(source: &Path, dest: &Path) -> Result<(), String> {
    let file = File::open(source).map_err(|e| format!("打开压缩包失败: {}", e))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("解析 ZIP 失败: {}", e))?;
    fs::create_dir_all(dest).map_err(|e| format!("创建解压目录失败: {}", e))?;
    let canonical_dest = dest
        .canonicalize()
        .map_err(|e| format!("无法解析解压目录: {}", e))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取 ZIP 条目失败: {}", e))?;
        let safe_rel = entry
            .enclosed_name()
            .ok_or_else(|| format!("非法的 zip 条目路径: {}", entry.name()))?;
        if safe_rel
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(format!("拒绝解压包含上级目录引用的条目: {}", entry.name()));
        }
        let outpath = canonical_dest.join(safe_rel);
        if entry.is_dir() {
            fs::create_dir_all(&outpath).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = outpath.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut outfile = File::create(&outpath).map_err(|e| e.to_string())?;
            io::copy(&mut entry, &mut outfile).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn find_file_named(root: &Path, file_name: &str) -> Option<PathBuf> {
    fn walk(dir: &Path, file_name: &str) -> Option<PathBuf> {
        let entries = fs::read_dir(dir).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Some(found) = walk(&path, file_name) {
                    return Some(found);
                }
            } else if path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.eq_ignore_ascii_case(file_name))
                .unwrap_or(false)
            {
                return Some(path);
            }
        }
        None
    }
    walk(root, file_name)
}

fn copy_easytier_payload(extract_root: &Path, bridge: &Path) -> Result<PathBuf, String> {
    let core = find_file_named(extract_root, EASYTIER_BIN)
        .ok_or_else(|| format!("压缩包中未找到 {}", EASYTIER_BIN))?;
    let core_dir = core
        .parent()
        .ok_or_else(|| "无法解析 easytier-core 所在目录".to_string())?;

    fs::create_dir_all(bridge).map_err(|e| format!("创建 bridge 失败: {}", e))?;

    for entry in fs::read_dir(core_dir).map_err(|e| format!("读取解压目录失败: {}", e))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        let lower = name.to_ascii_lowercase();
        let copy = lower.starts_with("easytier")
            || lower.ends_with(".dll")
            || lower.ends_with(".sys")
            || lower == EASYTIER_BIN.to_ascii_lowercase();
        if !copy {
            continue;
        }
        let dest = bridge.join(name);
        fs::copy(&path, &dest).map_err(|e| {
            format!(
                "复制 {} -> {} 失败: {}",
                path.display(),
                dest.display(),
                e
            )
        })?;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let dest = bridge.join(EASYTIER_BIN);
        if dest.is_file() {
            let mut perms = fs::metadata(&dest)
                .map_err(|e| format!("获取权限失败: {}", e))?
                .permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&dest, perms).map_err(|e| format!("设置执行权限失败: {}", e))?;
        }
        // 同目录其它 easytier 可执行文件也赋予执行权
        if let Ok(entries) = fs::read_dir(bridge) {
            for entry in entries.flatten() {
                let path = entry.path();
                let name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                if path.is_file() && name.starts_with("easytier") && !name.contains('.') {
                    if let Ok(meta) = fs::metadata(&path) {
                        let mut perms = meta.permissions();
                        perms.set_mode(0o755);
                        let _ = fs::set_permissions(&path, perms);
                    }
                }
            }
        }
    }

    let final_path = bridge.join(EASYTIER_BIN);
    if !final_path.is_file() {
        return Err(format!("安装后仍未找到 {}", final_path.display()));
    }
    Ok(final_path)
}

async fn install_latest(app: &AppHandle) -> Result<EnsureInstalledResult, String> {
    set_state(
        Some(app),
        "resolving",
        0.0,
        None,
        None,
        "正在查询 EasyTier 最新版本…",
        None,
    );
    append_text("[OpenXLauncher] 查询 EasyTier GitHub Release…\n");

    let (tag, asset_name, url) = resolve_latest_asset().await?;
    append_text(&format!(
        "[OpenXLauncher] 版本 {}，资源 {}\n",
        tag, asset_name
    ));

    let bridge = ensure_bridge_dir()?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let temp_dir = std::env::temp_dir().join(format!("openx-easytier-{}", stamp));
    fs::create_dir_all(&temp_dir).map_err(|e| format!("创建临时目录失败: {}", e))?;

    set_state(
        Some(app),
        "downloading",
        0.0,
        Some(0),
        None,
        &format!("正在下载 {}…", asset_name),
        Some(tag.clone()),
    );

    let (progress_tx, mut progress_rx) = mpsc::channel::<(u64, u64)>(32);
    let app_progress = app.clone();
    let tag_progress = tag.clone();
    let forward = tauri::async_runtime::spawn(async move {
        while let Some((downloaded, total)) = progress_rx.recv().await {
            let percent = if total > 0 {
                (downloaded as f64 / total as f64) * 90.0
            } else {
                0.0
            };
            set_state(
                Some(&app_progress),
                "downloading",
                percent,
                Some(downloaded),
                if total > 0 { Some(total) } else { None },
                "正在下载 EasyTier…",
                Some(tag_progress.clone()),
            );
        }
    });

    let cancel = std::sync::Arc::new(AtomicBool::new(false));
    let result = download_single_file(
        SingleFileDownloadRequest {
            url,
            target_dir: temp_dir.clone(),
            file_name: asset_name,
            sha1: None,
            cancel: Some(cancel),
        },
        Some(progress_tx),
    )
    .await;
    let _ = forward.await;

    let outcome = match result {
        Ok(outcome) => outcome,
        Err(e) => {
            let _ = fs::remove_dir_all(&temp_dir);
            set_state(Some(app), "error", 0.0, None, None, &e, Some(tag.clone()));
            return Err(e);
        }
    };

    set_state(
        Some(app),
        "extracting",
        92.0,
        Some(outcome.size),
        Some(outcome.size),
        "正在解压 EasyTier…",
        Some(tag.clone()),
    );
    append_text("[OpenXLauncher] 正在解压 EasyTier…\n");

    let extract_dir = temp_dir.join("extract");
    if let Err(e) = extract_zip(&outcome.path, &extract_dir) {
        let _ = fs::remove_dir_all(&temp_dir);
        set_state(Some(app), "error", 0.0, None, None, &e, Some(tag.clone()));
        return Err(e);
    }

    let installed_path = match copy_easytier_payload(&extract_dir, &bridge) {
        Ok(p) => p,
        Err(e) => {
            let _ = fs::remove_dir_all(&temp_dir);
            set_state(Some(app), "error", 0.0, None, None, &e, Some(tag.clone()));
            return Err(e);
        }
    };
    write_installed_version(&tag)?;
    let _ = fs::remove_dir_all(&temp_dir);

    set_state(
        Some(app),
        "ready",
        100.0,
        None,
        None,
        "EasyTier 已就绪",
        Some(tag.clone()),
    );
    append_text(&format!(
        "[OpenXLauncher] ✅ EasyTier 已安装: {}\n",
        installed_path.display()
    ));

    Ok(EnsureInstalledResult {
        installed: true,
        path: installed_path.display().to_string(),
        version: Some(tag),
        message: "安装完成".into(),
    })
}

#[command(rename_all = "camelCase")]
pub async fn mp_ensure_installed(app: AppHandle) -> Result<EnsureInstalledResult, String> {
    let path = tool_path()?;
    if path.is_file() {
        let version = read_installed_version();
        set_state(
            Some(&app),
            "ready",
            100.0,
            None,
            None,
            "已安装",
            version.clone(),
        );
        return Ok(EnsureInstalledResult {
            installed: true,
            path: path.display().to_string(),
            version,
            message: "已安装".into(),
        });
    }

    // 避免并发重复下载；不跨 await 持有 std MutexGuard。
    loop {
        if INSTALL_IN_PROGRESS
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            let path = tool_path()?;
            if path.is_file() {
                INSTALL_IN_PROGRESS.store(false, Ordering::SeqCst);
                let version = read_installed_version();
                return Ok(EnsureInstalledResult {
                    installed: true,
                    path: path.display().to_string(),
                    version,
                    message: "已安装".into(),
                });
            }
            let result = install_latest(&app).await;
            INSTALL_IN_PROGRESS.store(false, Ordering::SeqCst);
            return result;
        }

        let path = tool_path()?;
        if path.is_file() {
            let version = read_installed_version();
            return Ok(EnsureInstalledResult {
                installed: true,
                path: path.display().to_string(),
                version,
                message: "已安装".into(),
            });
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
}

#[command(rename_all = "camelCase")]
pub fn mp_get_download_progress() -> MpDownloadProgress {
    current_download_progress()
}
