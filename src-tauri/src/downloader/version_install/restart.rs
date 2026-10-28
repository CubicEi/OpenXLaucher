//! Pending version-install plans across launcher restart (legacy snapshot file cleanup).
//! Theme-color restart cancels + rolls back instead of resuming; this module only clears
//! or drains any leftover snapshot file.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::app_paths::portable_config_dir;

use super::plan::VersionInstallPlanInput;

const SNAPSHOT_FILE: &str = "pending-restart-sessions.json";

#[derive(Debug, Serialize, Deserialize)]
struct RestartSnapshot {
    plans: Vec<VersionInstallPlanInput>,
}

fn snapshot_path() -> PathBuf {
    portable_config_dir().join(SNAPSHOT_FILE)
}

pub fn take_pending_restart_plans() -> Vec<VersionInstallPlanInput> {
    let path = snapshot_path();
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let _ = std::fs::remove_file(&path);
    let Ok(snapshot) = serde_json::from_str::<RestartSnapshot>(&raw) else {
        return Vec::new();
    };
    snapshot.plans
}

pub fn clear_pending_restart_plans() {
    let _ = std::fs::remove_file(snapshot_path());
}
