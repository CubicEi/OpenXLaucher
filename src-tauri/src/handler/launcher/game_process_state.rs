use crate::handler::game_dir::game_dirs_equal;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// Tracked Minecraft client process (multi-instance registry keyed by pid).
pub(crate) struct GameProcess {
    pub pid: u32,
    pub fully_started: bool,
    pub termination_requested: bool,
    /// Minecraft version string used for mod-update backup success counting.
    pub minecraft_version: String,
    /// Canonical `--game-dir` for this instance (mod update guards).
    pub game_dir: String,
    /// Display label for UI (usually version / instance name).
    pub display_name: String,
    /// Monotonic order for "most recent" kill fallback.
    pub started_seq: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningGameInstance {
    pub pid: u32,
    pub game_dir: String,
    pub display_name: String,
    pub fully_started: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningGameState {
    pub running: bool,
    pub instances: Vec<RunningGameInstance>,
    /// Compatibility: first matching / any running instance dir.
    pub game_dir: Option<String>,
    pub pid: Option<u32>,
}

pub(crate) type GameProcessMap = HashMap<u32, GameProcess>;

pub(crate) fn game_process_store() -> &'static Mutex<GameProcessMap> {
    static STORE: OnceLock<Mutex<GameProcessMap>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_started_seq(store: &GameProcessMap) -> u64 {
    store
        .values()
        .map(|p| p.started_seq)
        .max()
        .unwrap_or(0)
        .saturating_add(1)
}

pub fn is_game_running_for_dir(instance_dir: &str) -> bool {
    let target = instance_dir.trim();
    if target.is_empty() {
        return false;
    }
    let store = game_process_store().lock();
    match store {
        Ok(store) => store
            .values()
            .any(|process| game_dirs_equal(&process.game_dir, target)),
        Err(_) => false,
    }
}

#[tauri::command]
pub fn get_running_game_state() -> RunningGameState {
    let store = game_process_store().lock();
    match store {
        Ok(store) => {
            let mut instances: Vec<RunningGameInstance> = store
                .values()
                .map(|process| RunningGameInstance {
                    pid: process.pid,
                    game_dir: process.game_dir.clone(),
                    display_name: process.display_name.clone(),
                    fully_started: process.fully_started,
                })
                .collect();
            instances.sort_by_key(|i| {
                store
                    .get(&i.pid)
                    .map(|p| p.started_seq)
                    .unwrap_or(0)
            });
            let first = instances.first();
            RunningGameState {
                running: !instances.is_empty(),
                game_dir: first.map(|i| i.game_dir.clone()),
                pid: first.map(|i| i.pid),
                instances,
            }
        }
        Err(_) => RunningGameState {
            running: false,
            instances: Vec::new(),
            game_dir: None,
            pid: None,
        },
    }
}

pub(crate) fn insert_process(
    store: &mut GameProcessMap,
    mut process: GameProcess,
) -> Result<(), String> {
    if store.contains_key(&process.pid) {
        return Err(format!("游戏进程 PID {} 已在登记表中", process.pid));
    }
    if process.started_seq == 0 {
        process.started_seq = next_started_seq(store);
    }
    store.insert(process.pid, process);
    Ok(())
}

pub(crate) fn clear_process_if_pid(store: &mut GameProcessMap, pid: u32) -> bool {
    store.remove(&pid).is_some()
}

/// Claim termination for `pid`, or the most recently started process when `pid` is None.
pub(crate) fn claim_termination_request(
    store: &mut GameProcessMap,
    pid: Option<u32>,
) -> Result<(u32, bool), String> {
    let target_pid = match pid {
        Some(p) => p,
        None => store
            .values()
            .max_by_key(|p| p.started_seq)
            .map(|p| p.pid)
            .ok_or_else(|| "当前没有运行中的游戏进程".to_string())?,
    };

    let process = store
        .get_mut(&target_pid)
        .ok_or_else(|| format!("未找到运行中的游戏进程 (PID {})", target_pid))?;
    if process.termination_requested {
        return Err(format!("游戏进程 (PID {}) 正在终止", process.pid));
    }

    process.termination_requested = true;
    Ok((process.pid, process.fully_started))
}

pub(crate) fn reset_termination_request_if_pid(store: &mut GameProcessMap, pid: u32) {
    if let Some(process) = store.get_mut(&pid) {
        process.termination_requested = false;
    }
}

pub(crate) fn mark_fully_started_if_pid(store: &mut GameProcessMap, pid: u32) -> bool {
    if let Some(process) = store.get_mut(&pid) {
        process.fully_started = true;
        true
    } else {
        false
    }
}
