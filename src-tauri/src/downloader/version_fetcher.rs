use crate::downloader::shared_utils::{
    fetch_json_from_urls, minecraft_version_manifest_urls,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

#[derive(Debug, Deserialize)]
struct VersionManifest {
    versions: Vec<VersionEntry>,
}
#[derive(Debug, Deserialize)]
struct VersionEntry {
    id: String,
    #[serde(rename = "type")]
    version_type: String,
    #[serde(rename = "releaseTime")]
    time: String,
}
#[derive(Debug, Serialize)]
pub struct VersionInfo {
    pub id: String,
    #[serde(rename = "releaseTime")]
    pub release_time: String,
}
#[tauri::command]
pub async fn classify_minecraft_versions() -> Result<[Vec<VersionInfo>; 4], String> {
    let manifest: VersionManifest = fetch_json_from_urls(&minecraft_version_manifest_urls())
        .await
        .map_err(|e| e.to_string())?;
    let mut releases = Vec::new();     
    let mut snapshots = Vec::new();    
    let mut april_fools = Vec::new();  
    let mut old_versions = Vec::new(); 
    
    for entry in manifest.versions {
        let info = VersionInfo {
            id: entry.id.clone(),
            release_time: entry.time.clone(),
        };
        
        if is_april_fools_version(&entry.id, &entry.time, &entry.version_type) {
            april_fools.push(info);
            continue;
        }
        
        // 检查旧版本
        if matches!(entry.version_type.as_str(), "old_alpha" | "old_beta") {
            old_versions.push(info);
            continue;
        }
        
        // 按照版本类型分类
        match entry.version_type.as_str() {
            "release" => releases.push(info),
            "snapshot" => snapshots.push(info),
            _ => {
                // 对于未知类型，尝试通过版本ID格式推断
                if is_likely_snapshot(&entry.id) {
                    snapshots.push(info);
                } else {
                    releases.push(info);
                }
            }
        }
    }
    Ok([releases, snapshots, april_fools, old_versions])
}

const APRIL_FOOLS_ID_INDICATORS: &[&str] = &[
    "20w14infinite",
    "15w14a",
    "2.0",
    "1.RV-Pre1",
    "3D Shareware v1.34",
];

/// 愚人节判定：已知玩笑 ID；4 月 1 日仅对非正式版号 / 非 release 类型生效（避免 26.1.1 等误伤）。
fn is_april_fools_version(id: &str, release_time: &str, manifest_type: &str) -> bool {
    let id_lower = id.to_lowercase();
    if APRIL_FOOLS_ID_INDICATORS.iter().any(|ind| {
        id_lower.contains(&ind.to_lowercase())
    }) {
        return true;
    }
    if manifest_type == "release" || is_plain_release_version_id(id) {
        return false;
    }
    release_time.contains("-04-01")
}

fn is_plain_release_version_id(version_id: &str) -> bool {
    static PLAIN_RELEASE: OnceLock<Regex> = OnceLock::new();
    let re = PLAIN_RELEASE.get_or_init(|| Regex::new(r"^\d+\.\d+(\.\d+)?$").unwrap());
    re.is_match(version_id)
}

/// 判断版本ID是否可能是快照版本
fn is_likely_snapshot(version_id: &str) -> bool {
    // 使用 OnceLock 缓存编译后的正则表达式，避免重复编译
    static WEEKLY_SNAPSHOT: OnceLock<Regex> = OnceLock::new();
    static PRE_RELEASE: OnceLock<Regex> = OnceLock::new();
    
    let weekly_snapshot = WEEKLY_SNAPSHOT.get_or_init(|| {
        Regex::new(r"^\d{2}w\d{2}[a-z]$").unwrap()
    });
    
    let pre_release = PRE_RELEASE.get_or_init(|| {
        Regex::new(r"(?i)(pre|rc|snapshot|beta|alpha)").unwrap()
    });
    
    weekly_snapshot.is_match(version_id) || pre_release.is_match(version_id)
}