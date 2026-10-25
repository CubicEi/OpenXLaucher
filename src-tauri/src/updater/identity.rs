use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::Path;

use super::config::{is_valid_sha256_hex, launcher_config_path_merge};

pub const IDENTITY_ASSET_NAME: &str = "OpenXLauncher.identity.json";
pub const WINDOWS_PORTABLE_EXE: &str = "OpenXLauncher.exe";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReleaseIdentity {
    pub schema: u32,
    pub product: String,
    pub version: String,
    pub sha256: String,
    pub build_uuid: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct StoredBuildIdentity {
    #[serde(default)]
    pub self_sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LocalIdentity {
    pub self_sha256: Option<String>,
    pub build_uuid: Option<String>,
}

pub fn is_portable_build() -> bool {
    cfg!(openx_portable_build)
}

pub fn parse_release_identity_json(text: &str) -> Result<ReleaseIdentity, String> {
    let raw: ReleaseIdentity = serde_json::from_str(text).map_err(|e| format!("解析 identity 失败: {}", e))?;
    if raw.schema != 1 {
        return Err(format!("不支持的 identity schema: {}", raw.schema));
    }
    if raw.product != "OpenXLauncher" {
        return Err(format!("identity product 不匹配: {}", raw.product));
    }
    if !is_valid_sha256_hex(&raw.sha256) {
        return Err("identity.sha256 无效".to_string());
    }
    if raw.build_uuid.trim().is_empty() {
        return Err("identity.build_uuid 为空".to_string());
    }
    Ok(raw)
}

pub fn load_stored_build_identity() -> StoredBuildIdentity {
    let value = read_launcher_json_value();
    value
        .get("build_identity")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default()
}

pub fn save_stored_build_identity(stored: &StoredBuildIdentity) -> Result<(), String> {
    let mut root = read_launcher_json_value();
    root["build_identity"] = serde_json::to_value(stored).map_err(|e| e.to_string())?;
    write_launcher_json_value(&root)
}

pub fn sha256_file_hex(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| format!("打开文件失败: {}", e))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("读取文件失败: {}", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex_lower(&hasher.finalize()))
}

/// 便携版：首次启动（或 exe 已变更）时计算自身 SHA-256 并写入 `launcher.json`。
pub fn ensure_portable_self_hash() -> Result<(), String> {
    if !is_portable_build() {
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        return Ok(());
    }
    #[cfg(windows)]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let hash = sha256_file_hex(&exe)?;
        let mut stored = load_stored_build_identity();
        if stored.self_sha256.as_deref() != Some(hash.as_str()) {
            stored.self_sha256 = Some(hash);
            save_stored_build_identity(&stored)?;
        }
        Ok(())
    }
}

pub fn local_identity_for_update() -> Result<LocalIdentity, String> {
    if is_portable_build() {
        if load_stored_build_identity().self_sha256.is_none() {
            let _ = ensure_portable_self_hash();
        }
        let stored = load_stored_build_identity();
        return Ok(LocalIdentity {
            self_sha256: stored.self_sha256,
            build_uuid: None,
        });
    }
    let uuid = option_env!("BUILD_UUID")
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    Ok(LocalIdentity {
        self_sha256: None,
        build_uuid: uuid,
    })
}

/// 远程凭据与本地凭据不一致 → 有可用更新。
pub fn credentials_differ(local: &LocalIdentity, remote: &ReleaseIdentity) -> Result<bool, String> {
    if is_portable_build() {
        let Some(local_hash) = local.self_sha256.as_ref() else {
            return Err("本地尚未记录便携版哈希，请重启启动器后重试".to_string());
        };
        return Ok(remote.sha256 != *local_hash);
    }
    let Some(local_uuid) = local.build_uuid.as_ref() else {
        return Err("安装版缺少编译期 build_uuid".to_string());
    };
    Ok(remote.build_uuid != *local_uuid)
}

fn read_launcher_json_value() -> Value {
    let path = launcher_config_path_merge();
    if !path.exists() {
        return Value::Object(serde_json::Map::new());
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| Value::Object(serde_json::Map::new()))
}

fn write_launcher_json_value(value: &Value) -> Result<(), String> {
    let path = launcher_config_path_merge();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| e.to_string())
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}
