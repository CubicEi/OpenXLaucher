use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::Path;

use super::config::{is_valid_sha256_hex, launcher_config_path_merge};

pub const IDENTITY_ASSET_NAME: &str = "OpenXLauncher.identity.json";
pub const WINDOWS_PORTABLE_EXE: &str = "OpenXLauncher.exe";
pub const APP_BUNDLE_NAME: &str = "OpenXLauncher.app";
/// Bundled in `.app/Contents/Resources/` on each macOS release build.
pub const MACOS_BUNDLE_BUILD_IDENTITY_FILE: &str = "macos-build-identity.uuid";

/// 所有平台凭据统一放在 `OpenXLauncher.identity.json`（与 Windows 便携版共用同一附件）。
pub fn identity_asset_name_for_os(_os: &str) -> String {
    IDENTITY_ASSET_NAME.to_string()
}

/// 更新包附件名：macOS 为带版本的 DMG；Windows 便携版仍为固定 `OpenXLauncher.exe`。
pub fn update_package_asset_name_for_os(os: &str, version: &str) -> String {
    match os {
        "macos-aarch64" => format!("OpenXLauncher_{}_macos-aarch64.dmg", version),
        "macos-x86_64" => format!("OpenXLauncher_{}_macos-x86_64.dmg", version),
        _ => WINDOWS_PORTABLE_EXE.to_string(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReleaseIdentity {
    pub schema: u32,
    pub product: String,
    pub version: String,
    pub sha256: String,
    pub build_uuid: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
struct PlatformCredential {
    sha256: String,
    build_uuid: String,
    #[serde(default)]
    package: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
struct ReleaseManifest {
    schema: u32,
    product: String,
    version: String,
    platforms: HashMap<String, PlatformCredential>,
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

fn validate_platform_credential(cred: &PlatformCredential) -> Result<(), String> {
    if !is_valid_sha256_hex(&cred.sha256) {
        return Err("identity.platforms.*.sha256 无效".to_string());
    }
    if cred.build_uuid.trim().is_empty() {
        return Err("identity.platforms.*.build_uuid 为空".to_string());
    }
    Ok(())
}

/// 从统一的 `OpenXLauncher.identity.json` 中取出当前 OS 的凭据。
pub fn parse_release_identity_for_os(text: &str, os: &str) -> Result<ReleaseIdentity, String> {
    let manifest: ReleaseManifest =
        serde_json::from_str(text).map_err(|e| format!("解析 identity 失败: {}", e))?;
    if manifest.schema != 2 {
        return Err(format!("不支持的 identity schema: {}", manifest.schema));
    }
    if manifest.product != "OpenXLauncher" {
        return Err(format!("identity product 不匹配: {}", manifest.product));
    }
    let cred = manifest
        .platforms
        .get(os)
        .ok_or_else(|| format!("identity 缺少平台 {}", os))?;
    validate_platform_credential(cred)?;
    Ok(ReleaseIdentity {
        schema: manifest.schema,
        product: manifest.product,
        version: manifest.version,
        sha256: cred.sha256.clone(),
        build_uuid: cred.build_uuid.clone(),
    })
}

pub fn package_name_from_manifest(text: &str, os: &str) -> Result<String, String> {
    let manifest: ReleaseManifest =
        serde_json::from_str(text).map_err(|e| format!("解析 identity 失败: {}", e))?;
    let cred = manifest
        .platforms
        .get(os)
        .ok_or_else(|| format!("identity 缺少平台 {}", os))?;
    if let Some(name) = cred.package.as_ref().filter(|s| !s.trim().is_empty()) {
        return Ok(name.clone());
    }
    Ok(update_package_asset_name_for_os(os, &manifest.version))
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

pub fn parse_macos_build_uuid(text: &str) -> Result<String, String> {
    let trimmed = text.trim();
    uuid::Uuid::parse_str(trimmed).map_err(|_| "构建标识格式无效".to_string())?;
    Ok(trimmed.to_string())
}

#[cfg(target_os = "macos")]
fn local_macos_build_uuid() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let bundle = super::macos_replace::resolve_app_bundle_from_exe(&exe)?;
    let path = bundle
        .join("Contents")
        .join("Resources")
        .join(MACOS_BUNDLE_BUILD_IDENTITY_FILE);
    let text = fs::read_to_string(&path).map_err(|e| {
        format!(
            "读取 {} 失败: {}",
            MACOS_BUNDLE_BUILD_IDENTITY_FILE, e
        )
    })?;
    parse_macos_build_uuid(&text)
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

    #[cfg(target_os = "macos")]
    {
        return Ok(LocalIdentity {
            self_sha256: None,
            build_uuid: Some(local_macos_build_uuid()?),
        });
    }

    #[cfg(not(target_os = "macos"))]
    {
        let uuid = option_env!("BUILD_UUID")
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        Ok(LocalIdentity {
            self_sha256: None,
            build_uuid: uuid,
        })
    }
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
        return Err("安装版缺少 build_uuid（macOS 需 Resources 内的构建标识文件）".to_string());
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

#[cfg(test)]
mod tests {
    use super::{parse_macos_build_uuid, parse_release_identity_for_os};

    #[test]
    fn parse_release_manifest_selects_platform() {
        let text = r#"{
          "schema": 2,
          "product": "OpenXLauncher",
          "version": "1.0.0-pre.4",
          "platforms": {
            "windows-x86_64": {
              "package": "OpenXLauncher.exe",
              "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
              "build_uuid": "84e1fcbd-d0f2-4829-bb6a-17d25a46fa0a"
            }
          }
        }"#;
        let id = parse_release_identity_for_os(text, "windows-x86_64").unwrap();
        assert_eq!(id.version, "1.0.0-pre.4");
        assert_eq!(id.sha256.len(), 64);
    }

    #[test]
    fn parse_macos_build_uuid_accepts_valid_v4() {
        let id = "84e1fcbd-d0f2-4829-bb6a-17d25a46fa0a";
        assert_eq!(parse_macos_build_uuid(id).unwrap(), id);
        assert_eq!(parse_macos_build_uuid(&format!("  {id}\n")).unwrap(), id);
    }

    #[test]
    fn parse_macos_build_uuid_rejects_garbage() {
        assert!(parse_macos_build_uuid("not-a-uuid").is_err());
    }
}
