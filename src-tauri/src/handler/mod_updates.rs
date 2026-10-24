//! Mod update check / replace flow (plan §6 / §6.1).
//!
//! Flow:
//! 1. Parse local jars → Modrinth then CurseForge → filter by MC version + loader
//! 2. Download latest to temp
//! 3. Move replaced mod into cache library with old-version backup tagging
//! 4. Copy new mod into mods folder; clear temp
//! 5. After 5 successful game exits (code 0) for that backup entry, delete it

use crate::handler::cache_paths::{
    get_cache_dir_for_version, get_mod_cache_dir, parse_mod_loader, parse_resource_kind,
    CacheResourceKind,
};
use crate::handler::diagnostics::{download_file, ModSearchResult};
use crate::handler::game_dir::canonical_game_dir;
use crate::handler::launcher::game_process_state::is_game_running_for_dir;
use crate::handler::mod_update_locks::{begin_mod_update, end_mod_update, instance_dir_key};
use crate::handler::mod_file_registry::register_file_at_path;
use crate::handler::mod_parser::{parse_mods_in_dir, ModInfo};
use crate::handler::mod_platform::{
    file_sha1_hex, list_compatible_versions, pick_update_if_newer,
    resolve_installed_file, resolve_installed_file_on_platform, I18N_MOD_UPDATE_HASH_MISS,
    I18N_MOD_UPDATE_NETWORK_UNREACHABLE, InstalledFileSnapshot, ModRemoteVersionsResponse,
};
use crate::handler::mod_platform_probe::ModPlatformKind;
use crate::handler::mod_platform_probe::platform_try_order;
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
    /// Canonical instance game directory (`--game-dir`).
    game_dir: String,
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

fn assert_can_update_instance(instance_dir: &str) -> Result<(), String> {
    if is_game_running_for_dir(instance_dir) {
        return Err("该游戏实例正在运行，请先关闭游戏后再更新模组".to_string());
    }
    Ok(())
}

struct ModUpdateLockGuard {
    instance_dir: String,
}

impl ModUpdateLockGuard {
    fn acquire(instance_dir: &str) -> Result<Self, String> {
        assert_can_update_instance(instance_dir)?;
        begin_mod_update(instance_dir)?;
        Ok(Self {
            instance_dir: instance_dir.to_string(),
        })
    }
}

impl Drop for ModUpdateLockGuard {
    fn drop(&mut self) {
        end_mod_update(&self.instance_dir);
    }
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

fn parse_update_resource_kind(resource_kind: &str) -> Result<CacheResourceKind, String> {
    parse_resource_kind(resource_kind)
}

fn effective_loader_for_kind(kind: CacheResourceKind, loader: &str) -> Result<String, String> {
    if kind == CacheResourceKind::Mod {
        let trimmed = loader.trim();
        if trimmed.is_empty() {
            return Err("缺少模组加载器".to_string());
        }
        return Ok(trimmed.to_string());
    }
    Ok(String::new())
}

fn backup_cache_dir_for_kind(
    kind: CacheResourceKind,
    mc_version: &str,
    loader: &str,
) -> Result<PathBuf, String> {
    if kind == CacheResourceKind::Mod {
        let loader_kind = parse_mod_loader(loader)?;
        get_mod_cache_dir(mc_version, loader_kind)
    } else {
        get_cache_dir_for_version(kind, mc_version)
    }
}

fn list_updatable_file_names(resource_dir: &Path) -> Vec<String> {
    let mut names = Vec::new();
    if let Ok(entries) = fs::read_dir(resource_dir) {
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            let path = entry.path();
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase());
            if matches!(ext.as_deref(), Some("jar") | Some("zip") | Some("litemod")) {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    names.push(name.to_string());
                }
            }
        }
    }
    names.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    names
}

async fn find_latest_for_mod(
    jar_path: &Path,
    try_order: &[ModPlatformKind],
    mc_version: &str,
    loader: &str,
) -> Option<(InstalledFileSnapshot, ModSearchResult)> {
    for kind in try_order {
        let Some(snapshot) = resolve_installed_file_on_platform(jar_path, *kind).await else {
            continue;
        };
        if let Some(remote) = pick_update_if_newer(jar_path, &snapshot, mc_version, loader).await {
            return Some((snapshot, remote));
        }
    }
    None
}

async fn list_remote_versions_impl(
    instance_dir: &Path,
    subdir: &str,
    file_name: &str,
    mc_version: &str,
    loader: &str,
) -> Result<ModRemoteVersionsResponse, String> {
    if mc_version.is_empty() {
        return Err("缺少 Minecraft 版本".to_string());
    }
    let file_path = instance_dir.join(subdir).join(file_name);
    if !file_path.is_file() {
        return Err(format!("文件不存在: {}", file_name));
    }
    let try_order = platform_try_order()
        .await
        .map_err(|_| I18N_MOD_UPDATE_NETWORK_UNREACHABLE.to_string())?;
    let installed = resolve_installed_file(&file_path, &try_order).await;
    if let Some(snapshot) = installed.as_ref() {
        let platform = crate::handler::mod_platform::ResolvedPlatform {
            source: snapshot.source.clone(),
            slug: snapshot.slug.clone(),
            title: snapshot.title.clone(),
        };
        let versions = list_compatible_versions(&platform, mc_version, loader).await;
        let empty = versions.is_empty();
        return Ok(ModRemoteVersionsResponse {
            resolved: Some(platform),
            installed: installed.clone(),
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
        installed: None,
        versions: Vec::new(),
        message: Some(I18N_MOD_UPDATE_HASH_MISS.to_string()),
    })
}

#[tauri::command]
pub async fn list_resource_remote_versions(
    instance_dir: String,
    file_name: String,
    mc_version: String,
    loader: String,
    resource_kind: String,
) -> Result<ModRemoteVersionsResponse, String> {
    let kind = parse_update_resource_kind(&resource_kind)?;
    let mc_version = mc_version.trim();
    let loader = effective_loader_for_kind(kind, loader.trim())?;
    let subdir = kind.dir_name();
    list_remote_versions_impl(
        Path::new(&instance_dir),
        subdir,
        &file_name,
        mc_version,
        &loader,
    )
    .await
}

#[tauri::command]
pub async fn list_mod_remote_versions(
    instance_dir: String,
    file_name: String,
    mc_version: String,
    loader: String,
) -> Result<ModRemoteVersionsResponse, String> {
    list_resource_remote_versions(instance_dir, file_name, mc_version, loader, "mod".to_string())
        .await
}

fn to_update_info_from_file(
    file_name: &str,
    snapshot: &InstalledFileSnapshot,
    remote: &ModSearchResult,
) -> Option<ModUpdateInfo> {
    let new_version = remote.version_number.as_ref()?;
    let download_url = remote.download_url.as_ref()?;
    let new_file_name = remote.file_name.as_ref()?;
    Some(ModUpdateInfo {
        file_name: file_name.to_string(),
        mod_id: remote.slug.clone(),
        mod_name: if snapshot.title.is_empty() {
            remote.title.clone()
        } else {
            snapshot.title.clone()
        },
        current_version: snapshot.version_number.clone(),
        new_version: new_version.clone(),
        source: remote.source.clone(),
        download_url: download_url.clone(),
        new_file_name: new_file_name.clone(),
        slug: remote.slug.clone(),
    })
}

fn to_update_info(
    mod_info: &ModInfo,
    snapshot: &InstalledFileSnapshot,
    remote: &ModSearchResult,
) -> Option<ModUpdateInfo> {
    let new_version = remote.version_number.as_ref()?;
    let download_url = remote.download_url.as_ref()?;
    let new_file_name = remote.file_name.as_ref()?;
    Some(ModUpdateInfo {
        file_name: mod_info.file_name.clone(),
        mod_id: mod_info.mod_id.clone(),
        mod_name: if mod_info.name.is_empty() {
            remote.title.clone()
        } else {
            mod_info.name.clone()
        },
        current_version: snapshot.version_number.clone(),
        new_version: new_version.clone(),
        source: remote.source.clone(),
        download_url: download_url.clone(),
        new_file_name: new_file_name.clone(),
        slug: remote.slug.clone(),
    })
}

#[tauri::command]
pub async fn check_resource_updates(
    instance_dir: String,
    mc_version: String,
    loader: String,
    resource_kind: String,
) -> Result<Vec<ModUpdateInfo>, String> {
    let kind = parse_update_resource_kind(&resource_kind)?;
    let mc_version = mc_version.trim().to_string();
    if mc_version.is_empty() {
        return Err("缺少 Minecraft 版本".to_string());
    }
    let loader = effective_loader_for_kind(kind, loader.trim())?;

    let resource_dir = PathBuf::from(&instance_dir).join(kind.dir_name());
    if !resource_dir.exists() {
        return Ok(Vec::new());
    }

    let try_order = platform_try_order()
        .await
        .map_err(|_| I18N_MOD_UPDATE_NETWORK_UNREACHABLE.to_string())?;

    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(4));
    let mut handles = Vec::new();

    if kind == CacheResourceKind::Mod {
        let mods = parse_mods_in_dir(resource_dir.to_string_lossy().to_string());
        if mods.is_empty() {
            return Ok(Vec::new());
        }
        for mod_info in mods {
            let permit = sem
                .clone()
                .acquire_owned()
                .await
                .map_err(|e| e.to_string())?;
            let resource_dir = resource_dir.clone();
            let mc_version = mc_version.clone();
            let loader = loader.clone();
            let try_order = try_order.clone();
            handles.push(tokio::spawn(async move {
                let _permit = permit;
                let jar_path = resource_dir.join(&mod_info.file_name);
                if !jar_path.is_file() {
                    return None;
                }
                let (snapshot, remote) =
                    find_latest_for_mod(&jar_path, &try_order, &mc_version, &loader).await?;
                to_update_info(&mod_info, &snapshot, &remote)
            }));
        }
    } else {
        let file_names = list_updatable_file_names(&resource_dir);
        if file_names.is_empty() {
            return Ok(Vec::new());
        }
        for file_name in file_names {
            let permit = sem
                .clone()
                .acquire_owned()
                .await
                .map_err(|e| e.to_string())?;
            let resource_dir = resource_dir.clone();
            let mc_version = mc_version.clone();
            let loader = loader.clone();
            let try_order = try_order.clone();
            handles.push(tokio::spawn(async move {
                let _permit = permit;
                let file_path = resource_dir.join(&file_name);
                if !file_path.is_file() {
                    return None;
                }
                let (snapshot, remote) =
                    find_latest_for_mod(&file_path, &try_order, &mc_version, &loader).await?;
                to_update_info_from_file(&file_name, &snapshot, &remote)
            }));
        }
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

#[tauri::command]
pub async fn check_mods_updates(
    instance_dir: String,
    mc_version: String,
    loader: String,
) -> Result<Vec<ModUpdateInfo>, String> {
    check_resource_updates(instance_dir, mc_version, loader, "mod".to_string()).await
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
pub fn on_successful_game_exit(minecraft_version: &str, game_dir: &str) {
    let mc = minecraft_version.trim();
    if mc.is_empty() {
        return;
    }
    let game_key = if game_dir.trim().is_empty() {
        String::new()
    } else {
        canonical_game_dir(Path::new(game_dir.trim()))
    };
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
        if !game_key.is_empty() {
            let entry_key = if entry.game_dir.is_empty() {
                String::new()
            } else {
                entry.game_dir.clone()
            };
            if !entry_key.is_empty() && entry_key != game_key {
                return true;
            }
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
    kind: CacheResourceKind,
    update: &ModUpdateInfo,
) -> Result<ModUpdateResult, String> {
    let instance_dir_str = instance_dir.to_string_lossy();
    let _lock = ModUpdateLockGuard::acquire(instance_dir_str.as_ref())?;

    let subdir = kind.dir_name();
    let resource_dir = instance_dir.join(subdir);
    fs::create_dir_all(&resource_dir)
        .map_err(|e| format!("创建 {} 目录失败: {}", subdir, e))?;

    let old_path = resource_dir.join(&update.file_name);
    if !old_path.is_file() {
        return Err(format!("本地文件不存在: {}", update.file_name));
    }

    let temp_dir = std::env::temp_dir().join(format!(
        "openxlauncher-resource-update-{}-{}",
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

    let cache_dir = backup_cache_dir_for_kind(kind, mc_version, loader)?;
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

    let dest_path = resource_dir.join(&update.new_file_name);
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
            "安装新文件失败 ({} → {}): {}",
            temp_file.display(),
            dest_path.display(),
            e
        )
    })?;

    let _ = fs::remove_dir_all(&temp_dir);

    if let Some(sha1) = file_sha1_hex(&dest_path) {
        let _ = register_file_at_path(
            &dest_path,
            &sha1,
            &update.source,
            &update.slug,
            None,
        );
    }

    let game_dir_key = instance_dir_key(instance_dir_str.as_ref());
    let key = backup_entry_key(&update.mod_id, mc_version, &update.new_version);
    let stored_loader = if kind == CacheResourceKind::Mod {
        loader.to_string()
    } else {
        String::new()
    };
    register_backup_entry(BackupEntry {
        key,
        mod_id: update.mod_id.clone(),
        mod_name: update.mod_name.clone(),
        mc_version: mc_version.to_string(),
        game_dir: game_dir_key,
        loader: stored_loader,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
}

#[derive(Clone, Serialize)]
struct UpdateFinishedPayload {
    task_id: u64,
    success: bool,
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
}

fn emit_update_progress(app: &AppHandle, task_id: u64, percent: f64, label: &Option<String>) {
    let _ = app.emit(
        "mod-download-progress",
        UpdateProgressPayload {
            task_id,
            percent,
            label: label.clone(),
        },
    );
}

fn emit_update_finished(
    app: &AppHandle,
    task_id: u64,
    success: bool,
    error: Option<String>,
    label: &Option<String>,
) {
    let _ = app.emit(
        "mod-download-finished",
        UpdateFinishedPayload {
            task_id,
            success,
            error,
            label: label.clone(),
        },
    );
}

async fn run_update_task(
    app: &AppHandle,
    task_id: u64,
    instance_dir: &Path,
    mc_version: &str,
    loader: &str,
    kind: CacheResourceKind,
    update: &ModUpdateInfo,
    display_label: &Option<String>,
) -> Result<(), String> {
    emit_update_progress(app, task_id, 5.0, display_label);
    perform_single_update(instance_dir, mc_version, loader, kind, update).await?;
    emit_update_progress(app, task_id, 100.0, display_label);
    emit_update_finished(app, task_id, true, None, display_label);
    Ok(())
}

#[tauri::command]
pub async fn update_resource(
    app: AppHandle,
    instance_dir: String,
    mc_version: String,
    loader: String,
    resource_kind: String,
    update: ModUpdateInfo,
    display_label: Option<String>,
) -> Result<u64, String> {
    let kind = parse_update_resource_kind(&resource_kind)?;
    let mc_version = mc_version.trim();
    let loader = effective_loader_for_kind(kind, loader.trim())?;
    let task_id = UPDATE_TASK_COUNTER.fetch_add(1, Ordering::SeqCst);

    let result = run_update_task(
        &app,
        task_id,
        Path::new(&instance_dir),
        mc_version,
        &loader,
        kind,
        &update,
        &display_label,
    )
    .await;

    match result {
        Ok(()) => Ok(task_id),
        Err(e) => {
            emit_update_finished(&app, task_id, false, Some(e.clone()), &display_label);
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn update_mod(
    app: AppHandle,
    instance_dir: String,
    mc_version: String,
    loader: String,
    update: ModUpdateInfo,
    display_label: Option<String>,
) -> Result<u64, String> {
    update_resource(
        app,
        instance_dir,
        mc_version,
        loader,
        "mod".to_string(),
        update,
        display_label,
    )
    .await
}

#[tauri::command]
pub async fn update_resources(
    app: AppHandle,
    instance_dir: String,
    mc_version: String,
    loader: String,
    resource_kind: String,
    updates: Vec<ModUpdateInfo>,
    display_label: Option<String>,
) -> Result<u64, String> {
    let kind = parse_update_resource_kind(&resource_kind)?;
    let mc_version = mc_version.trim();
    let loader = effective_loader_for_kind(kind, loader.trim())?;
    let task_id = UPDATE_TASK_COUNTER.fetch_add(1, Ordering::SeqCst);
    let total = updates.len().max(1) as f64;
    let mut first_error: Option<String> = None;
    let instance_path = Path::new(&instance_dir);

    for (idx, update) in updates.into_iter().enumerate() {
        let percent = ((idx as f64) / total) * 100.0;
        emit_update_progress(&app, task_id, percent, &display_label);
        if let Err(e) = perform_single_update(
            instance_path,
            mc_version,
            &loader,
            kind,
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
        emit_update_progress(&app, task_id, 100.0, &display_label);
    }
    emit_update_finished(&app, task_id, success, first_error.clone(), &display_label);
    if let Some(e) = first_error {
        Err(e)
    } else {
        Ok(task_id)
    }
}

#[tauri::command]
pub async fn update_mods(
    app: AppHandle,
    instance_dir: String,
    mc_version: String,
    loader: String,
    updates: Vec<ModUpdateInfo>,
    display_label: Option<String>,
) -> Result<u64, String> {
    update_resources(
        app,
        instance_dir,
        mc_version,
        loader,
        "mod".to_string(),
        updates,
        display_label,
    )
    .await
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
    fn unique_backup_name_tags_versions() {
        let name = unique_backup_name("sodium-fabric.jar", "0.5.3", "0.5.8");
        assert!(name.contains("backup-from-0.5.3-to-0.5.8"));
        assert!(name.ends_with(".jar"));
    }
}
