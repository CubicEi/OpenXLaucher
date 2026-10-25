//! Modrinth / CurseForge project resolution and version listing for local mods.

use crate::handler::diagnostics::ModSearchResult;
use crate::handler::mod_platform_probe::ModPlatformKind;
use crate::http_client::{
    curseforge_client, get_with_retry, global_semaphore, modrinth_client, RetryConfig,
};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
pub const I18N_MOD_UPDATE_NETWORK_UNREACHABLE: &str = "panel.modUpdateNetworkUnreachable";
pub const I18N_MOD_UPDATE_HASH_MISS: &str = "panel.modUpdateHashMiss";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledFileSnapshot {
    pub version_number: String,
    pub published_at: Option<i64>,
    pub file_name: String,
    pub slug: String,
    pub title: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPlatform {
    pub source: String,
    pub slug: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteModVersion {
    pub version_number: String,
    pub release_type: String,
    pub download_url: String,
    pub file_name: String,
    pub loaders: Vec<String>,
    pub source: String,
    /// Unix seconds for ordering; missing timestamps sort last.
    pub published_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModRemoteVersionsResponse {
    pub resolved: Option<ResolvedPlatform>,
    pub installed: Option<InstalledFileSnapshot>,
    pub versions: Vec<RemoteModVersion>,
    pub message: Option<String>,
}

fn json_str(value: &serde_json::Value, key: &str) -> Option<String> {
    value.get(key).and_then(|v| v.as_str()).map(str::to_owned)
}

/// Parse ISO-8601 timestamps from Modrinth / CurseForge (UTC `Z` or numeric offset).
pub fn parse_iso8601_unix(timestamp: &str) -> Option<u64> {
    let t = timestamp.trim();
    if t.len() < 19 {
        return None;
    }
    let y: u32 = t.get(0..4)?.parse().ok()?;
    let m: u32 = t.get(5..7)?.parse().ok()?;
    let d: u32 = t.get(8..10)?.parse().ok()?;
    if t.get(10..11) != Some("T") && t.get(10..11) != Some(" ") {
        return None;
    }
    let h: u32 = t.get(11..13)?.parse().ok()?;
    let min: u32 = t.get(14..16)?.parse().ok()?;
    let sec: u32 = t.get(17..19)?.parse().ok()?;
    let mut unix = civil_to_unix(y, m, d, h, min, sec)?;

    let rest = t.get(19..).unwrap_or("");
    let rest = rest.trim_start_matches('.');
    let tz_start = rest
        .find('Z')
        .or_else(|| rest.find('+'))
        .or_else(|| {
            if rest.len() > 3 && rest.get(3..4) == Some("-") {
                Some(3)
            } else {
                None
            }
        });
    if let Some(idx) = tz_start {
        let tz = &rest[idx..];
        if tz.starts_with('Z') {
            return Some(unix);
        }
        if tz.len() >= 6 && (tz.starts_with('+') || tz.starts_with('-')) {
            let sign = if tz.starts_with('-') { -1i64 } else { 1 };
            let oh: i64 = tz.get(1..3)?.parse().ok()?;
            let om: i64 = tz.get(4..6)?.parse().ok()?;
            let offset_secs = sign * (oh * 3600 + om * 60);
            unix = unix.saturating_sub(offset_secs as u64);
        }
    }
    Some(unix)
}

fn civil_to_unix(y: u32, m: u32, d: u32, h: u32, min: u32, sec: u32) -> Option<u64> {
    if m < 1 || m > 12 || d < 1 || h > 23 || min > 59 || sec > 59 {
        return None;
    }
    let (y, m) = if m <= 2 {
        (y as i64 - 1, m as i64 + 12)
    } else {
        (y as i64, m as i64)
    };
    let days = 365 * y + y / 4 - y / 100 + y / 400 + (153 * (m - 2) + 2) / 5 + d as i64 - 719468;
    if days < 0 {
        return None;
    }
    let secs = days * 86400 + h as i64 * 3600 + min as i64 * 60 + sec as i64;
    if secs < 0 {
        return None;
    }
    Some(secs as u64)
}

pub fn file_sha1_hex(path: &Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let mut hasher = Sha1::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Some(hex::encode(hasher.finalize()))
}

/// SHA1 + CurseForge fingerprint for one local file (single disk read).
#[derive(Clone, Debug)]
pub struct UpdateCheckFileDigest {
    pub sha1_hex: String,
    pub curseforge_fingerprint: i32,
}

#[derive(Clone, Default)]
pub struct UpdateCheckDigestCache {
    entries: HashMap<PathBuf, UpdateCheckFileDigest>,
}

impl UpdateCheckDigestCache {
    pub fn get(&self, path: &Path) -> Option<&UpdateCheckFileDigest> {
        self.entries.get(path)
    }
}

pub fn compute_update_check_file_digest(path: &Path) -> Option<UpdateCheckFileDigest> {
    let data = fs::read(path).ok()?;
    let mut hasher = Sha1::new();
    hasher.update(&data);
    Some(UpdateCheckFileDigest {
        sha1_hex: hex::encode(hasher.finalize()),
        curseforge_fingerprint: curseforge_fingerprint_bytes(&data),
    })
}

pub fn build_update_check_digest_cache(paths: &[PathBuf]) -> UpdateCheckDigestCache {
    use rayon::prelude::*;
    let entries = paths
        .par_iter()
        .filter_map(|path| {
            compute_update_check_file_digest(path).map(|digest| (path.clone(), digest))
        })
        .collect();
    UpdateCheckDigestCache { entries }
}

fn digest_for_path<'a>(
    cache: Option<&'a UpdateCheckDigestCache>,
    path: &Path,
) -> Option<&'a UpdateCheckFileDigest> {
    cache.and_then(|c| c.get(path))
}

fn normalize_curseforge_fingerprint_input(data: &[u8]) -> Vec<u8> {
    data.iter()
        .filter(|b| !matches!(*b, 9 | 10 | 13 | 32))
        .copied()
        .collect()
}

/// CurseForge MurmurHash2 (seed 1) on whitespace-stripped bytes, signed 32-bit.
pub fn curseforge_fingerprint_bytes(data: &[u8]) -> i32 {
    let normalized = normalize_curseforge_fingerprint_input(data);
    if normalized.is_empty() {
        return 1;
    }
    murmur_hash2_signed(&normalized, 1)
}

fn murmur_hash2_signed(data: &[u8], seed: u32) -> i32 {
    const M: u32 = 0x5bd1e995;
    const R: u32 = 24;
    let mut h = seed ^ (data.len() as u32);
    let mut i = 0;
    let len = data.len();
    while i + 4 <= len {
        let mut k = u32::from(data[i])
            | (u32::from(data[i + 1]) << 8)
            | (u32::from(data[i + 2]) << 16)
            | (u32::from(data[i + 3]) << 24);
        k = k.wrapping_mul(M);
        k ^= k >> R;
        k = k.wrapping_mul(M);
        h = h.wrapping_mul(M);
        h ^= k;
        i += 4;
    }
    let mut rem = [0u8; 4];
    for j in 0..(len - i) {
        rem[j] = data[i + j];
    }
    match len - i {
        3 => {
            let mut k = u32::from(rem[0]) | (u32::from(rem[1]) << 8) | (u32::from(rem[2]) << 16);
            k = k.wrapping_mul(M);
            k ^= k >> R;
            k = k.wrapping_mul(M);
            h = h.wrapping_mul(M);
            h ^= k;
        }
        2 => {
            let mut k = u32::from(rem[0]) | (u32::from(rem[1]) << 8);
            k = k.wrapping_mul(M);
            k ^= k >> R;
            k = k.wrapping_mul(M);
            h = h.wrapping_mul(M);
            h ^= k;
        }
        1 => {
            let mut k = u32::from(rem[0]);
            k = k.wrapping_mul(M);
            k ^= k >> R;
            k = k.wrapping_mul(M);
            h = h.wrapping_mul(M);
            h ^= k;
        }
        _ => {}
    }
    h ^= h >> 13;
    h = h.wrapping_mul(M);
    h ^= h >> 15;
    h as i32
}

fn curseforge_fingerprint_file(path: &Path) -> Option<i32> {
    let data = fs::read(path).ok()?;
    Some(curseforge_fingerprint_bytes(&data))
}

/// CurseForge expects 32-bit Murmur fingerprints as **unsigned** JSON integers.
fn curseforge_fingerprint_request_body(fingerprint: i32) -> serde_json::Value {
    serde_json::json!({ "fingerprints": [fingerprint as u32] })
}

fn primary_modrinth_file(version: &serde_json::Value) -> Option<(String, String)> {
    let files = version.get("files").and_then(|f| f.as_array())?;
    let file = files
        .iter()
        .find(|f| f.get("primary").and_then(|p| p.as_bool()).unwrap_or(false))
        .or_else(|| files.first())?;
    let url = json_str(file, "url")?;
    let name = json_str(file, "filename")?;
    Some((url, name))
}

pub fn version_is_compatible(version: &serde_json::Value, mc_version: &str, mod_loader: &str) -> bool {
    let supports_mc = version
        .get("game_versions")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().any(|gv| gv.as_str() == Some(mc_version)))
        .unwrap_or(false);
    if !supports_mc {
        return false;
    }
    let loader = mod_loader.trim().to_ascii_lowercase();
    if loader.is_empty() || loader == "universal" || loader == "vanilla" {
        return true;
    }
    version
        .get("loaders")
        .and_then(|l| l.as_array())
        .map(|arr| {
            arr.iter().any(|l| {
                l.as_str()
                    .map(|s| s.eq_ignore_ascii_case(&loader))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn curseforge_file_download_url(file: &serde_json::Value) -> Option<String> {
    if let Some(url) = json_str(file, "downloadUrl").filter(|u| !u.is_empty()) {
        return Some(url);
    }
    let file_id = file.get("id")?.as_i64()?;
    let file_name = json_str(file, "fileName")?;
    let first4 = file_id / 1000;
    let last3 = file_id % 1000;
    Some(format!(
        "https://edge.forgecdn.net/files/{}/{:03}/{}",
        first4,
        last3,
        urlencoding::encode(&file_name)
    ))
}

fn curseforge_file_supports(file: &serde_json::Value, mc_version: &str, mod_loader: &str) -> bool {
    let Some(game_versions) = file.get("gameVersions").and_then(|v| v.as_array()) else {
        return false;
    };
    if !game_versions.iter().any(|v| v.as_str() == Some(mc_version)) {
        return false;
    }
    let loader = mod_loader.trim().to_ascii_lowercase();
    if loader.is_empty() || loader == "universal" || loader == "vanilla" {
        return true;
    }
    let known = ["fabric", "forge", "neoforge", "quilt", "liteloader", "ornithe"];
    let tagged: Vec<String> = game_versions
        .iter()
        .filter_map(|v| v.as_str())
        .map(|s| s.to_ascii_lowercase())
        .filter(|s| known.contains(&s.as_str()))
        .collect();
    tagged.is_empty() || tagged.iter().any(|t| t == &loader)
}

async fn get_modrinth_json(client: &reqwest::Client, url: &str) -> Option<serde_json::Value> {
    let response = get_with_retry(
        client,
        url,
        Some(RetryConfig {
            max_retries: 2,
            initial_delay_ms: 400,
            max_delay_ms: 2000,
        }),
    )
    .await
    .ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json().await.ok()
}

async fn get_curseforge_json(client: &reqwest::Client, url: &str) -> Option<serde_json::Value> {
    let semaphore = global_semaphore().await;
    let _permit = semaphore.acquire().await.ok()?;
    let response = get_with_retry(
        client,
        url,
        Some(RetryConfig {
            max_retries: 2,
            initial_delay_ms: 500,
            max_delay_ms: 2500,
        }),
    )
    .await
    .ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json().await.ok()
}

async fn modrinth_project_exists(client: &reqwest::Client, slug_or_id: &str) -> Option<serde_json::Value> {
    let url = format!(
        "https://api.modrinth.com/v2/project/{}",
        urlencoding::encode(slug_or_id)
    );
    get_modrinth_json(client, &url).await
}

async fn curseforge_project_by_slug(client: &reqwest::Client, slug: &str) -> Option<serde_json::Value> {
    let url = format!(
        "https://api.curseforge.com/v1/mods/search?gameId=432&classId=6&searchFilter={}",
        urlencoding::encode(slug)
    );
    let json = get_curseforge_json(client, &url).await?;
    json.get("data")
        .and_then(|d| d.as_array())
        .and_then(|arr| {
            arr.iter().find(|p| {
                json_str(p, "slug")
                    .map(|s| s.eq_ignore_ascii_case(slug))
                    .unwrap_or(false)
            })
        })
        .cloned()
}

fn curseforge_exact_match_file(data: &serde_json::Value) -> Option<&serde_json::Value> {
    let entries: Vec<&serde_json::Value> = data
        .get("exactMatches")
        .and_then(|m| {
            if let Some(arr) = m.as_array() {
                Some(arr.iter().collect())
            } else if let Some(obj) = m.as_object() {
                Some(obj.values().collect())
            } else {
                None
            }
        })
        .unwrap_or_default();
    for entry in entries {
        let file_obj = if entry.is_array() {
            entry.as_array().and_then(|a| a.first())
        } else {
            Some(entry)
        };
        if let Some(file_obj) = file_obj {
            return Some(file_obj);
        }
    }
    None
}

async fn modrinth_installed_snapshot(
    client: &reqwest::Client,
    sha1: &str,
) -> Option<InstalledFileSnapshot> {
    let url = format!(
        "https://api.modrinth.com/v2/version_file/{}?algorithm=sha1",
        sha1
    );
    let json = get_modrinth_json(client, &url).await?;
    let project_id = json_str(&json, "project_id")?;
    let version_number = json_str(&json, "version_number").unwrap_or_default();
    let published_at = modrinth_version_published_at(&json);
    let (_, file_name) = primary_modrinth_file(&json)?;
    let project = modrinth_project_exists(client, &project_id).await?;
    let slug = json_str(&project, "slug").unwrap_or_else(|| project_id.clone());
    let title = json_str(&project, "title").unwrap_or_else(|| slug.clone());
    Some(InstalledFileSnapshot {
        version_number,
        published_at,
        file_name,
        slug,
        title,
        source: "modrinth".to_string(),
    })
}

async fn curseforge_snapshot_from_fingerprint(
    client: &reqwest::Client,
    fingerprint: i32,
) -> Option<InstalledFileSnapshot> {
    let body = curseforge_fingerprint_request_body(fingerprint);
    let semaphore = global_semaphore().await;
    let _permit = semaphore.acquire().await.ok()?;
    let response = client
        .post("https://api.curseforge.com/v1/fingerprints/432")
        .json(&body)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let json: serde_json::Value = response.json().await.ok()?;
    let data = json.get("data")?;
    let file_obj = curseforge_exact_match_file(data)?;
    let mod_id = file_obj
        .get("modId")
        .and_then(|v| v.as_i64())
        .or_else(|| file_obj.get("id").and_then(|v| v.as_i64()))
        .or_else(|| {
            file_obj
                .get("file")
                .and_then(|f| f.get("modId"))
                .and_then(|v| v.as_i64())
        })?;
    let file = file_obj.get("file").unwrap_or(file_obj);
    let file_name = json_str(file, "fileName")?;
    let version_number = json_str(file, "displayName")
        .or_else(|| json_str(file, "fileName"))
        .unwrap_or_default();
    let published_at = curseforge_file_published_at(file);
    let project = get_curseforge_json(
        client,
        &format!("https://api.curseforge.com/v1/mods/{}", mod_id),
    )
    .await?;
    let project_data = project.get("data").unwrap_or(&project);
    let slug = json_str(project_data, "slug").unwrap_or_else(|| mod_id.to_string());
    let title = json_str(project_data, "name").unwrap_or_else(|| slug.clone());
    Some(InstalledFileSnapshot {
        version_number,
        published_at,
        file_name,
        slug,
        title,
        source: "curseforge".to_string(),
    })
}

async fn curseforge_installed_snapshot(
    client: &reqwest::Client,
    jar_path: &Path,
    digests: Option<&UpdateCheckDigestCache>,
) -> Option<InstalledFileSnapshot> {
    let fingerprint = digest_for_path(digests, jar_path)
        .map(|d| d.curseforge_fingerprint)
        .or_else(|| curseforge_fingerprint_file(jar_path))?;
    curseforge_snapshot_from_fingerprint(client, fingerprint).await
}

fn snapshot_to_resolved(snapshot: &InstalledFileSnapshot) -> ResolvedPlatform {
    ResolvedPlatform {
        source: snapshot.source.clone(),
        slug: snapshot.slug.clone(),
        title: snapshot.title.clone(),
    }
}

/// Resolve installed jar on a single platform (hash / fingerprint APIs).
pub async fn resolve_installed_file_on_platform(
    jar_path: &Path,
    kind: ModPlatformKind,
    digests: Option<&UpdateCheckDigestCache>,
) -> Option<InstalledFileSnapshot> {
    if !jar_path.is_file() {
        return None;
    }
    match kind {
        ModPlatformKind::Modrinth => {
            let sha1 = digest_for_path(digests, jar_path)
                .map(|d| d.sha1_hex.clone())
                .or_else(|| file_sha1_hex(jar_path))?;
            let client = modrinth_client().await;
            modrinth_installed_snapshot(&client, &sha1).await
        }
        ModPlatformKind::CurseForge => {
            let client = curseforge_client().await;
            curseforge_installed_snapshot(&client, jar_path, digests).await
        }
    }
}

/// Identify the installed jar via platform hash APIs only (no homepage / registry fallback).
pub async fn resolve_installed_file(
    jar_path: &Path,
    try_order: &[ModPlatformKind],
    digests: Option<&UpdateCheckDigestCache>,
) -> Option<InstalledFileSnapshot> {
    for kind in try_order {
        if let Some(snapshot) =
            resolve_installed_file_on_platform(jar_path, *kind, digests).await
        {
            return Some(snapshot);
        }
    }
    None
}

/// Whether the installed file's upstream metadata supports this instance MC version + loader.
pub async fn installed_file_supports_instance(
    jar_path: &Path,
    snapshot: &InstalledFileSnapshot,
    mc_version: &str,
    loader: &str,
    digests: Option<&UpdateCheckDigestCache>,
) -> bool {
    match snapshot.source.as_str() {
        "modrinth" => {
            let sha1 = digest_for_path(digests, jar_path)
                .map(|d| d.sha1_hex.clone())
                .or_else(|| file_sha1_hex(jar_path));
            let Some(sha1) = sha1 else {
                return false;
            };
            let client = modrinth_client().await;
            let url = format!(
                "https://api.modrinth.com/v2/version_file/{}?algorithm=sha1",
                sha1
            );
            let Some(json) = get_modrinth_json(&client, &url).await else {
                return false;
            };
            version_is_compatible(&json, mc_version, loader)
        }
        "curseforge" => {
            let fingerprint = digest_for_path(digests, jar_path)
                .map(|d| d.curseforge_fingerprint)
                .or_else(|| curseforge_fingerprint_file(jar_path));
            let Some(fingerprint) = fingerprint else {
                return false;
            };
            let client = curseforge_client().await;
            let body = curseforge_fingerprint_request_body(fingerprint);
            let semaphore = global_semaphore().await;
            let Ok(_permit) = semaphore.acquire().await else {
                return false;
            };
            let Some(response) = client
                .post("https://api.curseforge.com/v1/fingerprints/432")
                .json(&body)
                .send()
                .await
                .ok()
            else {
                return false;
            };
            if !response.status().is_success() {
                return false;
            }
            let Some(json): Option<serde_json::Value> = response.json().await.ok() else {
                return false;
            };
            let Some(data) = json.get("data") else {
                return false;
            };
            let Some(file_obj) = curseforge_exact_match_file(data) else {
                return false;
            };
            let file = file_obj.get("file").unwrap_or(file_obj);
            curseforge_file_supports(file, mc_version, loader)
        }
        _ => false,
    }
}

fn modrinth_release_type(version: &serde_json::Value) -> String {
    match version.get("version_type").and_then(|t| t.as_str()) {
        Some("release") => "release".to_string(),
        Some("beta") => "beta".to_string(),
        Some("alpha") => "alpha".to_string(),
        other => other.unwrap_or("release").to_string(),
    }
}

fn curseforge_file_published_at(file: &serde_json::Value) -> Option<i64> {
    json_str(file, "fileDate")
        .or_else(|| json_str(file, "fileReleased"))
        .or_else(|| json_str(file, "dateReleased"))
        .and_then(|s| parse_iso8601_unix(&s).map(|t| t as i64))
}

fn modrinth_version_published_at(version: &serde_json::Value) -> Option<i64> {
    json_str(version, "date_published")
        .and_then(|s| parse_iso8601_unix(&s).map(|t| t as i64))
}

fn sort_versions_newest_first(versions: &mut [RemoteModVersion]) {
    versions.sort_by(|a, b| {
        let ta = a.published_at.unwrap_or(0);
        let tb = b.published_at.unwrap_or(0);
        tb.cmp(&ta)
    });
}

fn pick_best_candidate(versions: &[RemoteModVersion]) -> Option<&RemoteModVersion> {
    versions
        .iter()
        .max_by_key(|v| v.published_at.unwrap_or(0))
}

/// Whether a newer compatible release exists vs the installed file (publish time only).
pub fn should_offer_update_by_time<'a>(
    installed_published_at: Option<i64>,
    versions: &'a [RemoteModVersion],
) -> Option<&'a RemoteModVersion> {
    let baseline_ts = installed_published_at.unwrap_or(0);
    let candidate = pick_best_candidate(versions)?;
    let candidate_ts = candidate.published_at.unwrap_or(0);
    if candidate_ts <= baseline_ts || candidate_ts == 0 {
        return None;
    }
    Some(candidate)
}

/// Pick an update candidate from filtered compatible versions.
/// When the installed file does not support the current instance, any compatible remote
/// version counts as an update (ignore publish time).
pub fn pick_update_candidate<'a>(
    installed_published_at: Option<i64>,
    versions: &'a [RemoteModVersion],
    installed_supports_instance: bool,
) -> Option<&'a RemoteModVersion> {
    if versions.is_empty() {
        return None;
    }
    if !installed_supports_instance {
        return pick_best_candidate(versions);
    }
    should_offer_update_by_time(installed_published_at, versions)
}

fn remote_version_to_search_result(
    platform: &ResolvedPlatform,
    pick: &RemoteModVersion,
    mc_version: &str,
) -> ModSearchResult {
    ModSearchResult {
        source: platform.source.clone(),
        mod_id: platform.slug.clone(),
        slug: platform.slug.clone(),
        title: platform.title.clone(),
        download_url: Some(pick.download_url.clone()),
        file_name: Some(pick.file_name.clone()),
        mc_versions: vec![mc_version.to_string()],
        loaders: pick.loaders.clone(),
        version_number: Some(pick.version_number.clone()),
        published_at: pick.published_at.map(|t| t as u64),
    }
}

pub async fn pick_update_if_newer(
    jar_path: &Path,
    snapshot: &InstalledFileSnapshot,
    mc_version: &str,
    loader: &str,
    digests: Option<&UpdateCheckDigestCache>,
) -> Option<ModSearchResult> {
    let platform = snapshot_to_resolved(snapshot);
    let versions = list_compatible_versions(&platform, mc_version, loader).await;
    if versions.is_empty() {
        return None;
    }
    let supports_instance = installed_file_supports_instance(
        jar_path,
        snapshot,
        mc_version,
        loader,
        digests,
    )
    .await;
    let pick = pick_update_candidate(snapshot.published_at, &versions, supports_instance)?;
    Some(remote_version_to_search_result(&platform, pick, mc_version))
}

fn modrinth_loaders(version: &serde_json::Value) -> Vec<String> {
    version
        .get("loaders")
        .and_then(|l| l.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// Modrinth `GET /project/{id}/version` supports `game_versions` + `loaders` query filters.
fn modrinth_versions_list_url(slug: &str, mc_version: &str, loader: &str) -> String {
    let mc = mc_version.trim();
    let game_versions =
        serde_json::to_string(&[mc]).unwrap_or_else(|_| format!(r#"["{}"]"#, mc));
    let mut query = format!(
        "game_versions={}&include_changelog=false",
        urlencoding::encode(&game_versions)
    );
    let loader_norm = loader.trim().to_ascii_lowercase();
    if !loader_norm.is_empty() && loader_norm != "universal" && loader_norm != "vanilla" {
        let loaders =
            serde_json::to_string(&[loader_norm.as_str()]).unwrap_or_else(|_| {
                format!(r#"["{}"]"#, loader_norm)
            });
        query.push('&');
        query.push_str(&format!("loaders={}", urlencoding::encode(&loaders)));
    }
    format!(
        "https://api.modrinth.com/v2/project/{}/version?{}",
        urlencoding::encode(slug),
        query
    )
}

fn curseforge_mod_loader_type_param(loader: &str) -> Option<&'static str> {
    match loader.trim().to_ascii_lowercase().as_str() {
        "forge" => Some("1"),
        "fabric" => Some("4"),
        "quilt" => Some("5"),
        "neoforge" => Some("6"),
        "liteloader" => Some("3"),
        _ => None,
    }
}

fn curseforge_files_list_url(mod_id: i64, mc_version: &str, loader: &str) -> String {
    let mut url = format!(
        "https://api.curseforge.com/v1/mods/{}/files?gameVersion={}&pageSize=50",
        mod_id,
        urlencoding::encode(mc_version.trim()),
    );
    if let Some(loader_type) = curseforge_mod_loader_type_param(loader) {
        url.push_str(&format!("&modLoaderType={}", loader_type));
    }
    url
}

pub async fn list_compatible_versions(
    platform: &ResolvedPlatform,
    mc_version: &str,
    loader: &str,
) -> Vec<RemoteModVersion> {
    if platform.source == "modrinth" {
        let client = modrinth_client().await;
        let url = modrinth_versions_list_url(&platform.slug, mc_version, loader);
        let Some(json) = get_modrinth_json(&client, &url).await else {
            return Vec::new();
        };
        let Some(versions) = json.as_array() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for version in versions {
            if !version_is_compatible(version, mc_version, loader) {
                continue;
            }
            let Some((download_url, file_name)) = primary_modrinth_file(version) else {
                continue;
            };
            let version_number = json_str(version, "version_number").unwrap_or_default();
            out.push(RemoteModVersion {
                version_number,
                release_type: modrinth_release_type(version),
                download_url,
                file_name,
                loaders: modrinth_loaders(version),
                source: "modrinth".to_string(),
                published_at: modrinth_version_published_at(version),
            });
        }
        sort_versions_newest_first(&mut out);
        return out;
    }

    if platform.source == "curseforge" {
        let client = curseforge_client().await;
        let Some(search) = curseforge_project_by_slug(&client, &platform.slug).await else {
            return Vec::new();
        };
        let Some(mod_id) = search.get("id").and_then(|v| v.as_i64()) else {
            return Vec::new();
        };
        let files_url = curseforge_files_list_url(mod_id, mc_version, loader);
        let Some(files_json) = get_curseforge_json(&client, &files_url).await else {
            return Vec::new();
        };
        let files = files_json
            .get("data")
            .and_then(|d| d.as_array())
            .cloned()
            .unwrap_or_default();
        let mut out = Vec::new();
        for file in files {
            if !curseforge_file_supports(&file, mc_version, loader) {
                continue;
            }
            let Some(download_url) = curseforge_file_download_url(&file) else {
                continue;
            };
            let file_name = json_str(&file, "fileName").unwrap_or_default();
            let version_number = json_str(&file, "displayName")
                .or_else(|| json_str(&file, "fileName"))
                .unwrap_or_default();
            let release_type = match file.get("releaseType").and_then(|t| t.as_i64()) {
                Some(1) => "release",
                Some(2) => "beta",
                Some(3) => "alpha",
                _ => "release",
            }
            .to_string();
            out.push(RemoteModVersion {
                version_number,
                release_type,
                download_url,
                file_name,
                loaders: vec![loader.to_string()],
                source: "curseforge".to_string(),
                published_at: curseforge_file_published_at(&file),
            });
        }
        sort_versions_newest_first(&mut out);
        return out;
    }

    Vec::new()
}
