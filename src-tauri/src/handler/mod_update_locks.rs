//! Per game-directory locks while mod updates are in progress.

use crate::handler::game_dir::canonical_game_dir;
use std::collections::HashSet;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

fn mod_update_locks() -> &'static Mutex<HashSet<String>> {
    static LOCKS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn instance_dir_key(instance_dir: &str) -> String {
    canonical_game_dir(Path::new(instance_dir.trim()))
}

pub fn begin_mod_update(instance_dir: &str) -> Result<(), String> {
    let key = instance_dir_key(instance_dir);
    if key.is_empty() {
        return Err("实例目录无效".to_string());
    }
    let mut locks = mod_update_locks()
        .lock()
        .map_err(|_| "更新锁已损坏".to_string())?;
    if !locks.insert(key.clone()) {
        return Err("该实例已有模组更新任务进行中".to_string());
    }
    Ok(())
}

pub fn end_mod_update(instance_dir: &str) {
    let key = instance_dir_key(instance_dir);
    if key.is_empty() {
        return;
    }
    if let Ok(mut locks) = mod_update_locks().lock() {
        locks.remove(&key);
    }
}

pub fn is_game_dir_mod_update_locked(game_dir_key: &str) -> bool {
    if game_dir_key.is_empty() {
        return false;
    }
    mod_update_locks()
        .lock()
        .map(|locks| locks.contains(game_dir_key))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn begin_end_update_lock() {
        let dir = std::env::temp_dir()
            .join("openx-mod-lock-test")
            .to_string_lossy()
            .to_string();
        end_mod_update(&dir);
        begin_mod_update(&dir).expect("first lock");
        assert!(is_game_dir_mod_update_locked(&instance_dir_key(&dir)));
        assert!(begin_mod_update(&dir).is_err());
        end_mod_update(&dir);
        assert!(!is_game_dir_mod_update_locked(&instance_dir_key(&dir)));
    }
}
