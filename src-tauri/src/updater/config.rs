use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const CONFIG_FILE_NAME: &str = "launcher.json";
const MIN_CHECK_INTERVAL_SECONDS: i64 = 5;

pub const GITHUB_UPDATE_ENDPOINT: &str =
    "https://api.github.com/repos/CubicEi/OpenXLaucher/releases";

/// 允许的更新下载域名白名单。release URL 或重定向目标必须落在这些域名上。
pub const TRUSTED_DOWNLOAD_HOSTS: &[&str] = &["github.com", "githubusercontent.com"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateConfig {
    #[serde(default)]
    pub last_check_time: Option<i64>,
    #[serde(default)]
    pub current_version: String,
    #[serde(default)]
    pub target_version: Option<String>,
    #[serde(default)]
    pub changelog: Option<String>,
    #[serde(default)]
    pub target_os: Option<String>,
    #[serde(default)]
    pub download_url: Option<String>,
    #[serde(default)]
    pub file_size: Option<u64>,
    /// 期望的 SHA-256 校验和（小写 16 进制，64 字符）。来自 `OpenXLauncher.identity.json`。
    /// 如果为 Some，则下载后 **必须** 校验匹配（fail closed）。
    #[serde(default)]
    pub expected_sha256: Option<String>,
    #[serde(default)]
    pub download_path: Option<String>,
    #[serde(default)]
    pub download_progress: Option<f64>,
    #[serde(default)]
    pub status: UpdateStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum UpdateStatus {
    #[serde(rename = "idle")]
    Idle,
    #[serde(rename = "checking")]
    Checking,
    #[serde(rename = "available")]
    Available,
    #[serde(rename = "downloading")]
    Downloading,
    #[serde(rename = "downloaded")]
    Downloaded,
    #[serde(rename = "error")]
    Error(String),
}

impl Default for UpdateStatus {
    fn default() -> Self {
        UpdateStatus::Idle
    }
}

impl Default for UpdateConfig {
    fn default() -> Self {
        Self {
            last_check_time: None,
            current_version: crate::app_version::VERSION.to_string(),
            target_version: None,
            changelog: None,
            target_os: None,
            download_url: None,
            file_size: None,
            expected_sha256: None,
            download_path: None,
            download_progress: None,
            status: UpdateStatus::Idle,
        }
    }
}

/// 严格校验 64 字符小写十六进制 SHA-256 字符串。
pub fn is_valid_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
}

/// 校验 URL 主机名是否落在受信任白名单中。
pub fn is_trusted_download_url(url: &str) -> bool {
    let parsed = match url::Url::parse(url) {
        Ok(u) => u,
        Err(_) => return false,
    };
    if parsed.scheme() != "https" {
        return false;
    }
    let Some(host) = parsed.host_str() else {
        return false;
    };
    TRUSTED_DOWNLOAD_HOSTS
        .iter()
        .any(|allowed| host == *allowed || host.ends_with(&format!(".{}", allowed)))
}

/// 校验 Release 元数据给出的初始附件 URL。初始 URL 必须来自指定仓库或指定存储桶；
/// 下载过程中的 GitHub CDN 重定向由 `is_trusted_download_url` 单独校验。
pub fn is_trusted_release_asset_url(url: &str) -> bool {
    let parsed = match url::Url::parse(url) {
        Ok(url) if url.scheme() == "https" => url,
        _ => return false,
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };

    host == "github.com"
        && parsed
            .path()
            .starts_with("/CubicEi/OpenXLaucher/releases/download/")
}

pub fn config_dir() -> String {
    #[cfg(target_os = "macos")]
    let dir = {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        format!("{}/Library/Application Support/OpenXLauncher/config", home)
    };

    #[cfg(target_os = "linux")]
    let dir = crate::app_paths::linux_config_dir()
        .to_string_lossy()
        .to_string();

    #[cfg(target_os = "windows")]
    let dir = {
        crate::app_paths::ensure_portable_dirs();
        crate::app_paths::portable_config_dir()
            .to_string_lossy()
            .into_owned()
    };

    #[cfg(all(not(target_os = "macos"), not(target_os = "linux"), not(target_os = "windows")))]
    let dir = "./OpenX/config".to_string();

    let _ = fs::create_dir_all(&dir);
    dir
}

fn launcher_config_path() -> PathBuf {
    PathBuf::from(config_dir()).join(CONFIG_FILE_NAME)
}

/// 与 `launcher_config_path` 相同；供 identity 等模块读写 `launcher.json` 非 update 字段。
pub fn launcher_config_path_merge() -> PathBuf {
    launcher_config_path()
}

pub fn github_repo_slug() -> &'static str {
    "CubicEi/OpenXLaucher"
}

pub fn github_release_download_url(tag: &str, file_name: &str) -> String {
    format!(
        "https://github.com/{}/releases/download/{}/{}",
        github_repo_slug(),
        tag,
        file_name
    )
}

fn get_current_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| std::time::Duration::from_secs(0))
        .as_secs() as i64
}

pub fn get_update_endpoint() -> &'static str {
    GITHUB_UPDATE_ENDPOINT
}

/// 更新包与替换脚本使用的系统临时目录（如 `%TEMP%\OpenXLauncher`）。
pub fn update_temp_root() -> PathBuf {
    std::env::temp_dir().join("OpenXLauncher")
}

pub fn update_download_dir() -> PathBuf {
    update_temp_root().join("updates")
}

/// 读取 `launcher.json` 中的界面语言（用于更新脚本弹窗文案）。
pub fn read_ui_language() -> String {
    let path = launcher_config_path();
    if !path.exists() {
        return "zh-CN".to_string();
    }
    let text = fs::read_to_string(&path).unwrap_or_default();
    let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    value
        .get("general")
        .and_then(|g| g.get("language"))
        .and_then(|l| l.as_str())
        .unwrap_or("zh-CN")
        .to_string()
}

pub fn get_update_config() -> UpdateConfig {
    let path = launcher_config_path();
    if path.exists() {
        match fs::read_to_string(&path) {
            Ok(text) => {
                if let Ok(mut value) = serde_json::from_str::<Value>(&text) {
                    if let Some(update) = value.get_mut("update") {
                        if let Ok(cfg) = serde_json::from_value::<UpdateConfig>(update.clone()) {
                            return cfg;
                        }
                    }
                }
                UpdateConfig::default()
            }
            Err(_) => UpdateConfig::default(),
        }
    } else {
        UpdateConfig::default()
    }
}

pub fn save_update_config(update_cfg: UpdateConfig) -> Result<(), String> {
    let path = launcher_config_path();
    let mut value: Value = if path.exists() {
        match fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str::<Value>(&text)
                .unwrap_or_else(|_| Value::Object(serde_json::Map::new())),
            Err(_) => Value::Object(serde_json::Map::new()),
        }
    } else {
        Value::Object(serde_json::Map::new())
    };

    value["update"] = serde_json::to_value(&update_cfg).map_err(|e| e.to_string())?;

    let text = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| e.to_string())
}

pub fn should_check_update() -> bool {
    let cfg = get_update_config();
    match cfg.last_check_time {
        Some(last_time) => {
            let now = get_current_timestamp();
            has_check_interval_elapsed(last_time, now)
        }
        None => true,
    }
}

fn has_check_interval_elapsed(last_check: i64, now: i64) -> bool {
    now.saturating_sub(last_check) >= MIN_CHECK_INTERVAL_SECONDS
}

pub fn get_current_os() -> String {
    #[cfg(target_os = "windows")]
    {
        if cfg!(target_arch = "x86_64") {
            return "windows-x86_64".to_string();
        } else if cfg!(target_arch = "aarch64") {
            return "windows-aarch64".to_string();
        }
        return "windows".to_string();
    }

    #[cfg(target_os = "macos")]
    {
        if cfg!(target_arch = "aarch64") {
            return "macos-aarch64".to_string();
        }
        return "macos-x86_64".to_string();
    }

    #[cfg(target_os = "linux")]
    {
        if cfg!(target_arch = "x86_64") {
            return "linux-x86_64".to_string();
        } else if cfg!(target_arch = "aarch64") {
            return "linux-aarch64".to_string();
        }
        return "linux".to_string();
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        return "unknown".to_string();
    }
}
