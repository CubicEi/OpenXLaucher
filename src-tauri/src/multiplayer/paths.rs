use std::env;
use std::path::{Path, PathBuf};

use super::EASYTIER_BIN;

pub(super) const VERSION_FILE: &str = "easytier.version";
pub(super) const PEER_CONFIG_FILE: &str = "easytier.json";
/// 官方 public.easytier.top 已停运；默认使用社区公益节点（上海电信，可中转）。
pub(super) const DEFAULT_PEER: &str = "tcp://225284.xyz:11010";
/// 启动时额外附加的备用引导节点（DNS/线路失败时提高连通率）。
pub(super) const FALLBACK_PEERS: &[&str] = &[
    "tcp://et1.fuis.top:11010",
    "tcp://dreamlife.indevs.in:11010",
];

fn legacy_bridge_dir() -> Option<PathBuf> {
    let exe_dir = env::current_exe().ok()?.parent()?.to_path_buf();
    let openx = exe_dir.join("OpenX").join("bridge");
    if openx.join(EASYTIER_BIN).is_file() {
        return Some(openx);
    }
    Some(exe_dir.join("RTL").join("bridge"))
}

fn preferred_bridge_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        crate::app_paths::ensure_portable_dirs();
        return crate::app_paths::portable_bridge_dir();
    }

    #[cfg(target_os = "macos")]
    {
        return env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .map(|home| {
                home.join("Library")
                    .join("Application Support")
                    .join("OpenXLauncher")
                    .join("bridge")
            })
            .unwrap_or_else(|| env::temp_dir().join("OpenXLauncher").join("bridge"));
    }

    #[cfg(target_os = "linux")]
    {
        crate::app_paths::linux_data_dir().join("bridge")
    }
}

pub(super) fn bridge_dir() -> Result<PathBuf, String> {
    let preferred = preferred_bridge_dir();
    if preferred.join(EASYTIER_BIN).is_file() {
        return Ok(preferred);
    }

    if let Some(legacy) = legacy_bridge_dir() {
        if legacy.join(EASYTIER_BIN).is_file() {
            return Ok(legacy);
        }
    }
    Ok(preferred)
}

pub(super) fn ensure_bridge_dir() -> Result<PathBuf, String> {
    let dir = bridge_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 bridge 目录失败: {}", e))?;
    Ok(dir)
}

pub(super) fn tool_path() -> Result<PathBuf, String> {
    Ok(bridge_dir()?.join(EASYTIER_BIN))
}

pub(super) fn tool_dir() -> Result<PathBuf, String> {
    let path = tool_path()?;
    Ok(path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from(".")))
}

pub(super) fn version_file_path() -> Result<PathBuf, String> {
    Ok(bridge_dir()?.join(VERSION_FILE))
}

pub(super) fn peer_config_path() -> Result<PathBuf, String> {
    Ok(bridge_dir()?.join(PEER_CONFIG_FILE))
}

pub(super) fn read_installed_version() -> Option<String> {
    let path = version_file_path().ok()?;
    let text = std::fs::read_to_string(path).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub(super) fn write_installed_version(version: &str) -> Result<(), String> {
    let path = version_file_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建版本文件目录失败: {}", e))?;
    }
    std::fs::write(&path, version.trim().as_bytes())
        .map_err(|e| format!("写入版本文件失败: {}", e))
}

fn is_retired_official_peer(peer: &str) -> bool {
    let lower = peer.to_ascii_lowercase();
    lower.contains("public.easytier.top") || lower.contains("public.easytier.cn")
}

pub(super) fn read_peer_url() -> String {
    let Ok(path) = peer_config_path() else {
        return DEFAULT_PEER.to_string();
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return DEFAULT_PEER.to_string();
    };
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
        if let Some(peer) = value.get("peer").and_then(|v| v.as_str()) {
            let trimmed = peer.trim();
            if !trimmed.is_empty() && !is_retired_official_peer(trimmed) {
                return trimmed.to_string();
            }
            // 旧默认官方节点已停运：自动回落到社区节点并改写配置。
            if is_retired_official_peer(trimmed) {
                let _ = write_peer_url(DEFAULT_PEER);
            }
        }
    }
    DEFAULT_PEER.to_string()
}

pub(super) fn write_peer_url(peer: &str) -> Result<(), String> {
    let trimmed = peer.trim();
    if trimmed.is_empty() {
        return Err("节点地址不能为空".to_string());
    }
    let path = peer_config_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建节点配置目录失败: {}", e))?;
    }
    let payload = serde_json::json!({ "peer": trimmed });
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&payload).unwrap_or_else(|_| payload.to_string()),
    )
    .map_err(|e| format!("写入节点配置失败: {}", e))
}

pub(super) fn executable_path(path: &Path) -> Result<String, String> {
    if path.is_absolute() {
        return Ok(path.display().to_string());
    }

    Ok(env::current_dir()
        .map_err(|error| format!("无法获取当前目录: {}", error))?
        .join(path)
        .display()
        .to_string())
}

/// EasyTier 相关文件名（卸载时清理）。
pub(super) fn is_easytier_managed_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == EASYTIER_BIN.to_ascii_lowercase()
        || lower == VERSION_FILE
        || lower == PEER_CONFIG_FILE
        || lower.starts_with("easytier")
        || lower.ends_with(".dll")
        || lower.ends_with(".sys")
}
