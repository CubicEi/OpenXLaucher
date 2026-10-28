//! Unified version-install events + optional legacy dual-emit.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::stages::stage_label;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskRole {
    Download,
    Install,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProgressMode {
    Percent,
    Indeterminate,
}

#[derive(Debug, Clone, Serialize)]
pub struct VersionInstallProgressPayload {
    pub session_id: String,
    pub task_id: u64,
    pub role: TaskRole,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
    pub stage: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub downloaded: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    pub progress_mode: ProgressMode,
}

#[derive(Debug, Clone, Serialize)]
pub struct VersionInstallFinishedPayload {
    pub session_id: String,
    pub task_id: u64,
    pub role: TaskRole,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VersionInstallSessionStartedPayload {
    pub session_id: String,
    pub download_task_id: u64,
    pub install_task_id: u64,
    pub display_name: String,
    pub plan_kind: String,
}

/// Which legacy event family to dual-emit for the download task during transition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LegacyEventFamily {
    Combined,
    Vanilla,
    Forge,
    NeoForge,
    Fabric,
    Quilt,
    LiteLoader,
    OptiFine,
    Modpack,
    None,
}

impl LegacyEventFamily {
    pub fn progress_event(self) -> Option<&'static str> {
        match self {
            Self::Combined => Some("combined-download-progress"),
            Self::Vanilla => Some("download-progress"),
            Self::Forge => Some("forge-download-progress"),
            Self::NeoForge => Some("neoforge-download-progress"),
            Self::Fabric => Some("fabric-download-progress"),
            Self::Quilt => Some("quilt-download-progress"),
            Self::LiteLoader => Some("liteloader-download-progress"),
            Self::OptiFine => Some("optifine-download-progress"),
            Self::Modpack => Some("modpack-progress"),
            Self::None => None,
        }
    }

    pub fn finished_event(self) -> Option<&'static str> {
        match self {
            Self::Combined => Some("combined-download-finished"),
            Self::Vanilla => Some("download-finished"),
            Self::Forge => Some("forge-download-finished"),
            Self::NeoForge => Some("neoforge-download-finished"),
            Self::Fabric => Some("fabric-download-finished"),
            Self::Quilt => Some("quilt-download-finished"),
            Self::LiteLoader => Some("liteloader-download-finished"),
            Self::OptiFine => Some("optifine-download-finished"),
            Self::Modpack => Some("modpack-finished"),
            Self::None => None,
        }
    }
}

#[derive(Clone, Serialize)]
struct LegacyProgressPayload {
    task_id: u64,
    percent: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    stage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    downloaded: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    speed: Option<f64>,
    // modpack extras
    #[serde(skip_serializing_if = "Option::is_none")]
    total_files: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    downloaded_files: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_file: Option<String>,
}

#[derive(Clone, Serialize)]
struct LegacyFinishedPayload {
    task_id: u64,
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    failed_count: Option<usize>,
    // modpack
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    instance_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_count: Option<usize>,
}

pub fn emit_session_started(app: &AppHandle, payload: &VersionInstallSessionStartedPayload) {
    let _ = app.emit("version-install-session-started", payload);
}

pub fn emit_download_progress(
    app: &AppHandle,
    session_id: &str,
    download_task_id: u64,
    percent: f64,
    stage: &str,
    speed: Option<f64>,
    downloaded: Option<u64>,
    message: Option<String>,
    legacy: LegacyEventFamily,
) {
    let label = stage_label(stage);
    let detail = message.clone().filter(|m| !m.is_empty() && m.as_str() != label.as_str());
    let stage_text = match (&label, &detail) {
        (l, Some(d)) if !l.is_empty() => Some(format!("{} · {}", l, d)),
        (l, _) if !l.is_empty() => Some(l.clone()),
        (_, Some(d)) => Some(d.clone()),
        _ => None,
    };
    super::session::record_download_progress(
        session_id,
        percent,
        stage_text.clone(),
        detail.clone().or(stage_text.clone()),
        speed,
        downloaded,
    );
    let payload = VersionInstallProgressPayload {
        session_id: session_id.to_string(),
        task_id: download_task_id,
        role: TaskRole::Download,
        percent: Some(percent),
        stage: stage.to_string(),
        stage_label: Some(label.clone()),
        message: message.clone(),
        speed,
        downloaded,
        total: None,
        progress_mode: ProgressMode::Percent,
    };
    let _ = app.emit("version-install-progress", &payload);

    if let Some(ev) = legacy.progress_event() {
        let current_file = message.clone().filter(|m| !m.is_empty() && m.as_str() != label);
        let legacy_payload = LegacyProgressPayload {
            task_id: download_task_id,
            percent,
            stage: Some(label),
            message: message.clone(),
            downloaded,
            speed,
            total_files: None,
            downloaded_files: None,
            current_file,
        };
        let _ = app.emit(ev, legacy_payload);
    }
}

pub fn emit_install_progress(
    app: &AppHandle,
    session_id: &str,
    install_task_id: u64,
    stage: &str,
    message: Option<String>,
) {
    let label = stage_label(stage);
    let detail = message.clone().filter(|m| !m.is_empty() && m.as_str() != label.as_str());
    let stage_text = match (&label, &detail) {
        (l, Some(d)) if !l.is_empty() => Some(format!("{} · {}", l, d)),
        (l, _) if !l.is_empty() => Some(l.clone()),
        (_, Some(d)) => Some(d.clone()),
        _ => None,
    };
    super::session::record_install_progress(session_id, stage_text.clone(), detail.or(stage_text));
    let payload = VersionInstallProgressPayload {
        session_id: session_id.to_string(),
        task_id: install_task_id,
        role: TaskRole::Install,
        percent: None,
        stage: stage.to_string(),
        stage_label: Some(label),
        message,
        speed: None,
        downloaded: None,
        total: None,
        progress_mode: ProgressMode::Indeterminate,
    };
    let _ = app.emit("version-install-progress", &payload);
}

pub fn emit_task_finished(
    app: &AppHandle,
    session_id: &str,
    task_id: u64,
    role: TaskRole,
    success: bool,
    error: Option<String>,
    instance_name: Option<String>,
    legacy: LegacyEventFamily,
) {
    let cancelled = !success
        && error
            .as_deref()
            .is_some_and(|e| e == "已取消" || e.eq_ignore_ascii_case("cancelled"));
    super::session::record_role_finished(
        session_id,
        matches!(role, TaskRole::Download),
        success,
        cancelled,
    );
    let payload = VersionInstallFinishedPayload {
        session_id: session_id.to_string(),
        task_id,
        role,
        success,
        error: error.clone(),
        instance_name: instance_name.clone(),
    };
    let _ = app.emit("version-install-finished", &payload);

    if role == TaskRole::Download {
        if let Some(ev) = legacy.finished_event() {
            if legacy == LegacyEventFamily::Modpack {
                let _ = app.emit(
                    ev,
                    LegacyFinishedPayload {
                        task_id,
                        success,
                        error: None,
                        failed_count: None,
                        message: Some(if success {
                            "整合包安装完成".to_string()
                        } else {
                            error.clone().unwrap_or_else(|| "安装失败".to_string())
                        }),
                        instance_name,
                        file_count: None,
                    },
                );
            } else {
                let _ = app.emit(
                    ev,
                    LegacyFinishedPayload {
                        task_id,
                        success,
                        error,
                        failed_count: if matches!(legacy, LegacyEventFamily::Vanilla) {
                            Some(0)
                        } else {
                            None
                        },
                        message: None,
                        instance_name: None,
                        file_count: None,
                    },
                );
            }
        }
    }
}
