//! Mod update check / replace flow (plan §6 / §6.1).
//!
//! Flow:
//! 1. Parse local jars → Modrinth then CurseForge → filter by MC version + loader
//! 2. Download latest to temp
//! 3. Move replaced mod into cache library with old-version backup tagging
//! 4. Copy new mod into mods folder; clear temp
//! 5. After 5 successful game exits (code 0) for that backup entry, delete it

use crate::handler::cache_paths::{get_mod_cache_dir, parse_mod_loader};
use crate::handler::diagnostics::{download_file, ModSearchResult};
use crate::handler::mod_parser::{parse_mod, parse_mods_in_dir, ModInfo};
use crate::handler::mod_platform::{
    fetch_latest_search_result, list_compatible_versions, resolve_mod_platform,
    ModRemoteVersionsResponse,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use log::info;
use tauri::{AppHandle, Emitter};

const SUCCESS_THRESHOLD: u32 = 5;
const TRACKING_FILE_NAME: &str = "mod-update-tracking.json";

static UPDATE_TASK_COUNTER: AtomicU64 = AtomicU64::new(500_000);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModUpdateInfo {
    pub file_name: String,
    pub mod_id: String,
    pub mod_name: String,
    pub current_version: String,
    pub new_version: String,
    pub source: String,
    pub download_url: String,
    pub new_file_name: String,
    pub slug: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModUpdateResult {
    pub mod_id: String,
    pub file_name: String,
    pub success: bool,
    pub message: String,
    pub backup_path: Option<String>,
    pub new_file_name: Option<String>,
}

/// Persisted backup / success-counter entry.
/// Counted separately per (mod_id, mc_version, new_version).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupEntry {
    key: String,
    mod_id: String,
    mod_name: String,
    mc_version: String,
    loader: String,
    old_version: String,
    new_version: String,
    backup_path: String,
    installed_file_name: String,
    success_count: u32,
    created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct TrackingStore {
    entries: Vec<BackupEntry>,
}

fn tracking_store_path() -> Result<PathBuf, String> {
    let cache_root = crate::handler::cache_paths::cache_root_dir()?;
    Ok(cache_root.join(TRACKING_FILE_NAME))
}

fn load_tracking() -> TrackingStore {
    let Ok(path) = tracking_store_path() else {
        return TrackingStore::default();
    };
    let Ok(text) = fs::read_to_string(&path) else {
        return TrackingStore::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn save_tracking(store: &TrackingStore) -> Result<(), String> {
    let path = tracking_store_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| e.to_string())
}

fn tracking_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn backup_entry_key(mod_id: &str, mc_version: &str, new_version: &str) -> String {
    format!(
        "{}@{}@{}",
        mod_id.to_ascii_lowercase(),
        mc_version.trim(),
        new_version.trim()
    )
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn sanitize_tag(s: &str) -> String {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return "unknown".to_string();
    }
    trimmed
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | ' ' => '_',
            _ => c,
        })
        .take(64)
        .collect()
}

fn versions_differ(local: &str, remote: &str) -> bool {
    let local = local.trim();
    let remote = remote.trim();
    if local.is_empty() || remote.is_empty() {
        return !remote.is_empty() && remote != local;
    }
    if local.eq_ignore_ascii_case(remote) {
        return false;
    }
    // Prefer semver when both parse; otherwise treat inequality as "update available"
    // because Modrinth/CF already returned their latest matching release.
    let local_clean = local.trim_start_matches('v');
    let remote_clean = remote.trim_start_matches('v');
    match (
        semver::Version::parse(local_clean),
        semver::Version::parse(remote_clean),
    ) {
        (Ok(l), Ok(r)) => r > l,
        _ => true,
    }
}

async fn find_latest_for_mod(
    mod_info: &ModInfo,
    jar_path: &Path,
    mc_version: &str,
    loader: &str,
) -> Option<ModSearchResult> {
    let platform = resolve_mod_platform(mod_info, jar_path).await?;
    fetch_latest_search_result(&platform, mc_version, loader).await
}

#[tauri::command]
pub async fn list_mod_remote_versions(
    instance_dir: String,
    file_name: String,
    mc_version: String,
    loader: String,
) -> Result<ModRemoteVersionsResponse, String> {
    let mc_version = mc_version.trim();
    let loader = loader.trim();
    if mc_version.is_empty() || loader.is_empty() {
        return Err("缺少 Minecraft 版本或加载器".to_string());
    }
    let jar_path = PathBuf::from(&instance_dir).join("mods").join(&file_name);
    if !jar_path.is_file() {
        return Err(format!("模组文件不存在: {}", file_name));
    }
    let mod_info = parse_mod(jar_path.to_string_lossy().to_string())
        .map_err(|e| e.to_string())?;
    let resolved = resolve_mod_platform(&mod_info, &jar_path).await;
    if let Some(platform) = resolved.as_ref() {
        let versions = list_compatible_versions(platform, mc_version, loader).await;
        let empty = versions.is_empty();
        return Ok(ModRemoteVersionsResponse {
            resolved: Some(platform.clone()),
            versions,
            message: if empty {
                Some("未找到与当前实例兼容的远程版本".to_string())
            } else {
                None
            },
        });
    }
    Ok(ModRemoteVersionsResponse {
        resolved: None,
        versions: Vec::new(),
        message: Some("未能识别 Modrinth / CurseForge 项目（可尝试在百科或 jar 主页链接中核对）".to_string()),
    })
}

fn to_update_info(mod_info: &ModInfo, remote: &ModSearchResult) -> Option<ModUpdateInfo> {
    let new_version = remote.version_number.as_ref()?;
    let download_url = remote.download_url.as_ref()?;
    let new_file_name = remote.file_name.as_ref()?;
    if !versions_differ(&mod_info.version, new_version) {
        return None;
    }
    Some(ModUpdateInfo {
        file_name: mod_info.file_name.clone(),
        mod_id: mod_info.mod_id.clone(),
        mod_name: if mod_info.name.is_empty() {
            remote.title.clone()
        } else {
            mod_info.name.clone()
        },
        current_version: mod_info.version.clone(),
        new_version: new_version.clone(),
        source: remote.source.clone(),
        download_url: download_url.clone(),
        new_file_name: new_file_name.clone(),
        slug: remote.slug.clone(),
    })
}

#[tauri::command]
pub async fn check_mods_updates(
    instance_dir: String,
    mc_version: String,
    loader: String,
) -> Result<Vec<ModUpdateInfo>, String> {
    let mods_dir = PathBuf::from(&instance_dir).join("mods");
    if !mods_dir.exists() {
        return Ok(Vec::new());
    }
    let mods = parse_mods_in_dir(mods_dir.to_string_lossy().to_string());
    if mods.is_empty() {
        return Ok(Vec::new());
    }

    let mc_version = mc_version.trim().to_string();
    let loader = loader.trim().to_string();
    if mc_version.is_empty() {
        return Err("缺少 Minecraft 版本".to_string());
    }
    if loader.is_empty() {
        return Err("缺少模组加载器".to_string());
    }

    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(4));
    let mut handles = Vec::new();

    for mod_info in mods {
        let permit = sem
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| e.to_string())?;
        let mods_dir = mods_dir.clone();
        let mc_version = mc_version.clone();
        let loader = loader.clone();
        handles.push(tokio::spawn(async move {
            let _permit = permit;
            let jar_path = mods_dir.join(&mod_info.file_name);
            if !jar_path.is_file() {
                return None;
            }
            let remote = find_latest_for_mod(&mod_info, &jar_path, &mc_version, &loader).await?;
            to_update_info(&mod_info, &remote)
        }));
    }

    let mut updates = Vec::new();
    for handle in handles {
        match handle.await {
            Ok(Some(info)) => updates.push(info),
            Ok(None) => {}
            Err(e) => eprintln!("[mod-updates] check task failed: {}", e),
        }
    }
    updates.sort_by(|a, b| a.mod_name.to_lowercase().cmp(&b.mod_name.to_lowercase()));
    Ok(updates)
}

fn unique_backup_name(original: &str, old_version: &str, new_version: &str) -> String {
    let path = Path::new(original);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| original.to_string());
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_else(|| ".jar".to_string());
    format!(
        "{}.backup-from-{}-to-{}{}",
        stem,
        sanitize_tag(old_version),
        sanitize_tag(new_version),
        ext
    )
}

fn register_backup_entry(entry: BackupEntry) -> Result<(), String> {
    let _guard = tracking_lock()
        .lock()
        .map_err(|_| "tracking lock poisoned".to_string())?;
    let mut store = load_tracking();
    // Same key (same mod + MC + new version) replaces previous backup record.
    if let Some(existing) = store.entries.iter().find(|e| e.key == entry.key) {
        let old_path = PathBuf::from(&existing.backup_path);
        if old_path.exists() && old_path != PathBuf::from(&entry.backup_path) {
            let _ = fs::remove_file(&old_path);
        }
    }
    store.entries.retain(|e| e.key != entry.key);
    store.entries.push(entry);
    save_tracking(&store)
}

/// Called when a game process exits with return code 0.
pub fn on_successful_game_exit(minecraft_version: &str) {
    let mc = minecraft_version.trim();
    if mc.is_empty() {
        return;
    }
    let Ok(_guard) = tracking_lock().lock() else {
        return;
    };
    let mut store = load_tracking();
    if store.entries.is_empty() {
        return;
    }

    let mut changed = false;
    let mut to_delete: Vec<PathBuf> = Vec::new();
    store.entries.retain_mut(|entry| {
        if entry.mc_version != mc {
            return true;
        }
        entry.success_count = entry.success_count.saturating_add(1);
        changed = true;
        if entry.success_count >= SUCCESS_THRESHOLD {
            to_delete.push(PathBuf::from(&entry.backup_path));
            false
        } else {
            true
        }
    });

    for path in to_delete {
        if path.exists() {
            match fs::remove_file(&path) {
                Ok(()) => info!(
                    "[mod-updates] removed backup after {} successful launches: {}",
                    SUCCESS_THRESHOLD,
                    path.display()
                ),
                Err(e) => eprintln!(
                    "[mod-updates] failed to remove backup {}: {}",
                    path.display(),
                    e
                ),
            }
        }
    }

    if changed {
        let _ = save_tracking(&store);
    }
}

async fn perform_single_update(
    instance_dir: &Path,
    mc_version: &str,
    loader: &str,
    update: &ModUpdateInfo,
) -> Result<ModUpdateResult, String> {
    let mods_dir = instance_dir.join("mods");
    fs::create_dir_all(&mods_dir).map_err(|e| format!("创建 mods 目录失败: {}", e))?;

    let old_path = mods_dir.join(&update.file_name);
    if !old_path.is_file() {
        return Err(format!("本地模组文件不存在: {}", update.file_name));
    }

    let temp_dir = std::env::temp_dir().join(format!(
        "openxlauncher-mod-update-{}-{}",
        sanitize_tag(&update.mod_id),
        now_unix()
    ));
    fs::create_dir_all(&temp_dir).map_err(|e| format!("创建临时目录失败: {}", e))?;

    let temp_file = temp_dir.join(&update.new_file_name);
    let download_result = download_file(&update.download_url, &temp_file).await;
    if let Err(e) = download_result {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(e);
    }

    let loader_kind = parse_mod_loader(loader)?;
    let cache_dir = get_mod_cache_dir(mc_version, loader_kind)?;
    let backup_name = unique_backup_name(
        &update.file_name,
        &update.current_version,
        &update.new_version,
    );
    let mut backup_path = cache_dir.join(&backup_name);
    if backup_path.exists() {
        backup_path = cache_dir.join(format!(
            "{}.{}",
            backup_name.trim_end_matches(".jar").trim_end_matches(".zip"),
            now_unix()
        ));
        if let Some(ext) = Path::new(&backup_name).extension() {
            backup_path.set_extension(ext);
        }
    }

    // Move old mod into cache library (backup).
    match fs::rename(&old_path, &backup_path) {
        Ok(()) => {}
        Err(_) => {
            fs::copy(&old_path, &backup_path).map_err(|e| {
                format!(
                    "备份旧模组失败 ({} → {}): {}",
                    old_path.display(),
                    backup_path.display(),
                    e
                )
            })?;
            fs::remove_file(&old_path).map_err(|e| {
                format!("删除原模组文件失败 {}: {}", old_path.display(), e)
            })?;
        }
    }

    let dest_path = mods_dir.join(&update.new_file_name);
    // If updating in place with same filename, dest was already moved.
    // If different name and dest exists, remove it first.
    if dest_path.exists() && dest_path != old_path {
        fs::remove_file(&dest_path)
            .map_err(|e| format!("无法覆盖已有新文件 {}: {}", dest_path.display(), e))?;
    }

    fs::copy(&temp_file, &dest_path).map_err(|e| {
        // Best-effort restore from backup
        let _ = fs::rename(&backup_path, &old_path);
        format!(
            "安装新模组失败 ({} → {}): {}",
            temp_file.display(),
            dest_path.display(),
            e
        )
    })?;

    let _ = fs::remove_dir_all(&temp_dir);

    let key = backup_entry_key(&update.mod_id, mc_version, &update.new_version);
    register_backup_entry(BackupEntry {
        key,
        mod_id: update.mod_id.clone(),
        mod_name: update.mod_name.clone(),
        mc_version: mc_version.to_string(),
        loader: loader.to_string(),
        old_version: update.current_version.clone(),
        new_version: update.new_version.clone(),
        backup_path: backup_path.to_string_lossy().to_string(),
        installed_file_name: update.new_file_name.clone(),
        success_count: 0,
        created_at: now_unix(),
    })?;

    Ok(ModUpdateResult {
        mod_id: update.mod_id.clone(),
        file_name: update.file_name.clone(),
        success: true,
        message: format!(
            "已更新 {}：{} → {}（来源 {}）",
            update.mod_name, update.current_version, update.new_version, update.source
        ),
        backup_path: Some(backup_path.to_string_lossy().to_string()),
        new_file_name: Some(update.new_file_name.clone()),
    })
}

#[derive(Clone, Serialize)]
struct UpdateProgressPayload {
    task_id: u64,
    percent: f64,
}

#[derive(Clone, Serialize)]
struct UpdateFinishedPayload {
    task_id: u64,
    success: bool,
    error: Option<String>,
}

#[tauri::command]
pub async fn update_mod(
    app: AppHandle,
    instance_dir: String,
    mc_version: String,
    loader: String,
    update: ModUpdateInfo,
) -> Result<u64, String> {
    let task_id = UPDATE_TASK_COUNTER.fetch_add(1, Ordering::SeqCst);
    let _ = app.emit(
        "mod-download-progress",
        UpdateProgressPayload {
            task_id,
            percent: 5.0,
        },
    );

    let result = perform_single_update(
        Path::new(&instance_dir),
        &mc_version,
        &loader,
        &update,
    )
    .await;

    match result {
        Ok(_) => {
            let _ = app.emit(
                "mod-download-progress",
                UpdateProgressPayload {
                    task_id,
                    percent: 100.0,
                },
            );
            let _ = app.emit(
                "mod-download-finished",
                UpdateFinishedPayload {
                    task_id,
                    success: true,
                    error: None,
                },
            );
            Ok(task_id)
        }
        Err(e) => {
            let _ = app.emit(
                "mod-download-finished",
                UpdateFinishedPayload {
                    task_id,
                    success: false,
                    error: Some(e.clone()),
                },
            );
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn update_mods(
    app: AppHandle,
    instance_dir: String,
    mc_version: String,
    loader: String,
    updates: Vec<ModUpdateInfo>,
) -> Result<u64, String> {
    let task_id = UPDATE_TASK_COUNTER.fetch_add(1, Ordering::SeqCst);
    let total = updates.len().max(1) as f64;
    let mut first_error: Option<String> = None;

    for (idx, update) in updates.into_iter().enumerate() {
        let percent = ((idx as f64) / total) * 100.0;
        let _ = app.emit(
            "mod-download-progress",
            UpdateProgressPayload { task_id, percent },
        );
        if let Err(e) = perform_single_update(
            Path::new(&instance_dir),
            &mc_version,
            &loader,
            &update,
        )
        .await
        {
            eprintln!(
                "[mod-updates] update failed for {}: {}",
                update.mod_id, e
            );
            if first_error.is_none() {
                first_error = Some(e);
            }
        }
    }

    let success = first_error.is_none();
    if success {
        let _ = app.emit(
            "mod-download-progress",
            UpdateProgressPayload {
                task_id,
                percent: 100.0,
            },
        );
    }
    let _ = app.emit(
        "mod-download-finished",
        UpdateFinishedPayload {
            task_id,
            success,
            error: first_error.clone(),
        },
    );
    if let Some(e) = first_error {
        Err(e)
    } else {
        Ok(task_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_key_separates_mc_and_new_version() {
        assert_ne!(
            backup_entry_key("sodium", "1.20.1", "0.5.8"),
            backup_entry_key("sodium", "1.21", "0.5.8")
        );
        assert_ne!(
            backup_entry_key("sodium", "1.20.1", "0.5.8"),
            backup_entry_key("sodium", "1.20.1", "0.5.11")
        );
    }

    #[test]
    fn versions_differ_uses_semver_when_possible() {
        assert!(versions_differ("1.0.0", "1.0.1"));
        assert!(!versions_differ("1.0.1", "1.0.1"));
        assert!(!versions_differ("2.0.0", "1.9.9"));
        assert!(versions_differ("1.0", "1.1-beta"));
    }

    #[test]
    fn unique_backup_name_tags_versions() {
        let name = unique_backup_name("sodium-fabric.jar", "0.5.3", "0.5.8");
        assert!(name.contains("backup-from-0.5.3-to-0.5.8"));
        assert!(name.ends_with(".jar"));
    }
}
