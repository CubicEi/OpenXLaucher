use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use crate::downloader::single_file_download::{
    download_url_to_path, error_is_cancelled, SingleFileDownloadOutcome,
};

use super::config::{
    get_current_os, get_update_config, is_trusted_release_asset_url, is_valid_sha256_hex,
    save_update_config, should_check_update, update_download_dir, UpdateStatus,
};
use super::github_release::{
    fetch_latest_release_bundle, redirect_policy, update_check_timeout_message,
    UPDATE_CHECK_TIMEOUT_SECS,
};
use super::identity::{credentials_differ, local_identity_for_update};

pub type UpdateProgressCallback = Arc<dyn Fn(f64) + Send + Sync>;

fn log_updater(level: &str, message: &str, data: Option<serde_json::Value>) {
    let _ = crate::handler::runtime_log::append_runtime_log(level, "updater", message, data);
}

struct DownloadProgressWriter {
    last_pct: f64,
    last_at: Instant,
}

impl DownloadProgressWriter {
    fn new() -> Self {
        Self {
            last_pct: -1.0,
            last_at: Instant::now(),
        }
    }

    fn report(&mut self, pct: f64, on_progress: Option<&UpdateProgressCallback>) {
        let clamped = pct.clamp(0.0, 100.0);
        let now = Instant::now();
        if clamped < 100.0
            && clamped - self.last_pct < 0.5
            && now.duration_since(self.last_at).as_millis() < 250
        {
            return;
        }
        self.last_pct = clamped;
        self.last_at = now;
        let mut cfg = get_update_config();
        cfg.download_progress = Some(clamped);
        let _ = save_update_config(cfg);
        if let Some(cb) = on_progress {
            cb(clamped);
        }
    }
}

fn filename_from_download_url(download_url: &str) -> Result<String, String> {
    let parsed = url::Url::parse(download_url).map_err(|e| format!("更新下载地址无效: {}", e))?;
    let encoded_name = parsed
        .path_segments()
        .and_then(|segments| segments.filter(|segment| !segment.is_empty()).next_back())
        .ok_or_else(|| "更新下载地址缺少文件名".to_string())?;
    urlencoding::decode(encoded_name)
        .map(|name| name.into_owned())
        .map_err(|e| format!("更新文件名编码无效: {}", e))
}

#[derive(Clone)]
pub struct UpdateFetcher {
    cancel_flag: Arc<AtomicBool>,
    is_downloading: Arc<AtomicBool>,
}

/// RAII 守卫：构造时把 `is_downloading` 置为 true；`drop()` 时无论函数如何退出（panic、?、break），
/// 都一定会把该原子标志重置，防止下载失败后启动器永远卡在"下载中"无法重试。
///
/// 同时在 drop 时检查状态机：如果仍然停留在 `Downloading`，说明是异常退出，
/// 需要把状态写成 `Error(...)` 并删除半下载文件。
struct DownloadGuard {
    flag: Arc<AtomicBool>,
    active: bool,
    /// 异常退出时清理的路径（正式文件 + `.downloading_` 临时文件）。
    cleanup_paths: Vec<PathBuf>,
}

impl DownloadGuard {
    fn new(flag: Arc<AtomicBool>) -> Self {
        flag.store(true, Ordering::SeqCst);
        Self {
            flag,
            active: true,
            cleanup_paths: Vec::new(),
        }
    }

    fn set_cleanup_paths(&mut self, paths: impl IntoIterator<Item = PathBuf>) {
        self.cleanup_paths = paths.into_iter().collect();
    }

    fn cleanup_now(&self) {
        for p in &self.cleanup_paths {
            let _ = fs::remove_file(p);
        }
    }

    /// 成功结束时调用：取消 guard 的副作用。
    fn defuse(mut self) {
        self.active = false;
        self.cleanup_paths.clear();
    }

    /// 调用方已经自己处理了状态，只想立刻重置标志。
    fn manual_reset(&mut self) {
        self.flag.store(false, Ordering::SeqCst);
    }
}

impl Drop for DownloadGuard {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::SeqCst);
        if !self.active {
            return;
        }
        let mut cfg = get_update_config();
        if matches!(cfg.status, UpdateStatus::Downloading) {
            cfg.status = UpdateStatus::Error("下载过程中出现异常，已中止".to_string());
            cfg.download_progress = None;
            let _ = save_update_config(cfg);
        }
        for p in self.cleanup_paths.drain(..) {
            let _ = fs::remove_file(p);
        }
    }
}

fn downloading_temp_path(target: &Path) -> PathBuf {
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let name = target
        .file_name()
        .map(|s| s.to_string_lossy())
        .unwrap_or_default();
    parent.join(format!(".downloading_{}", name))
}

impl UpdateFetcher {
    pub fn new() -> Self {
        Self {
            cancel_flag: Arc::new(AtomicBool::new(false)),
            is_downloading: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn cancel(&self) {
        self.cancel_flag.store(true, Ordering::SeqCst);
    }

    /// 计算磁盘文件的 SHA-256，返回小写十六进制 64 字符串。
    pub(crate) fn sha256_of_file(path: &Path) -> Result<String, String> {
        let mut f = fs::File::open(path).map_err(|e| format!("打开文件失败: {}", e))?;
        let mut hasher = Sha256::new();
        let mut buf = [0u8; 64 * 1024];
        loop {
            let n = f
                .read(&mut buf)
                .map_err(|e| format!("读取文件失败: {}", e))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        let digest = hasher.finalize();
        Ok(hex_encode_lower(&digest))
    }
}

/// 删除 `OpenX/update` 中与期望哈希不一致（或无法校验）的安装包文件。
fn remove_mismatched_update_files(expected_sha256: Option<&str>) {
    let dir = update_download_dir();
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy())
            .unwrap_or_default();
        if name.starts_with(".downloading_") {
            let _ = fs::remove_file(&path);
            continue;
        }
        let keep = expected_sha256
            .filter(|s| is_valid_sha256_hex(s))
            .and_then(|expected| {
                UpdateFetcher::sha256_of_file(&path)
                    .ok()
                    .map(|actual| actual == expected)
            })
            .unwrap_or(false);
        if !keep {
            let _ = fs::remove_file(&path);
        }
    }
}

/// 在 `OpenX/update`（或已记录的 `download_path`）中查找与 `expected_sha256` 一致的安装包；
/// 命中则将状态置为 `Downloaded` 并返回 true。
pub fn reconcile_local_update_package(cfg: &mut super::config::UpdateConfig) -> bool {
    use super::config::{update_download_dir, UpdateStatus};

    let Some(expected) = cfg.expected_sha256.as_ref() else {
        return false;
    };
    if !is_valid_sha256_hex(expected) {
        return false;
    }

    let matches_file = |path: &Path| -> bool {
        if !path.is_file() {
            return false;
        }
        UpdateFetcher::sha256_of_file(path)
            .map(|actual| actual == *expected)
            .unwrap_or(false)
    };

    if let Some(path_str) = cfg.download_path.as_ref() {
        let path = PathBuf::from(path_str);
        if matches_file(&path) {
            cfg.status = UpdateStatus::Downloaded;
            cfg.download_progress = Some(100.0);
            cfg.download_path = Some(path.to_string_lossy().to_string());
            return true;
        }
    }

    let dir = update_download_dir();
    let Ok(entries) = fs::read_dir(&dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if matches_file(&path) {
            cfg.download_path = Some(path.to_string_lossy().to_string());
            cfg.status = UpdateStatus::Downloaded;
            cfg.download_progress = Some(100.0);
            log_updater(
                "info",
                "发现本地已缓存的启动器更新包",
                Some(json!({
                    "path": path.to_string_lossy(),
                    "targetVersion": cfg.target_version,
                })),
            );
            return true;
        }
    }

    false
}

impl UpdateFetcher {
    pub async fn check_for_update(
        &self,
        force: bool,
        current_version: &str,
    ) -> Result<UpdateCheckResult, String> {
        if !force && !should_check_update() {
            let cfg = get_update_config();
            let cached_update_available = cfg.status == UpdateStatus::Available;
            return Ok(UpdateCheckResult {
                needs_check: false,
                update_available: cached_update_available,
                package_ready: cfg.status == UpdateStatus::Downloaded,
                current_version: current_version.to_string(),
                target_version: cfg.target_version,
                message: "距上次检查不足5秒，请稍后再试".to_string(),
                changelog: cfg.changelog,
            });
        }

        self.cancel_flag.store(false, Ordering::SeqCst);

        let mut cfg = get_update_config();
        cfg.current_version = current_version.to_string();
        cfg.status = UpdateStatus::Checking;
        cfg.last_check_time = Some(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64,
        );
        let _ = save_update_config(cfg.clone());
        log_updater(
            "info",
            "开始检查启动器更新",
            Some(json!({ "currentVersion": current_version })),
        );

        let client = crate::http_client::client_builder_with_timeout(
            std::time::Duration::from_secs(UPDATE_CHECK_TIMEOUT_SECS),
        )
            .redirect(redirect_policy())
            .build()
            .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

        let local_identity = local_identity_for_update().map_err(|error| {
            cfg.status = UpdateStatus::Error(error.clone());
            let _ = save_update_config(cfg.clone());
            error
        })?;

        let bundle = match tokio::time::timeout(
            std::time::Duration::from_secs(UPDATE_CHECK_TIMEOUT_SECS),
            fetch_latest_release_bundle(&client),
        )
        .await
        {
            Ok(Ok(bundle)) => bundle,
            Ok(Err(error)) => {
                cfg.status = UpdateStatus::Error(error.clone());
                let _ = save_update_config(cfg.clone());
                log_updater("error", "拉取 Release 失败", Some(json!({ "error": error })));
                return Err(error);
            }
            Err(_) => {
                let error = update_check_timeout_message();
                cfg.status = UpdateStatus::Error(error.clone());
                let _ = save_update_config(cfg.clone());
                log_updater(
                    "error",
                    "检查更新超时",
                    Some(json!({
                        "timeoutSecs": UPDATE_CHECK_TIMEOUT_SECS,
                        "error": error,
                    })),
                );
                return Err(error);
            }
        };

        let update_available = credentials_differ(&local_identity, &bundle.identity).map_err(
            |error| {
                cfg.status = UpdateStatus::Error(error.clone());
                let _ = save_update_config(cfg.clone());
                error
            },
        )?;

        let changelog = (!bundle.changelog.trim().is_empty()).then(|| bundle.changelog.clone());
        let target_version = bundle.identity.version.clone();
        let current_os = get_current_os();

        if !update_available {
            cfg.target_version = Some(target_version.clone());
            cfg.changelog = changelog.clone();
            cfg.target_os = None;
            cfg.download_url = None;
            cfg.file_size = None;
            cfg.expected_sha256 = None;
            cfg.status = UpdateStatus::Idle;
            let _ = save_update_config(cfg);
            log_updater(
                "info",
                "启动器已是最新版本",
                Some(json!({ "targetVersion": target_version })),
            );
            return Ok(UpdateCheckResult {
                needs_check: true,
                update_available: false,
                package_ready: false,
                current_version: current_version.to_string(),
                target_version: Some(target_version),
                message: "当前已是最新版本".to_string(),
                changelog,
            });
        }

        // identity 与本地不同 → 检查 OpenX/update 是否已有匹配安装包
        cfg.target_version = Some(target_version.clone());
        cfg.changelog = changelog.clone();
        cfg.target_os = Some(current_os);
        cfg.download_url = Some(bundle.download_url.clone());
        cfg.file_size = bundle.file_size;
        cfg.expected_sha256 = Some(bundle.identity.sha256.clone());
        let package_ready = reconcile_local_update_package(&mut cfg);
        if package_ready {
            log_updater(
                "info",
                "新版本安装包已在 OpenX/update 中就绪，可直接安装",
                Some(json!({
                    "path": cfg.download_path,
                    "targetVersion": target_version,
                })),
            );
        } else {
            // 目录里若有哈希不匹配的旧包，删掉以免后续「无 sha1 跳过下载」
            remove_mismatched_update_files(cfg.expected_sha256.as_deref());
            cfg.status = UpdateStatus::Available;
            cfg.download_path = None;
            cfg.download_progress = None;
        }
        let _ = save_update_config(cfg);
        log_updater(
            "info",
            "发现启动器新版本",
            Some(json!({
                "currentVersion": current_version,
                "targetVersion": target_version,
                "fileSize": bundle.file_size,
                "packageReady": package_ready,
                "downloadUrl": bundle.download_url,
            })),
        );

        Ok(UpdateCheckResult {
            needs_check: true,
            update_available: true,
            package_ready,
            current_version: current_version.to_string(),
            target_version: Some(target_version),
            message: if package_ready {
                "发现新版本，本地安装包已就绪".to_string()
            } else {
                "发现新版本可用".to_string()
            },
            changelog,
        })
    }

    pub async fn download_update(
        &self,
        on_progress: Option<UpdateProgressCallback>,
    ) -> Result<DownloadResult, String> {
        if self.is_downloading.load(Ordering::SeqCst) {
            return Err("已有更新正在下载中".to_string());
        }

        let mut cfg_before = get_update_config();
        if reconcile_local_update_package(&mut cfg_before) {
            let path = cfg_before
                .download_path
                .clone()
                .unwrap_or_default();
            let size = if path.is_empty() {
                0
            } else {
                fs::metadata(&path).map(|m| m.len()).unwrap_or(0)
            };
            let _ = save_update_config(cfg_before);
            if let Some(cb) = on_progress.as_ref() {
                cb(100.0);
            }
            return Ok(DownloadResult {
                success: true,
                path,
                size,
            });
        }

        let download_url = match &cfg_before.download_url {
            Some(url) => url.clone(),
            None => return Err("没有可下载的更新".to_string()),
        };
        let target_version = cfg_before.target_version.clone();
        let expected_file_size = cfg_before.file_size;

        // 进入下载前再次核对 URL 白名单，防止配置被篡改（此时还没置 is_downloading=true）
        if !is_trusted_release_asset_url(&download_url) {
            return Err(format!(
                "拒绝下载：URL 不在受信任域名单中: {}",
                download_url
            ));
        }

        // ========= 从这里开始所有提前退出都必须保证 is_downloading 被重置 =========
        // 使用 RAII guard 处理 finally 式清理；active=true 的异常 drop 会：
        //   1) 把 is_downloading=false（无论何种路径一定发生）
        //   2) 如果状态仍是 Downloading → 写成 Error(...)，避免 UI 卡住
        //   3) 如果已 set_cleanup_path → 删除部分下载文件
        let mut guard = DownloadGuard::new(Arc::clone(&self.is_downloading));

        self.cancel_flag.store(false, Ordering::SeqCst);

        let mut cfg = cfg_before;
        cfg.status = UpdateStatus::Downloading;
        cfg.download_progress = Some(0.0);
        let _ = save_update_config(cfg.clone());

        let download_dir = update_download_dir();
        fs::create_dir_all(&download_dir).map_err(|e| format!("创建下载目录失败: {}", e))?;

        let target_filename = filename_from_download_url(&download_url)?;
        let download_path = download_dir.join(&target_filename);
        if target_filename.contains("..")
            || target_filename.contains('/')
            || target_filename.contains('\\')
            || target_filename.is_empty()
        {
            let msg = format!("非法的更新文件名: {}", target_filename);
            guard.active = false;
            drop(guard);
            let mut cfg = get_update_config();
            cfg.status = UpdateStatus::Error(msg.clone());
            cfg.download_progress = None;
            let _ = save_update_config(cfg);
            return Err(msg);
        }

        let temp_path = downloading_temp_path(&download_path);
        guard.set_cleanup_paths([download_path.clone(), temp_path]);

        log_updater(
            "info",
            "开始下载启动器更新包",
            Some(json!({
                "targetVersion": target_version,
                "fileName": target_filename,
                "totalBytesHint": expected_file_size,
            })),
        );

        let (progress_tx, mut progress_rx) = tokio::sync::mpsc::channel::<(u64, u64)>(256);
        let on_progress_fwd = on_progress.clone();
        let size_hint = expected_file_size;
        let progress_forward = tokio::spawn(async move {
            let mut writer = DownloadProgressWriter::new();
            writer.report(0.0, on_progress_fwd.as_ref());
            while let Some((downloaded, total)) = progress_rx.recv().await {
                let pct = if total > 0 {
                    (downloaded as f64 / total as f64) * 100.0
                } else if let Some(hint) = size_hint.filter(|n| *n > 0) {
                    (downloaded as f64 / hint as f64) * 100.0
                } else {
                    0.0
                };
                writer.report(pct, on_progress_fwd.as_ref());
            }
        });

        let outcome = download_url_to_path(
            &download_url,
            &download_path,
            Some(self.cancel_flag.clone()),
            Some(progress_tx),
        )
        .await;
        let _ = progress_forward.await;

        let SingleFileDownloadOutcome {
            path: final_path,
            size: downloaded,
            ..
        } = match outcome {
            Ok(v) => v,
            Err(err) if error_is_cancelled(&err) || self.cancel_flag.load(Ordering::SeqCst) => {
                guard.cleanup_now();
                guard.manual_reset();
                guard.active = false;
                let mut cfg = get_update_config();
                cfg.status = UpdateStatus::Idle;
                cfg.download_progress = None;
                let _ = save_update_config(cfg);
                return Err("下载已取消".to_string());
            }
            Err(err) => {
                let msg = format!("下载更新失败: {}", err);
                let mut cfg = get_update_config();
                cfg.status = UpdateStatus::Error(msg.clone());
                cfg.download_progress = None;
                let _ = save_update_config(cfg);
                guard.cleanup_now();
                guard.active = false;
                drop(guard);
                return Err(msg);
            }
        };

        guard.manual_reset();

        if let Some(expected) = cfg.expected_sha256.as_ref() {
            if !is_valid_sha256_hex(expected) {
                let msg = format!("更新配置中的期望哈希无效，拒绝安装: {}", expected);
                let _ = fs::remove_file(&final_path);
                guard.active = false;
                drop(guard);
                let mut cfg = get_update_config();
                cfg.status = UpdateStatus::Error(msg.clone());
                cfg.download_progress = None;
                let _ = save_update_config(cfg);
                return Err(msg);
            }

            let actual = Self::sha256_of_file(&final_path).map_err(|e| {
                let msg = format!("无法计算文件哈希: {}", e);
                let mut cfg = get_update_config();
                cfg.status = UpdateStatus::Error(msg.clone());
                let _ = save_update_config(cfg);
                msg
            })?;

            if &actual != expected {
                let msg = format!(
                    "更新文件 SHA-256 校验失败！\n期望: {}\n实际: {}",
                    expected, actual
                );
                let _ = fs::remove_file(&final_path);
                guard.active = false;
                drop(guard);
                let mut cfg = get_update_config();
                cfg.status = UpdateStatus::Error(msg.clone());
                cfg.download_progress = None;
                let _ = save_update_config(cfg);
                return Err(msg);
            }

            log_updater(
                "info",
                "更新包 SHA-256 校验通过",
                Some(json!({ "path": final_path.to_string_lossy() })),
            );
        }

        let mut cfg = get_update_config();
        cfg.status = UpdateStatus::Downloaded;
        cfg.download_progress = Some(100.0);
        cfg.download_path = Some(final_path.to_string_lossy().to_string());
        let _ = save_update_config(cfg);
        if let Some(cb) = on_progress.as_ref() {
            cb(100.0);
        }
        log_updater(
            "info",
            "启动器更新包下载完成",
            Some(json!({
                "bytes": downloaded,
                "path": final_path.to_string_lossy(),
            })),
        );

        guard.defuse();

        Ok(DownloadResult {
            success: true,
            path: final_path.to_string_lossy().to_string(),
            size: downloaded,
        })
    }

    pub async fn install_update(&self) -> Result<InstallResult, String> {
        let cfg = get_update_config();
        log_updater(
            "info",
            "开始安装启动器更新",
            Some(json!({
                "targetVersion": cfg.target_version,
                "downloadPath": cfg.download_path,
            })),
        );
        let download_path_str = match &cfg.download_path {
            Some(path) => path.clone(),
            None => return Err("No downloaded update available".to_string()),
        };

        let download_path = PathBuf::from(&download_path_str);
        if !download_path.exists() {
            return Err("Update file does not exist".to_string());
        }

        // 安装前最后一道防线：如果 expected_sha256 有值就必须校验通过（fail closed）
        // 即便 download_update 已校验过，这里再检查一次可防止下载后到安装前的 TOCTOU 修改
        if let Some(expected) = cfg.expected_sha256.as_ref() {
            if !is_valid_sha256_hex(expected) {
                return Err(format!("期望哈希无效，拒绝安装: {}", expected));
            }
            match Self::sha256_of_file(&download_path) {
                Ok(ref actual) if actual == expected => {
                    log_updater("info", "安装前 SHA-256 复检通过", None);
                }
                Ok(actual) => {
                    return Err(format!(
                        "安装前 SHA-256 校验失败！\n期望: {}\n实际: {}",
                        expected, actual
                    ));
                }
                Err(e) => {
                    return Err(format!("安装前无法读取更新文件: {}", e));
                }
            }
        }

        #[cfg(target_os = "windows")]
        {
            super::windows_replace::launch_windows_replace(&download_path)?;
        }

        #[cfg(target_os = "macos")]
        {
            super::macos_replace::launch_macos_replace(&download_path)?;
        }

        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            return Err("Launcher self-update is only supported on Windows and macOS".to_string());
        }

        Ok(InstallResult {
            success: true,
            message: "Installer started".to_string(),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateCheckResult {
    pub needs_check: bool,
    pub update_available: bool,
    /// 本地 `OpenX/update` 中已有与最新 identity 哈希一致的安装包，可直接安装。
    #[serde(default)]
    pub package_ready: bool,
    pub current_version: String,
    pub target_version: Option<String>,
    pub message: String,
    pub changelog: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadResult {
    pub success: bool,
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallResult {
    pub success: bool,
    pub message: String,
}

fn hex_encode_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}
