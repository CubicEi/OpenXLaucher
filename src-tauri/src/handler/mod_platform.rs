//! Modrinth / CurseForge project resolution and version listing for local mods.

use crate::handler::chinese_search::lookup_moddata_platform_hint;
use crate::handler::diagnostics::ModSearchResult;
use crate::handler::mod_parser::ModInfo;
use crate::http_client::{
    curseforge_client, get_with_retry, global_semaphore, modrinth_client, shared_client, RetryConfig,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

const MCMOD_CACHE_FILE: &str = "mcmod-platform-cache.json";
const MCMOD_CACHE_TTL_SECS: u64 = 7 * 24 * 3600;

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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModRemoteVersionsResponse {
    pub resolved: Option<ResolvedPlatform>,
    pub versions: Vec<RemoteModVersion>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct McmodCacheEntry {
    fetched_at: u64,
    modrinth_slug: Option<String>,
    modrinth_project_id: Option<String>,
    curseforge_slug: Option<String>,
    curseforge_mod_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct McmodCacheStore {
    entries: HashMap<String, McmodCacheEntry>,
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

fn file_sha1_hex(path: &Path) -> Option<String> {
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
    let game_versions = file.get("gameVersions").and_then(|v| v.as_array())?;
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

fn mcmod_cache_path() -> Option<PathBuf> {
    crate::handler::cache_paths::cache_root_dir()
        .ok()
        .map(|p| p.join(MCMOD_CACHE_FILE))
}

fn load_mcmod_cache() -> McmodCacheStore {
    let Some(path) = mcmod_cache_path() else {
        return McmodCacheStore::default();
    };
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return McmodCacheStore::default(),
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn save_mcmod_cache(store: &McmodCacheStore) {
    if let Some(path) = mcmod_cache_path() {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(text) = serde_json::to_string_pretty(store) {
            let _ = fs::write(path, text);
        }
    }
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn parse_mcmod_html(html: &str) -> McmodCacheEntry {
    let mut entry = McmodCacheEntry {
        fetched_at: now_unix(),
        modrinth_slug: None,
        modrinth_project_id: None,
        curseforge_slug: None,
        curseforge_mod_id: None,
    };
    static MR_SLUG: OnceLock<Regex> = OnceLock::new();
    static CF_SLUG: OnceLock<Regex> = OnceLock::new();
    static MR_ID: OnceLock<Regex> = OnceLock::new();
    let mr_slug = MR_SLUG.get_or_init(|| {
        Regex::new(r"(?i)modrinth\.com/mod/([a-zA-Z0-9_\-\.]+)").expect("regex")
    });
    let cf_slug = CF_SLUG.get_or_init(|| {
        Regex::new(r"(?i)curseforge\.com/minecraft/mc-mods/([a-zA-Z0-9_\-\.]+)").expect("regex")
    });
    let mr_id = MR_ID.get_or_init(|| {
        Regex::new(r"(?i)Modrinth\s+Project\s+ID[^A-Za-z0-9]*([A-Za-z0-9]{4,12})").expect("regex")
    });
    if let Some(m) = mr_slug.captures(html) {
        entry.modrinth_slug = m.get(1).map(|c| c.as_str().to_string());
    }
    if let Some(m) = cf_slug.captures(html) {
        entry.curseforge_slug = m.get(1).map(|c| c.as_str().to_string());
    }
    if let Some(m) = mr_id.captures(html) {
        entry.modrinth_project_id = m.get(1).map(|c| c.as_str().to_string());
    }
    entry
}

async fn fetch_mcmod_platform_links(mcmod_id: i64) -> Option<McmodCacheEntry> {
    let key = mcmod_id.to_string();
    let mut store = load_mcmod_cache();
    if let Some(existing) = store.entries.get(&key) {
        if now_unix().saturating_sub(existing.fetched_at) < MCMOD_CACHE_TTL_SECS {
            return Some(existing.clone());
        }
    }
    let client = shared_client().await;
    let url = format!("https://www.mcmod.cn/class/{}.html", mcmod_id);
    let response = client.get(&url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let html = response.text().await.ok()?;
    let entry = parse_mcmod_html(&html);
    store.entries.insert(key, entry.clone());
    save_mcmod_cache(&store);
    Some(entry)
}

fn platform_ref_from_mcmod_entry(entry: &McmodCacheEntry) -> Option<PlatformRef> {
    if let Some(slug) = entry.modrinth_slug.clone() {
        return Some(PlatformRef {
            kind: PlatformKind::Modrinth,
            slug,
            modrinth_project_id: entry.modrinth_project_id.clone(),
            curseforge_mod_id: None,
        });
    }
    if let Some(id) = entry.modrinth_project_id.clone() {
        return Some(PlatformRef {
            kind: PlatformKind::Modrinth,
            slug: id.clone(),
            modrinth_project_id: Some(id),
            curseforge_mod_id: None,
        });
    }
    if let Some(slug) = entry.curseforge_slug.clone() {
        return Some(PlatformRef {
            kind: PlatformKind::CurseForge,
            slug,
            modrinth_project_id: None,
            curseforge_mod_id: entry.curseforge_mod_id,
        });
    }
    None
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

    if jar_path.is_file() {
        if let Some(sha1) = file_sha1_hex(jar_path) {
            if let Some(pref) = lookup_modrinth_by_sha1(&mr, &sha1).await {
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
    }

    for pref in platform_refs_from_mod_info(mod_info) {
        if let Some(r) = platform_ref_to_resolved(&mr, &cf, &pref).await {
            return Some(r);
        }
    }

    let mod_id = mod_info.mod_id.trim();
    if !mod_id.is_empty() {
        if let Some(r) = resolve_from_modrinth_slug(&mr, mod_id).await {
            return Some(r);
        }
        if let Some(r) = resolve_from_curseforge_slug(&cf, mod_id).await {
            return Some(r);
        }
    }

    if let Some(hint) = lookup_moddata_platform_hint(&mod_info.mod_id, &mod_info.name) {
        let pref_mr = PlatformRef {
            kind: PlatformKind::Modrinth,
            slug: hint.slug.clone(),
            modrinth_project_id: None,
            curseforge_mod_id: None,
        };
        if let Some(r) = platform_ref_to_resolved(&mr, &cf, &pref_mr).await {
            return Some(r);
        }
        let pref_cf = PlatformRef {
            kind: PlatformKind::CurseForge,
            slug: hint.slug.clone(),
            modrinth_project_id: None,
            curseforge_mod_id: None,
        };
        if let Some(r) = platform_ref_to_resolved(&mr, &cf, &pref_cf).await {
            return Some(r);
        }

        if let Some(mcmod_id) = hint.mcmod_id {
            if let Some(entry) = fetch_mcmod_platform_links(mcmod_id).await {
                if let Some(pref) = platform_ref_from_mcmod_entry(&entry) {
                    if let Some(r) = platform_ref_to_resolved(&mr, &cf, &pref).await {
                        return Some(r);
                    }
                }
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
            });
        }
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
            });
        }
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
    let preferred = versions
        .iter()
        .find(|v| v.release_type == "release")
        .or_else(|| versions.first());
    let pick = preferred?;
    Some(ModSearchResult {
        source: platform.source.clone(),
        mod_id: platform.slug.clone(),
        slug: platform.slug.clone(),
        title: platform.title.clone(),
        download_url: Some(pick.download_url.clone()),
        file_name: Some(pick.file_name.clone()),
        mc_versions: vec![mc_version.to_string()],
        loaders: pick.loaders.clone(),
        version_number: Some(pick.version_number.clone()),
    })
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
    fn parse_mcmod_html_fixture() {
        let html = r#"
        <div>Modrinth Project ID: qa2H4BS9</div>
        <a href="https://www.curseforge.com/minecraft/mc-mods/jei">CF</a>
        "#;
        let entry = parse_mcmod_html(html);
        assert_eq!(entry.modrinth_project_id.as_deref(), Some("qa2H4BS9"));
        assert_eq!(entry.curseforge_slug.as_deref(), Some("jei"));
    }
}
