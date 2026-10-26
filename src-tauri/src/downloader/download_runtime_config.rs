use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock, RwLock};
use tokio::sync::Semaphore;

use crate::updater::config::config_dir;

pub const DEFAULT_WORKERS_PER_FILE: usize = 16;
pub const DEFAULT_MAX_TOTAL_WORKERS: usize = 64;
pub const MIN_WORKERS_PER_FILE: usize = 1;
pub const MAX_WORKERS_PER_FILE_CAP: usize = 32;
pub const MIN_FINITE_TOTAL_WORKERS: usize = 1;
pub const MAX_FINITE_TOTAL_WORKERS: usize = 256;
/// `0` means no global worker cap.
pub const UNLIMITED_TOTAL_WORKERS: usize = 0;
const UNLIMITED_SEMAPHORE_PERMITS: usize = 65_536;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadWorkerConfig {
    pub workers_per_file: usize,
    pub max_total_workers: usize,
}

impl Default for DownloadWorkerConfig {
    fn default() -> Self {
        Self {
            workers_per_file: DEFAULT_WORKERS_PER_FILE,
            max_total_workers: DEFAULT_MAX_TOTAL_WORKERS,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct DownloadSettingsFile {
    #[serde(default = "default_workers_per_file")]
    pub workers_per_file: usize,
    #[serde(default = "default_max_total_workers")]
    pub max_total_workers: usize,
    #[serde(default)]
    pub custom_download_directory: Option<String>,
}

fn default_workers_per_file() -> usize {
    DEFAULT_WORKERS_PER_FILE
}

fn default_max_total_workers() -> usize {
    DEFAULT_MAX_TOTAL_WORKERS
}

impl DownloadSettingsFile {
    fn clamp(mut self) -> Self {
        self.workers_per_file = self
            .workers_per_file
            .clamp(MIN_WORKERS_PER_FILE, MAX_WORKERS_PER_FILE_CAP);
        if self.max_total_workers != UNLIMITED_TOTAL_WORKERS {
            self.max_total_workers = self
                .max_total_workers
                .clamp(MIN_FINITE_TOTAL_WORKERS, MAX_FINITE_TOTAL_WORKERS);
            if self.max_total_workers < self.workers_per_file {
                self.max_total_workers = self.workers_per_file;
            }
        }
        self.custom_download_directory = self
            .custom_download_directory
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        self
    }

    fn to_worker_config(&self) -> DownloadWorkerConfig {
        DownloadWorkerConfig {
            workers_per_file: self.workers_per_file,
            max_total_workers: self.max_total_workers,
        }
    }
}

impl Default for DownloadSettingsFile {
    fn default() -> Self {
        Self {
            workers_per_file: DEFAULT_WORKERS_PER_FILE,
            max_total_workers: DEFAULT_MAX_TOTAL_WORKERS,
            custom_download_directory: None,
        }
    }
}

fn settings_path() -> PathBuf {
    PathBuf::from(config_dir()).join("download_settings.json")
}

fn load_file() -> DownloadSettingsFile {
    let path = settings_path();
    if !path.exists() {
        return DownloadSettingsFile::default();
    }
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text)
            .map(DownloadSettingsFile::clamp)
            .unwrap_or_default(),
        Err(_) => DownloadSettingsFile::default(),
    }
}

fn save_file(file: &DownloadSettingsFile) -> Result<(), String> {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(())
}

struct RuntimeState {
    file: DownloadSettingsFile,
    worker_semaphore: Arc<Semaphore>,
    file_connection_semaphore: Arc<Semaphore>,
}

fn semaphore_permits(max_total_workers: usize) -> usize {
    if max_total_workers == UNLIMITED_TOTAL_WORKERS {
        UNLIMITED_SEMAPHORE_PERMITS
    } else {
        max_total_workers
    }
}

fn build_state(file: DownloadSettingsFile) -> RuntimeState {
    let file = file.clamp();
    const SMART_MAX_FILE_CONCURRENCY: usize = 12;
    let worker_permits = semaphore_permits(file.max_total_workers);
    let file_cap = worker_permits.max(SMART_MAX_FILE_CONCURRENCY);
    RuntimeState {
        file,
        worker_semaphore: Arc::new(Semaphore::new(worker_permits)),
        file_connection_semaphore: Arc::new(Semaphore::new(file_cap)),
    }
}

fn runtime() -> &'static RwLock<RuntimeState> {
    static RUNTIME: OnceLock<RwLock<RuntimeState>> = OnceLock::new();
    RUNTIME.get_or_init(|| RwLock::new(build_state(load_file())))
}

pub fn current_download_worker_config() -> DownloadWorkerConfig {
    runtime().read().unwrap().file.to_worker_config()
}

fn write_worker_config(config: DownloadWorkerConfig) -> Result<DownloadWorkerConfig, String> {
    let mut file = runtime().read().unwrap().file.clone();
    file.workers_per_file = config.workers_per_file;
    file.max_total_workers = config.max_total_workers;
    file = file.clamp();
    save_file(&file)?;
    let new_state = build_state(file);
    let out = new_state.file.to_worker_config();
    *runtime().write().unwrap() = new_state;
    Ok(out)
}

pub fn apply_download_worker_config(config: DownloadWorkerConfig) -> Result<DownloadWorkerConfig, String> {
    write_worker_config(config)
}

pub fn worker_semaphore() -> Arc<Semaphore> {
    runtime().read().unwrap().worker_semaphore.clone()
}

pub fn file_connection_semaphore() -> Arc<Semaphore> {
    runtime().read().unwrap().file_connection_semaphore.clone()
}

pub fn workers_for_file_size(size: u64, chunked_threshold: u64) -> usize {
    if size < chunked_threshold {
        return 1;
    }
    current_download_worker_config().workers_per_file
}

pub fn max_workers_per_file_cap() -> usize {
    current_download_worker_config().workers_per_file
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadPrefs {
    pub workers_per_file: usize,
    pub max_total_workers: usize,
    pub custom_download_directory: Option<String>,
}

#[tauri::command]
pub fn get_download_worker_config() -> DownloadWorkerConfig {
    current_download_worker_config()
}

#[tauri::command]
pub fn get_download_prefs() -> DownloadPrefs {
    let file = runtime().read().unwrap().file.clone();
    DownloadPrefs {
        workers_per_file: file.workers_per_file,
        max_total_workers: file.max_total_workers,
        custom_download_directory: file.custom_download_directory.clone(),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_download_worker_config(
    workers_per_file: usize,
    max_total_workers: usize,
) -> Result<DownloadWorkerConfig, String> {
    apply_download_worker_config(DownloadWorkerConfig {
        workers_per_file,
        max_total_workers,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_custom_download_directory(directory: Option<String>) -> Result<(), String> {
    let mut file = runtime().read().unwrap().file.clone();
    file.custom_download_directory = directory
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    file = file.clamp();
    save_file(&file)?;
    let new_state = build_state(file);
    *runtime().write().unwrap() = new_state;
    Ok(())
}
