use crate::handler::game_dir::game_dirs_equal;
use serde::Serialize;
use std::sync::{Mutex, OnceLock};

/// 全局游戏进程跟踪（单实例）。
pub(crate) struct GameProcess {
    pub pid: u32,
    pub fully_started: bool,
    pub termination_requested: bool,
    /// Minecraft version string used for mod-update backup success counting.
    pub minecraft_version: String,
    /// Canonical `--game-dir` for this instance (mod update guards).
    pub game_dir: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningGameState {
    pub running: bool,
    pub game_dir: Option<String>,
    pub pid: Option<u32>,
}

pub(crate) fn game_process_store() -> &'static Mutex<Option<GameProcess>> {
    static STORE: OnceLock<Mutex<Option<GameProcess>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(None))
}

pub fn is_game_running_for_dir(instance_dir: &str) -> bool {
    let target = instance_dir.trim();
    if target.is_empty() {
        return false;
    }
    let store = game_process_store().lock();
    match store {
        Ok(store) => store
            .as_ref()
            .is_some_and(|process| game_dirs_equal(&process.game_dir, target)),
        Err(_) => false,
    }
}

#[tauri::command]
pub fn get_running_game_state() -> RunningGameState {
    let store = game_process_store().lock();
    match store {
        Ok(store) => match store.as_ref() {
            Some(process) => RunningGameState {
                running: true,
                game_dir: Some(process.game_dir.clone()),
                pid: Some(process.pid),
            },
            None => RunningGameState {
                running: false,
                game_dir: None,
                pid: None,
            },
        },
        Err(_) => RunningGameState {
            running: false,
            game_dir: None,
            pid: None,
        },
    }
}

pub(crate) fn insert_process_if_empty(
    store: &mut Option<GameProcess>,
    process: GameProcess,
) -> Result<(), String> {
    if let Some(current) = store.as_ref() {
        return Err(format!("已有游戏进程正在运行 (PID {})", current.pid));
    }
    *store = Some(process);
    Ok(())
}

pub(crate) fn clear_process_if_pid(store: &mut Option<GameProcess>, pid: u32) -> bool {
    if store.as_ref().is_some_and(|process| process.pid == pid) {
        *store = None;
        true
    } else {
        false
    }
}

pub(crate) fn claim_termination_request(
    store: &mut Option<GameProcess>,
) -> Result<(u32, bool), String> {
    let process = store
        .as_mut()
        .ok_or_else(|| "当前没有运行中的游戏进程".to_string())?;
    if process.termination_requested {
        return Err(format!("游戏进程 (PID {}) 正在终止", process.pid));
    }

    process.termination_requested = true;
    Ok((process.pid, process.fully_started))
}

pub(crate) fn reset_termination_request_if_pid(store: &mut Option<GameProcess>, pid: u32) {
    if let Some(process) = store.as_mut().filter(|process| process.pid == pid) {
        process.termination_requested = false;
    }
}

pub(crate) fn mark_fully_started_if_pid(store: &mut Option<GameProcess>, pid: u32) -> bool {
    if let Some(process) = store.as_mut().filter(|process| process.pid == pid) {
        process.fully_started = true;
        true
    } else {
        false
    }
}
