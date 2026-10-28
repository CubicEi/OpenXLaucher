//! Tracks paths created by a session so failure/cancel can roll back safely.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Default)]
pub struct RollbackLedger {
    /// Paths that existed before the session started (must not delete).
    pre_existing: Mutex<HashSet<PathBuf>>,
    /// Paths created or claimed by this session (safe to delete on rollback).
    created: Mutex<HashSet<PathBuf>>,
    session_temp: Mutex<Option<PathBuf>>,
}

impl RollbackLedger {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_session_temp(&self, path: PathBuf) {
        if let Ok(mut g) = self.session_temp.lock() {
            *g = Some(path);
        }
    }

    pub fn mark_pre_existing(&self, path: impl AsRef<Path>) {
        if let Ok(mut g) = self.pre_existing.lock() {
            g.insert(path.as_ref().to_path_buf());
        }
    }

    pub fn mark_created(&self, path: impl AsRef<Path>) {
        let p = path.as_ref().to_path_buf();
        if let Ok(pre) = self.pre_existing.lock() {
            if pre.contains(&p) {
                return;
            }
        }
        if let Ok(mut g) = self.created.lock() {
            g.insert(p);
        }
    }

    pub fn is_pre_existing(&self, path: &Path) -> bool {
        self.pre_existing
            .lock()
            .ok()
            .is_some_and(|g| g.contains(&path.to_path_buf()))
    }

    /// Snapshot existing version dirs under minecraft/versions.
    pub fn snapshot_versions_root(&self, minecraft_path: &Path) {
        let versions = minecraft_path.join("versions");
        if !versions.is_dir() {
            return;
        }
        if let Ok(entries) = std::fs::read_dir(&versions) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    self.mark_pre_existing(p);
                }
            }
        }
    }

    pub fn rollback(&self) {
        if let Ok(created) = self.created.lock() {
            for path in created.iter() {
                if let Ok(pre) = self.pre_existing.lock() {
                    if pre.contains(path) {
                        continue;
                    }
                }
                if path.is_dir() {
                    let _ = std::fs::remove_dir_all(path);
                    println!("[VersionInstall] rollback deleted dir {}", path.display());
                } else if path.is_file() {
                    let _ = std::fs::remove_file(path);
                    println!("[VersionInstall] rollback deleted file {}", path.display());
                }
            }
        }
        if let Ok(temp) = self.session_temp.lock() {
            if let Some(ref t) = *temp {
                if t.exists() {
                    let _ = std::fs::remove_dir_all(t);
                    println!(
                        "[VersionInstall] rollback deleted session temp {}",
                        t.display()
                    );
                }
            }
        }
    }

    pub fn cleanup_temp_only(&self) {
        if let Ok(temp) = self.session_temp.lock() {
            if let Some(ref t) = *temp {
                if t.exists() {
                    let _ = std::fs::remove_dir_all(t);
                }
            }
        }
    }
}
