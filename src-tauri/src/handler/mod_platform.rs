//! Modrinth / CurseForge project resolution and version listing for local mods.

use crate::handler::diagnostics::ModSearchResult;
use crate::handler::mod_file_registry::RegistryBinding;
use crate::handler::mod_parser::ModInfo;
use crate::http_client::{
    curseforge_client, get_with_retry, global_semaphore, modrinth_client, shared_client, RetryConfig,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
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
    pub versions: Vec<RemoteModVersion>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlatformKind {
    Modrinth,
    CurseForge,
}

#[derive(Debug, Clone)]
struct PlatformRef {
    kind: PlatformKind,
    slug: String,
    modrinth_project_id: Option<String>,
    curseforge_mod_id: Option<i64>,
}

fn json_str(value: &serde_json::Value, key: &str) -> Option<String> {
    value.get(key).and_then(|v| v.as_str()).map(str::to_owned)
}

/// Strip loader / MC suffixes so `8.2.19` matches `8.2.19+26.2` or `8.2.19+1.21.1`.
pub fn normalize_mod_version(raw: &str) -> String {
    let mut s = raw.trim().trim_start_matches('v').trim().to_ascii_lowercase();
    if let Some((base, _)) = s.split_once('+') {
        s = base.trim().to_string();
    }
    static MC_SUFFIX: OnceLock<Regex> = OnceLock::new();
    let re = MC_SUFFIX.get_or_init(|| {
        Regex::new(r"-\d+\.\d+(?:\.\d+)?(?:\.\d+)?$").expect("regex")
    });
    if let Some(m) = re.find(&s) {
        s.truncate(m.start());
        s = s.trim_end_matches('-').to_string();
    }
    s
}

pub fn mod_versions_match(a: &str, b: &str) -> bool {
    normalize_mod_version(a) == normalize_mod_version(b)
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

pub fn parse_platform_ref(url: &str) -> Option<PlatformRef> {
    let lower = url.to_ascii_lowercase();
    if let Some(idx) = lower.find("modrinth.com/mod/") {
        let rest = &url[idx + "modrinth.com/mod/".len()..];
        let slug = rest
            .split(&['/', '?', '#'][..])
            .next()
            .unwrap_or("")
            .trim();
        if !slug.is_empty() {
            return Some(PlatformRef {
                kind: PlatformKind::Modrinth,
                slug: slug.to_string(),
                modrinth_project_id: None,
                curseforge_mod_id: None,
            });
        }
    }
    if let Some(idx) = lower.find("curseforge.com/minecraft/mc-mods/") {
        let rest = &url[idx + "curseforge.com/minecraft/mc-mods/".len()..];
        let slug = rest
            .split(&['/', '?', '#'][..])
            .next()
            .unwrap_or("")
            .trim();
        if !slug.is_empty() {
            return Some(PlatformRef {
                kind: PlatformKind::CurseForge,
                slug: slug.to_string(),
                modrinth_project_id: None,
                curseforge_mod_id: None,
            });
        }
    }
    None
}

pub fn platform_refs_from_mod_info(mod_info: &ModInfo) -> Vec<PlatformRef> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for url in [mod_info.homepage.as_deref(), mod_info.source.as_deref(), mod_info.issues.as_deref()]
        .into_iter()
        .flatten()
    {
        if let Some(ref_) = parse_platform_ref(url) {
            let kind_tag = match ref_.kind {
                PlatformKind::Modrinth => "mr",
                PlatformKind::CurseForge => "cf",
            };
            let key = format!("{}:{}", kind_tag, ref_.slug.to_ascii_lowercase());
            if seen.insert(key) {
                out.push(ref_);
            }
        }
    }
    out
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

fn normalize_curseforge_fingerprint_input(data: &[u8]) -> Vec<u8> {
    data.iter()
        .filter(|b| !matches!(*b, 9 | 10 | 13 | 32))
        .copied()
        .collect()
}

/// CurseForge MurmurHash2 (seed 1) on whitespace-stripped bytes, signed 32-bit.
pub fn curseforge_fingerprint_bytes(data: &[u8]) -> i32 {
    let normalized = normalize_curseforge_fingerprint_input(data);
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
        k *= M;
        k ^= k >> R;
        k *= M;
        h *= M;
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
            k *= M;
            k ^= k >> R;
            k *= M;
            h *= M;
            h ^= k;
        }
        2 => {
            let mut k = u32::from(rem[0]) | (u32::from(rem[1]) << 8);
            k *= M;
            k ^= k >> R;
            k *= M;
            h *= M;
            h ^= k;
        }
        1 => {
            let mut k = u32::from(rem[0]);
            k *= M;
            k ^= k >> R;
            k *= M;
            h *= M;
            h ^= k;
        }
        _ => {}
    }
    h ^= h >> 13;
    h *= M;
    h ^= h >> 15;
    h as i32
}

fn curseforge_fingerprint_file(path: &Path) -> Option<i32> {
    let data = fs::read(path).ok()?;
    Some(curseforge_fingerprint_bytes(&data))
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

async fn resolve_from_modrinth_slug(client: &reqwest::Client, slug: &str) -> Option<ResolvedPlatform> {
    let project = modrinth_project_exists(client, slug).await?;
    let slug_out = json_str(&project, "slug").unwrap_or_else(|| slug.to_string());
    let title = json_str(&project, "title").unwrap_or_else(|| slug_out.clone());
    Some(ResolvedPlatform {
        source: "modrinth".to_string(),
        slug: slug_out,
        title,
    })
}

async fn resolve_from_curseforge_slug(client: &reqwest::Client, slug: &str) -> Option<ResolvedPlatform> {
    let project = curseforge_project_by_slug(client, slug).await?;
    let slug_out = json_str(&project, "slug").unwrap_or_else(|| slug.to_string());
    let title = json_str(&project, "name").unwrap_or_else(|| slug_out.clone());
    Some(ResolvedPlatform {
        source: "curseforge".to_string(),
        slug: slug_out,
        title,
    })
}

async fn lookup_modrinth_by_sha1(
    client: &reqwest::Client,
    sha1: &str,
) -> Option<PlatformRef> {
    let url = format!(
        "https://api.modrinth.com/v2/version_file/{}?algorithm=sha1",
        sha1
    );
    let json = get_modrinth_json(client, &url).await?;
    let project_id = json_str(&json, "project_id")?;
    let slug = modrinth_project_exists(client, &project_id)
        .await
        .and_then(|p| json_str(&p, "slug"))
        .unwrap_or_else(|| project_id.clone());
    Some(PlatformRef {
        kind: PlatformKind::Modrinth,
        slug,
        modrinth_project_id: Some(project_id),
        curseforge_mod_id: None,
    })
}

async fn lookup_curseforge_by_fingerprint(
    client: &reqwest::Client,
    fingerprint: i32,
) -> Option<PlatformRef> {
    let body = serde_json::json!({ "fingerprints": [fingerprint] });
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
        let file_obj = file_obj?;
        let mod_id = file_obj
            .get("modId")
            .and_then(|v| v.as_i64())
            .or_else(|| file_obj.get("id").and_then(|v| v.as_i64()))
            .or_else(|| {
                file_obj
                    .get("file")
                    .and_then(|f| f.get("modId"))
                    .and_then(|v| v.as_i64())
            });
        if let Some(mod_id) = mod_id {
            let project = get_curseforge_json(
                client,
                &format!("https://api.curseforge.com/v1/mods/{}", mod_id),
            )
            .await?;
            let slug = json_str(project.get("data").unwrap_or(&project), "slug")
                .unwrap_or_else(|| mod_id.to_string());
            return Some(PlatformRef {
                kind: PlatformKind::CurseForge,
                slug,
                modrinth_project_id: None,
                curseforge_mod_id: Some(mod_id),
            });
        }
    }
    None
}

fn platform_ref_from_registry(record: &RegistryBinding) -> PlatformRef {
    match record.source.as_str() {
        "curseforge" => {
            let cf_id = record
                .project_id
                .as_deref()
                .and_then(|s| s.parse::<i64>().ok());
            PlatformRef {
                kind: PlatformKind::CurseForge,
                slug: record.project_slug.clone(),
                modrinth_project_id: None,
                curseforge_mod_id: cf_id,
            }
        }
        _ => PlatformRef {
            kind: PlatformKind::Modrinth,
            slug: record.project_slug.clone(),
            modrinth_project_id: record.project_id.clone(),
            curseforge_mod_id: None,
        },
    }
}

async fn platform_ref_to_resolved(
    client_mr: &reqwest::Client,
    client_cf: &reqwest::Client,
    pref: &PlatformRef,
) -> Option<ResolvedPlatform> {
    match pref.kind {
        PlatformKind::Modrinth => resolve_from_modrinth_slug(client_mr, &pref.slug).await,
        PlatformKind::CurseForge => resolve_from_curseforge_slug(client_cf, &pref.slug).await,
    }
}

/// Resolve the upstream Modrinth or CurseForge project for a local mod jar.
pub async fn resolve_mod_platform(mod_info: &ModInfo, jar_path: &Path) -> Option<ResolvedPlatform> {
    let mr = modrinth_client().await;
    let cf = curseforge_client().await;

    let sha1 = if jar_path.is_file() {
        file_sha1_hex(jar_path)
    } else {
        None
    };

    if let Some(ref sha1) = sha1 {
        if let Some(pref) = lookup_modrinth_by_sha1(&mr, sha1).await {
            if let Some(r) = platform_ref_to_resolved(&mr, &cf, &pref).await {
                return Some(r);
            }
        }
        if let Some(fp) = curseforge_fingerprint_file(jar_path) {
            if let Some(pref) = lookup_curseforge_by_fingerprint(&cf, fp).await {
                if let Some(r) = platform_ref_to_resolved(&mr, &cf, &pref).await {
                    return Some(r);
                }
            }
        }
    }

    for pref in platform_refs_from_mod_info(mod_info) {
        if let Some(r) = platform_ref_to_resolved(&mr, &cf, &pref).await {
            return Some(r);
        }
    }

    if let Some(ref sha1) = sha1 {
        if let Some(record) = crate::handler::mod_file_registry::lookup_by_sha1(sha1) {
            let pref = platform_ref_from_registry(&record);
            if let Some(r) = platform_ref_to_resolved(&mr, &cf, &pref).await {
                return Some(r);
            }
        }
    }

    None
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

fn release_type_rank(release_type: &str) -> u8 {
    match release_type.to_ascii_lowercase().as_str() {
        "release" => 0,
        "beta" => 1,
        "alpha" => 2,
        _ => 3,
    }
}

/// Normalize mod version labels so `8.2.19` matches `8.2.19+26.2` for the same MC.
pub fn normalize_version_label(version: &str, mc_version: &str) -> String {
    let mut v = version.trim().trim_start_matches('v').trim().to_string();
    let mc = mc_version.trim();
    if mc.is_empty() {
        return v.to_ascii_lowercase();
    }
    let lower = v.to_ascii_lowercase();
    let suffixes = [
        format!("+{}", mc),
        format!("+ {}", mc),
        format!(" for {}", mc),
        format!(" for mc {}", mc),
    ];
    for suffix in suffixes {
        let suf = suffix.to_ascii_lowercase();
        if lower.ends_with(&suf) {
            v = v[..v.len().saturating_sub(suffix.len())].trim_end().to_string();
            break;
        }
    }
    v.to_ascii_lowercase()
}

pub fn versions_equivalent(local: &str, remote: &str, mc_version: &str) -> bool {
    if local.trim().eq_ignore_ascii_case(remote.trim()) {
        return true;
    }
    normalize_version_label(local, mc_version) == normalize_version_label(remote, mc_version)
}

fn sort_versions_newest_first(versions: &mut [RemoteModVersion]) {
    versions.sort_by(|a, b| {
        let ta = a.published_at.unwrap_or(0);
        let tb = b.published_at.unwrap_or(0);
        tb.cmp(&ta)
            .then_with(|| release_type_rank(&a.release_type).cmp(&release_type_rank(&b.release_type)))
    });
}

fn baseline_published_at_for(
    local_version: &str,
    versions: &[RemoteModVersion],
    mc_version: &str,
) -> i64 {
    versions
        .iter()
        .filter(|v| versions_equivalent(local_version, &v.version_number, mc_version))
        .map(|v| v.published_at.unwrap_or(0))
        .max()
        .unwrap_or(0)
}

fn pick_best_candidate(versions: &[RemoteModVersion]) -> Option<&RemoteModVersion> {
    if versions.is_empty() {
        return None;
    }
    for want in ["release", "beta", "alpha"] {
        let mut best: Option<&RemoteModVersion> = None;
        for v in versions {
            if v.release_type.eq_ignore_ascii_case(want) {
                let replace = match best {
                    None => true,
                    Some(b) => {
                        let ta = v.published_at.unwrap_or(0);
                        let tb = b.published_at.unwrap_or(0);
                        ta > tb
                    }
                };
                if replace {
                    best = Some(v);
                }
            }
        }
        if best.is_some() {
            return best;
        }
    }
    versions.iter().max_by_key(|v| v.published_at.unwrap_or(0))
}

/// Whether a newer compatible release exists vs the installed mod (by publish time).
pub fn should_offer_update<'a>(
    local_version: &str,
    versions: &'a [RemoteModVersion],
    mc_version: &str,
) -> Option<&'a RemoteModVersion> {
    let baseline_ts = baseline_published_at_for(local_version, versions, mc_version);
    let candidate = pick_best_candidate(versions)?;
    let candidate_ts = candidate.published_at.unwrap_or(0);
    if candidate_ts <= baseline_ts {
        return None;
    }
    if versions_equivalent(local_version, &candidate.version_number, mc_version) {
        return None;
    }
    Some(candidate)
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
    platform: &ResolvedPlatform,
    mod_info: &ModInfo,
    mc_version: &str,
    loader: &str,
) -> Option<ModSearchResult> {
    let versions = list_compatible_versions(platform, mc_version, loader).await;
    let pick = should_offer_update(&mod_info.version, &versions, mc_version)?;
    Some(remote_version_to_search_result(platform, pick, mc_version))
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

pub async fn list_compatible_versions(
    platform: &ResolvedPlatform,
    mc_version: &str,
    loader: &str,
) -> Vec<RemoteModVersion> {
    if platform.source == "modrinth" {
        let client = modrinth_client().await;
        let url = format!(
            "https://api.modrinth.com/v2/project/{}/version",
            urlencoding::encode(&platform.slug)
        );
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
        let files_url = format!("https://api.curseforge.com/v1/mods/{}/files?pageSize=1000", mod_id);
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

pub async fn fetch_latest_search_result(
    platform: &ResolvedPlatform,
    mc_version: &str,
    loader: &str,
) -> Option<ModSearchResult> {
    let versions = list_compatible_versions(platform, mc_version, loader).await;
    let pick = pick_best_candidate(&versions)?;
    Some(remote_version_to_search_result(platform, pick, mc_version))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_modrinth_url() {
        let r = parse_platform_ref("https://modrinth.com/mod/sodium").unwrap();
        assert_eq!(r.slug, "sodium");
    }

    #[test]
    fn parse_curseforge_url() {
        let r = parse_platform_ref("https://www.curseforge.com/minecraft/mc-mods/jei/files").unwrap();
        assert_eq!(r.slug, "jei");
    }

    #[test]
    fn curseforge_fingerprint_empty() {
        assert_eq!(curseforge_fingerprint_bytes(b""), 1);
    }

    #[test]
    fn curseforge_fingerprint_strips_whitespace() {
        let with_ws: Vec<u8> = vec![9, 116, 10, 101, 13, 115, 32, 116];
        assert_eq!(curseforge_fingerprint_bytes(&with_ws), curseforge_fingerprint_bytes(b"test"));
    }

    #[test]
    fn normalize_mod_version_strips_build_suffix() {
        assert_eq!(normalize_mod_version("8.2.19+26.2"), "8.2.19");
        assert_eq!(normalize_mod_version("v1.0.0+1.21.1"), "1.0.0");
    }

    #[test]
    fn parse_iso8601_unix_reads_utc() {
        let ts = parse_iso8601_unix("2024-06-01T12:00:00Z").expect("parse");
        assert!(ts > 1_700_000_000);
    }

    #[test]
    fn normalize_version_strips_mc_suffix() {
        assert_eq!(
            normalize_version_label("8.2.19+26.2", "26.2"),
            normalize_version_label("8.2.19", "26.2")
        );
    }

    #[test]
    fn versions_equivalent_for_mc_suffix() {
        assert!(versions_equivalent("8.2.19", "8.2.19+26.2", "26.2"));
    }

    #[test]
    fn should_offer_update_by_published_at() {
        let versions = vec![
            RemoteModVersion {
                version_number: "8.2.19".into(),
                release_type: "release".into(),
                download_url: "u1".into(),
                file_name: "a.jar".into(),
                loaders: vec![],
                source: "modrinth".into(),
                published_at: Some(100),
            },
            RemoteModVersion {
                version_number: "8.2.20".into(),
                release_type: "release".into(),
                download_url: "u2".into(),
                file_name: "b.jar".into(),
                loaders: vec![],
                source: "modrinth".into(),
                published_at: Some(200),
            },
        ];
        assert!(should_offer_update("8.2.19", &versions, "26.2").is_some());
        assert!(should_offer_update("8.2.19+26.2", &versions, "26.2").is_some());
        assert!(should_offer_update("8.2.20", &versions, "26.2").is_none());
    }

    #[test]
    fn should_offer_update_uses_max_baseline_timestamp() {
        let versions = vec![
            RemoteModVersion {
                version_number: "8.2.19".into(),
                release_type: "release".into(),
                download_url: "u1".into(),
                file_name: "a.jar".into(),
                loaders: vec![],
                source: "modrinth".into(),
                published_at: Some(50),
            },
            RemoteModVersion {
                version_number: "8.2.19+26.2".into(),
                release_type: "release".into(),
                download_url: "u1b".into(),
                file_name: "a2.jar".into(),
                loaders: vec![],
                source: "modrinth".into(),
                published_at: Some(150),
            },
            RemoteModVersion {
                version_number: "8.2.20".into(),
                release_type: "release".into(),
                download_url: "u2".into(),
                file_name: "b.jar".into(),
                loaders: vec![],
                source: "modrinth".into(),
                published_at: Some(200),
            },
        ];
        assert!(should_offer_update("8.2.19", &versions, "26.2").is_some());
        assert!(should_offer_update("8.2.19+26.2", &versions, "26.2").is_some());
    }

}
