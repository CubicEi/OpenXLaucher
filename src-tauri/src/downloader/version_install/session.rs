//! Install session registry, artifact store, task id allocation.

use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::watch;

use super::plan::{ArtifactKind, InstallPlan};
use super::rollback::RollbackLedger;
use super::events::LegacyEventFamily;

static TASK_COUNTER: AtomicU64 = AtomicU64::new(10_000_000);

pub fn next_task_id() -> u64 {
    TASK_COUNTER.fetch_add(1, Ordering::SeqCst)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactState {
    Pending,
    Ready,
    Failed,
}

#[derive(Clone)]
pub struct ArtifactSlot {
    tx: watch::Sender<ArtifactState>,
    rx: watch::Receiver<ArtifactState>,
}

impl ArtifactSlot {
    fn pending() -> Self {
        let (tx, rx) = watch::channel(ArtifactState::Pending);
        Self { tx, rx }
    }

    pub fn mark_ready(&self) {
        let _ = self.tx.send(ArtifactState::Ready);
    }

    pub fn mark_failed(&self) {
        let _ = self.tx.send(ArtifactState::Failed);
    }

    pub async fn wait_ready(&self, cancel: &AtomicBool) -> Result<(), String> {
        let mut rx = self.rx.clone();
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err("已取消".to_string());
            }
            let state = *rx.borrow();
            match state {
                ArtifactState::Ready => return Ok(()),
                ArtifactState::Failed => return Err("依赖下载失败".to_string()),
                ArtifactState::Pending => {}
            }
            tokio::select! {
                changed = rx.changed() => {
                    if changed.is_err() {
                        return Err("依赖通道关闭".to_string());
                    }
                }
                _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {}
            }
        }
    }
}

pub struct ArtifactStore {
    slots: HashMap<ArtifactKind, ArtifactSlot>,
}

impl ArtifactStore {
    pub fn for_plan(plan: &InstallPlan) -> Self {
        let mut slots = HashMap::new();
        for kind in plan.required_artifacts() {
            slots.insert(kind, ArtifactSlot::pending());
        }
        // Always ensure Vanilla slot exists for waiters.
        slots
            .entry(ArtifactKind::Vanilla)
            .or_insert_with(ArtifactSlot::pending);
        Self { slots }
    }

    pub fn get(&self, kind: ArtifactKind) -> Option<&ArtifactSlot> {
        self.slots.get(&kind)
    }

    pub fn mark_ready(&self, kind: ArtifactKind) {
        if let Some(s) = self.slots.get(&kind) {
            s.mark_ready();
        }
    }

    pub fn mark_failed(&self, kind: ArtifactKind) {
        if let Some(s) = self.slots.get(&kind) {
            s.mark_failed();
        }
    }

    pub async fn wait(&self, kind: ArtifactKind, cancel: &AtomicBool) -> Result<(), String> {
        match self.slots.get(&kind) {
            Some(s) => s.wait_ready(cancel).await,
            None => Ok(()), // not required
        }
    }
}

pub struct InstallSession {
    pub session_id: String,
    pub download_task_id: u64,
    pub install_task_id: u64,
    pub plan: InstallPlan,
    /// 版本修改：原 instances 文件夹名（与目标名不同时安装阶段会转移用户数据）
    pub retarget_source_instance: Option<String>,
    pub cancel: Arc<AtomicBool>,
    pub artifacts: ArtifactStore,
    pub ledger: Arc<RollbackLedger>,
    pub staging_root: PathBuf,
    pub minecraft_path: PathBuf,
    pub java_path: Option<String>,
    pub legacy: LegacyEventFamily,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInstallSessionStart {
    pub session_id: String,
    pub download_task_id: u64,
    pub install_task_id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_task_id_compat: Option<u64>,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub java_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveDownloadTaskDto {
    pub task_id: u64,
    pub label: String,
    pub mc_version: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed_bps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_downloaded: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress_mode: Option<String>,
    pub started_at: u64,
}

#[derive(Debug, Clone)]
struct RoleSnapshot {
    status: String,
    percent: Option<f64>,
    stage: Option<String>,
    detail: Option<String>,
    speed: Option<f64>,
    downloaded: Option<u64>,
}

impl RoleSnapshot {
    fn downloading() -> Self {
        Self {
            status: "downloading".into(),
            percent: None,
            stage: None,
            detail: None,
            speed: None,
            downloaded: None,
        }
    }

    fn queued() -> Self {
        Self {
            status: "queued".into(),
            percent: None,
            stage: None,
            detail: Some("等待下载完成".into()),
            speed: None,
            downloaded: None,
        }
    }
}

struct SessionEntry {
    cancel: Arc<AtomicBool>,
    download_task_id: u64,
    install_task_id: u64,
    ledger: Arc<RollbackLedger>,
    display_name: String,
    mc_version: String,
    started_at_ms: u64,
    download: RoleSnapshot,
    install: RoleSnapshot,
}

fn sessions() -> &'static Mutex<HashMap<String, SessionEntry>> {
    static INSTANCE: OnceLock<Mutex<HashMap<String, SessionEntry>>> = OnceLock::new();
    INSTANCE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn task_index() -> &'static Mutex<HashMap<u64, String>> {
    static INSTANCE: OnceLock<Mutex<HashMap<u64, String>>> = OnceLock::new();
    INSTANCE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn register_session(session: &InstallSession) {
    let mc_version = session
        .plan
        .mc_version()
        .unwrap_or("unknown")
        .to_string();
    {
        let mut map = sessions().lock().unwrap();
        map.insert(
            session.session_id.clone(),
            SessionEntry {
                cancel: session.cancel.clone(),
                download_task_id: session.download_task_id,
                install_task_id: session.install_task_id,
                ledger: session.ledger.clone(),
                display_name: session.display_name.clone(),
                mc_version,
                started_at_ms: now_ms(),
                download: RoleSnapshot::downloading(),
                install: RoleSnapshot::queued(),
            },
        );
    }
    {
        let mut idx = task_index().lock().unwrap();
        idx.insert(session.download_task_id, session.session_id.clone());
        idx.insert(session.install_task_id, session.session_id.clone());
    }
}

/// Keep last-known progress so a remounted UI can restore rows.
pub fn record_download_progress(
    session_id: &str,
    percent: f64,
    stage_label: Option<String>,
    detail: Option<String>,
    speed: Option<f64>,
    downloaded: Option<u64>,
) {
    let Ok(mut map) = sessions().lock() else {
        return;
    };
    let Some(entry) = map.get_mut(session_id) else {
        return;
    };
    if entry.download.status == "success"
        || entry.download.status == "error"
        || entry.download.status == "cancelled"
    {
        return;
    }
    entry.download.status = "downloading".into();
    entry.download.percent = Some(percent);
    if let Some(s) = stage_label {
        entry.download.stage = Some(s);
    }
    if let Some(d) = detail {
        entry.download.detail = Some(d);
    }
    entry.download.speed = speed;
    if downloaded.is_some() {
        entry.download.downloaded = downloaded;
    }
}

pub fn record_install_progress(
    session_id: &str,
    stage_label: Option<String>,
    detail: Option<String>,
) {
    let Ok(mut map) = sessions().lock() else {
        return;
    };
    let Some(entry) = map.get_mut(session_id) else {
        return;
    };
    if entry.install.status == "success"
        || entry.install.status == "error"
        || entry.install.status == "cancelled"
    {
        return;
    }
    entry.install.status = "downloading".into();
    if let Some(s) = stage_label {
        entry.install.stage = Some(s);
    }
    if let Some(d) = detail {
        entry.install.detail = Some(d);
    }
}

pub fn record_role_finished(
    session_id: &str,
    role_download: bool,
    success: bool,
    cancelled: bool,
) {
    let Ok(mut map) = sessions().lock() else {
        return;
    };
    let Some(entry) = map.get_mut(session_id) else {
        return;
    };
    let status = if cancelled {
        "cancelled"
    } else if success {
        "success"
    } else {
        "error"
    };
    if role_download {
        entry.download.status = status.into();
        entry.download.speed = None;
        if success {
            entry.download.percent = Some(100.0);
            if entry.install.status == "queued" {
                entry.install.status = "downloading".into();
            }
        }
    } else {
        entry.install.status = status.into();
        if success {
            entry.install.percent = Some(100.0);
        }
    }
}

fn download_label(display_name: &str) -> String {
    let name = display_name.trim();
    let name = if name.is_empty() { "版本" } else { name };
    format!("下载 {} 文件", name)
}

fn install_label(display_name: &str) -> String {
    let name = display_name.trim();
    let name = if name.is_empty() { "版本" } else { name };
    format!("安装 {}", name)
}

/// Active version-install rows for UI remount hydration.
pub fn list_active_version_install_tasks() -> Vec<ActiveDownloadTaskDto> {
    let Ok(map) = sessions().lock() else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(map.len() * 2);
    for (session_id, entry) in map.iter() {
        let stage_or_detail = |snap: &RoleSnapshot| {
            snap.stage
                .clone()
                .or_else(|| snap.detail.clone())
        };
        out.push(ActiveDownloadTaskDto {
            task_id: entry.download_task_id,
            label: download_label(&entry.display_name),
            mc_version: entry.mc_version.clone(),
            status: entry.download.status.clone(),
            progress: entry.download.percent,
            stage: stage_or_detail(&entry.download),
            detail: entry.download.detail.clone(),
            speed_bps: entry.download.speed,
            bytes_downloaded: entry.download.downloaded,
            role: Some("download".into()),
            session_id: Some(session_id.clone()),
            progress_mode: Some("percent".into()),
            started_at: entry.started_at_ms,
        });
        out.push(ActiveDownloadTaskDto {
            task_id: entry.install_task_id,
            label: install_label(&entry.display_name),
            mc_version: entry.mc_version.clone(),
            status: entry.install.status.clone(),
            progress: entry.install.percent,
            stage: stage_or_detail(&entry.install),
            detail: entry.install.detail.clone(),
            speed_bps: None,
            bytes_downloaded: None,
            role: Some("install".into()),
            session_id: Some(session_id.clone()),
            progress_mode: Some("indeterminate".into()),
            started_at: entry.started_at_ms.saturating_add(1),
        });
    }
    out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    out
}

pub fn unregister_session(session_id: &str) {
    let entry = {
        let mut map = sessions().lock().unwrap();
        map.remove(session_id)
    };
    if let Some(e) = entry {
        let mut idx = task_index().lock().unwrap();
        idx.remove(&e.download_task_id);
        idx.remove(&e.install_task_id);
    }
}

pub fn cancel_session_by_id(session_id: &str) -> Result<(), String> {
    let map = sessions().lock().map_err(|e| e.to_string())?;
    if let Some(entry) = map.get(session_id) {
        entry.cancel.store(true, Ordering::SeqCst);
        println!(
            "[VersionInstall] cancel session {} (download={}, install={})",
            session_id, entry.download_task_id, entry.install_task_id
        );
        Ok(())
    } else {
        println!(
            "[VersionInstall] cancel: session {} not found (may have finished)",
            session_id
        );
        Ok(())
    }
}

pub fn cancel_session_by_task_id(task_id: u64) -> Result<(), String> {
    let session_id = {
        let idx = task_index().lock().map_err(|e| e.to_string())?;
        idx.get(&task_id).cloned()
    };
    if let Some(sid) = session_id {
        cancel_session_by_id(&sid)
    } else {
        // Not a version-install task — caller may fall through to legacy maps.
        Err(format!("no version-install session for task {}", task_id))
    }
}

pub fn session_temp_root(session_id: &str) -> PathBuf {
    std::env::temp_dir()
        .join("OpenXLauncher")
        .join("sessions")
        .join(session_id)
}

pub fn build_session(
    plan: InstallPlan,
    retarget_source_instance: Option<String>,
    minecraft_path: PathBuf,
    java_path: Option<String>,
    legacy: LegacyEventFamily,
) -> Result<InstallSession, String> {
    let session_id = uuid::Uuid::new_v4().to_string();
    let download_task_id = next_task_id();
    let install_task_id = next_task_id();
    let display_name = plan.display_name();
    let staging_root = session_temp_root(&session_id);
    std::fs::create_dir_all(&staging_root)
        .map_err(|e| format!("创建会话临时目录失败: {}", e))?;

    let ledger = Arc::new(RollbackLedger::new());
    ledger.set_session_temp(staging_root.clone());
    ledger.snapshot_versions_root(&minecraft_path);

    let artifacts = ArtifactStore::for_plan(&plan);

    Ok(InstallSession {
        session_id,
        download_task_id,
        install_task_id,
        plan,
        retarget_source_instance,
        cancel: Arc::new(AtomicBool::new(false)),
        artifacts,
        ledger,
        staging_root,
        minecraft_path,
        java_path,
        legacy,
        display_name,
    })
}

pub fn to_start_result(session: &InstallSession) -> VersionInstallSessionStart {
    VersionInstallSessionStart {
        session_id: session.session_id.clone(),
        download_task_id: session.download_task_id,
        install_task_id: session.install_task_id,
        download_task_id_compat: Some(session.download_task_id),
        display_name: session.display_name.clone(),
        java_path: session.java_path.clone(),
    }
}
