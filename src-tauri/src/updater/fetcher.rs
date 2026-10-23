use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use super::config::{
    get_current_os, get_update_config, is_trusted_release_asset_url,
    is_valid_sha256_hex, save_update_config, should_check_update, update_download_dir, UpdateStatus,
};
use super::github_release::{fetch_latest_release_bundle, redirect_policy};
use super::identity::{credentials_differ, local_identity_for_update};

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
    /// 已计算好的下载目标路径，异常退出时用于清理部分下载文件。
    cleanup_path: Option<PathBuf>,
}

impl DownloadGuard {
    fn new(flag: Arc<AtomicBool>) -> Self {
        flag.store(true, Ordering::SeqCst);
        Self {
            flag,
            active: true,
            cleanup_path: None,
        }
    }

    /// 设置下载路径（在文件名合法检查通过后调用），guard 异常 drop 时会尝试删除它。
    fn set_cleanup_path(&mut self, p: PathBuf) {
        self.cleanup_path = Some(p);
    }

    /// 成功结束时调用：取消 guard 的副作用。
    fn defuse(mut self) {
        self.active = false;
        self.cleanup_path = None;
    }

    /// 调用方已经自己处理了状态，只想立刻重置标志/取消清理路径。
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
        // active=true 代表函数没有走成功路径，fallback 地把状态写成 Error（只在仍为 Downloading 时）
        let mut cfg = get_update_config();
        if matches!(cfg.status, UpdateStatus::Downloading) {
            cfg.status = UpdateStatus::Error("下载过程中出现异常，已中止".to_string());
            cfg.download_progress = None;
            let _ = save_update_config(cfg);
        }
        if let Some(p) = self.cleanup_path.take() {
            let _ = fs::remove_file(&p);
        }
    }
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
    fn sha256_of_file(path: &PathBuf) -> Result<String, String> {
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

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .redirect(redirect_policy())
            .build()
            .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

        let local_identity = local_identity_for_update().map_err(|error| {
            cfg.status = UpdateStatus::Error(error.clone());
            let _ = save_update_config(cfg.clone());
            error
        })?;

        let bundle = fetch_latest_release_bundle(&client)
            .await
            .map_err(|error| {
                cfg.status = UpdateStatus::Error(error.clone());
                let _ = save_update_config(cfg.clone());
                error
            })?;

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
            return Ok(UpdateCheckResult {
                needs_check: true,
                update_available: false,
                current_version: current_version.to_string(),
                target_version: Some(target_version),
                message: "当前已是最新版本".to_string(),
                changelog,
            });
        }

        cfg.target_version = Some(target_version.clone());
        cfg.changelog = changelog.clone();
        cfg.target_os = Some(current_os);
        cfg.download_url = Some(bundle.windows_exe_url.clone());
        cfg.file_size = bundle.windows_exe_size;
        cfg.expected_sha256 = Some(bundle.identity.sha256.clone());
        cfg.status = UpdateStatus::Available;
        let _ = save_update_config(cfg);

        Ok(UpdateCheckResult {
            needs_check: true,
            update_available: true,
            current_version: current_version.to_string(),
            target_version: Some(target_version),
            message: "发现新版本可用".to_string(),
            changelog,
        })
    }

    pub async fn download_update(&self) -> Result<DownloadResult, String> {
        if self.is_downloading.load(Ordering::SeqCst) {
            return Err("已有更新正在下载中".to_string());
        }

        let cfg_before = get_update_config();
        let download_url = match &cfg_before.download_url {
            Some(url) => url.clone(),
            None => return Err("没有可下载的更新".to_string()),
        };

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

        // ------ 下面的所有 ? 都会触发 guard drop 做清理 ------

        let download_dir = update_download_dir();
        fs::create_dir_all(&download_dir).map_err(|e| format!("创建下载目录失败: {}", e))?;

        let target_filename = filename_from_download_url(&download_url)?;
        let download_path = download_dir.join(&target_filename);

        // 拒绝跨目录文件名：下载文件名里只能有正常字符，防止路径穿越
        if target_filename.contains("..")
            || target_filename.contains('/')
            || target_filename.contains('\\')
            || target_filename.is_empty()
        {
            let msg = format!("非法的更新文件名: {}", target_filename);
            guard.active = false; // 自己下面会写 Error 状态，避免 on_error 覆盖
            drop(guard);
            let mut cfg = get_update_config();
            cfg.status = UpdateStatus::Error(msg.clone());
            cfg.download_progress = None;
            let _ = save_update_config(cfg);
            return Err(msg);
        }

        // 告诉 guard 如果异常退出就删除这个半下载文件
        guard.set_cleanup_path(download_path.clone());

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(600))
            .redirect(redirect_policy())
            .build()
            .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

        let response = client
            .get(&download_url)
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
            .header("Accept", "*/*")
            .send()
            .await
            .map_err(|e| {
                let mut cfg = get_update_config();
                let msg = format!("下载更新失败: {}", e);
                cfg.status = UpdateStatus::Error(msg.clone());
                cfg.download_progress = None;
                let _ = save_update_config(cfg);
                msg
            })?;

        if !response.status().is_success() {
            let msg = format!("下载失败: HTTP {}", response.status());
            guard.active = false;
            drop(guard);
            let mut cfg = get_update_config();
            cfg.status = UpdateStatus::Error(msg.clone());
            cfg.download_progress = None;
            let _ = fs::remove_file(&download_path);
            let _ = save_update_config(cfg);
            return Err(msg);
        }

        let total_size = response.content_length();

        let mut file =
            fs::File::create(&download_path).map_err(|e| format!("创建临时文件失败: {}", e))?;

        let mut downloaded: u64 = 0;
        let mut stream = response.bytes_stream();
        use futures::StreamExt;

        while let Some(chunk) = stream.next().await {
            if self.cancel_flag.load(Ordering::SeqCst) {
                guard.manual_reset(); // 立刻解锁，避免 UI 还要等下面 drop
                guard.active = false;
                let _ = fs::remove_file(&download_path);
                let mut cfg = get_update_config();
                cfg.status = UpdateStatus::Idle;
                cfg.download_progress = None;
                let _ = save_update_config(cfg);
                return Err("下载已取消".to_string());
            }

            let chunk = chunk.map_err(|e| format!("下载数据错误: {}", e))?;
            file.write_all(&chunk)
                .map_err(|e| format!("写入文件失败: {}", e))?;

            downloaded += chunk.len() as u64;

            if let Some(total) = total_size {
                let progress = (downloaded as f64 / total as f64) * 100.0;
                let mut cfg = get_update_config();
                cfg.download_progress = Some(progress);
                let _ = save_update_config(cfg);
            }
        }

        drop(file);
        guard.manual_reset(); // is_downloading=false 立即生效（后续不涉及并发下载了）

        // ==== 完整性校验（fail closed） ====
        if let Some(expected) = cfg.expected_sha256.as_ref() {
            if !is_valid_sha256_hex(expected) {
                let msg = format!("更新配置中的期望哈希无效，拒绝安装: {}", expected);
                guard.active = false;
                drop(guard);
                let mut cfg = get_update_config();
                cfg.status = UpdateStatus::Error(msg.clone());
                cfg.download_progress = None;
                let _ = fs::remove_file(&download_path);
                let _ = save_update_config(cfg);
                return Err(msg);
            }

            let actual = Self::sha256_of_file(&download_path).map_err(|e| {
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
                guard.active = false;
                drop(guard);
                let mut cfg = get_update_config();
                cfg.status = UpdateStatus::Error(msg.clone());
                cfg.download_progress = None;
                let _ = fs::remove_file(&download_path);
                let _ = save_update_config(cfg);
                return Err(msg);
            }

            eprintln!(
                "[更新器] SHA-256 校验通过: {} (期望={}, 实际={})",
                download_path.display(),
                expected,
                actual
            );
        }

        let mut cfg = get_update_config();
        cfg.status = UpdateStatus::Downloaded;
        cfg.download_progress = Some(100.0);
        cfg.download_path = Some(download_path.to_string_lossy().to_string());
        let _ = save_update_config(cfg);

        // ========== 所有步骤成功，取消 guard 的 on_error 副作用 ==========
        guard.defuse();

        Ok(DownloadResult {
            success: true,
            path: download_path.to_string_lossy().to_string(),
            size: downloaded,
        })
    }

    pub async fn install_update(&self) -> Result<InstallResult, String> {
        let cfg = get_update_config();
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
                    eprintln!("[更新器-安装前] 再次校验 SHA-256 通过: {}", expected);
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

        #[cfg(not(target_os = "windows"))]
        {
            return Err("Launcher self-update is only supported on Windows".to_string());
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

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::config::{github_release_download_url, TEST_FIXTURE_RELEASE_TAG};

    #[test]
    fn signed_download_url_produces_a_plain_filename() {
        let url = format!(
            "{}?sign=abc&t=123",
            github_release_download_url(TEST_FIXTURE_RELEASE_TAG, "OpenXLauncher_1.2.0_x64-setup.exe")
        );

        assert_eq!(
            filename_from_download_url(&url).as_deref(),
            Ok("OpenXLauncher_1.2.0_x64-setup.exe")
        );
    }
}
