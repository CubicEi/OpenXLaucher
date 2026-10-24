use crate::handler::game_dir::canonical_game_dir;
use crate::handler::launcher::game_process_state::{
    claim_termination_request, clear_process_if_pid, game_process_store, insert_process,
    mark_fully_started_if_pid, reset_termination_request_if_pid, GameProcess,
};
use crate::handler::mod_update_locks::is_game_dir_mod_update_locked;
use serde::Serialize;
use std::{
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
};
use tauri::Emitter;

/// 检测游戏是否完全启动（模组加载完成即视为成功，不等待世界/主菜单）
/// 通过 Minecraft 日志中的标志性字符串判断
fn is_game_fully_started(line: &str) -> bool {
    // Forge 1.12+: "Forge Mod Loader has successfully loaded N mods"
    // Forge/NeoForge: "Mod loading complete" / "Early mod loading complete"
    // 通用: "Mods loaded" / "successfully loaded N mods"
    // Fabric/Quilt/原版回退（进世界前）: Sound engine / Narrator / Backend LWJGL
    let lower = line.to_lowercase();
    lower.contains("forge mod loader has successfully loaded")
        || lower.contains("successfully loaded") && lower.contains("mods")
        || lower.contains("mods loaded")
        || (lower.contains("loading complete") && lower.contains("mod"))
        || lower.contains("mod loading complete")
        || lower.contains("early mod loading complete")
        || lower.contains("sound engine started")
        || lower.contains("narrator library")
        || lower.contains("backend library:") && lower.contains("lwjgl")
        || lower.contains("minecraft client started")
        || lower.contains("minecraft client has started")
        || lower.contains("minecraft initialized")
}

/// 将进程结束状态转换为可展示的退出码。
/// Unix 上 `ExitStatus::code()` 在进程被信号终止时为 None；以前这类情况统一
/// 显示为 -1，无法区分 SIGABRT/SIGKILL 等真实原因。约定用负信号号表示它们。
pub(super) fn display_exit_code(status: std::process::ExitStatus) -> i32 {
    if let Some(code) = status.code() {
        return code;
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return -signal;
        }
    }

    -1
}

/// 游戏日志事件，发送给前端的结构体
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GameLogEvent {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) pid: Option<u32>,
    pub(super) level: String,
    pub(super) message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GameProcessStartedEvent {
    pid: u32,
    game_dir: String,
    display_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GamePidEvent {
    pid: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GameExitedEvent {
    pid: u32,
    exit_code: i32,
}

/// 解析 Minecraft log4j 日志行，提取日志级别
/// 支持格式: [HH:MM:SS] [Thread/LEVEL]: message
fn parse_log_level(line: &str) -> &'static str {
    // 跳过时间戳等标签，查找 [线程/LEVEL] 模式。
    let mut remaining = line;
    while let Some(start) = remaining.find('[') {
        let after_start = &remaining[start + 1..];
        let Some(end) = after_start.find(']') else {
            break;
        };
        let tag = &after_start[..end];
        if let Some(slash) = tag.rfind('/') {
            let level = &tag[slash + 1..];
            match level.to_uppercase().as_str() {
                "ERROR" | "FATAL" => return "error",
                "WARN" | "WARNING" => return "warn",
                _ => {}
            }
        }
        remaining = &after_start[end + 1..];
    }
    // fallback: 全文扫描关键词
    let u = line.to_uppercase();
    if u.contains("[ERROR]") || u.contains("[FATAL]") || u.contains("STDERR:") {
        "error"
    } else if u.contains("[WARN]") || u.contains("[WARNING]") {
        "warn"
    } else {
        "info"
    }
}

fn claim_startup_transition(started: &std::sync::atomic::AtomicBool) -> bool {
    started
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
        )
        .is_ok()
}

#[cfg(unix)]
fn ensure_owner_executable(path: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let metadata = std::fs::metadata(path).map_err(|e| format!("无法读取 Java 文件信息: {}", e))?;
    let permissions = metadata.permissions();
    if permissions.mode() & 0o100 != 0 {
        return Ok(());
    }

    let current_uid = nix::unistd::Uid::effective().as_raw();
    if metadata.uid() != current_uid {
        return Err(format!(
            "Java 文件不属于当前用户，不能修改执行权限: {}",
            path.display()
        ));
    }

    info!("Java 缺少所有者执行权限，正在修复: {}", path.display());
    let mut new_permissions = permissions;
    new_permissions.set_mode(new_permissions.mode() | 0o100);
    std::fs::set_permissions(path, new_permissions)
        .map_err(|e| format!("无法设置 Java 执行权限: {}", e))
}

pub fn run_command(
    args: Vec<String>,
    javaPath: PathBuf,
    MCPath: PathBuf,
    app_handle: tauri::AppHandle,
    minecraft_version: String,
    game_directory: String,
    display_name: String,
) -> Result<(), Box<dyn std::error::Error>> {
    // 检查 Java 路径是否存在
    if !javaPath.exists() {
        return Err(format!("Java 路径不存在: {}", javaPath.display()).into());
    }

    // 校验 java_path 不是一个 .jar 文件
    if let Some(ext) = javaPath.extension() {
        if ext.eq_ignore_ascii_case("jar") {
            return Err(format!(
                "Java 路径指向了一个 .jar 文件而非 Java 可执行文件: {}\n请设置为 java 或 javaw 可执行文件的路径，例如 /usr/bin/java",
                javaPath.display()
            ).into());
        }
    }

    // 在 Unix 系统上检查并修复执行权限
    #[cfg(unix)]
    {
        ensure_owner_executable(&javaPath)?;
    }

    // 确保工作目录存在
    if !MCPath.exists() {
        std::fs::create_dir_all(&MCPath)
            .map_err(|e| format!("无法创建游戏目录 {}: {}", MCPath.display(), e))?;
    }

    let mut command = if cfg!(any(
        target_os = "windows",
        target_os = "linux",
        target_os = "macos"
    )) {
        Command::new(&javaPath)
    } else {
        return Err("不支持的操作系统".to_string().into());
    };

    // 设置工作目录为 minecraft_path（共享资源目录）
    // 游戏的实际运行目录通过 --game-dir 参数传递
    command.current_dir(&MCPath);
    command.args(&args);
    // 捕获标准输出和错误输出以便转发日志到前端
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    let game_dir_key = canonical_game_dir(Path::new(&game_directory));
    if is_game_dir_mod_update_locked(&game_dir_key) {
        return Err("该实例模组正在更新，请稍后再启动".into());
    }

    // 持有同一个锁完成“启动 + 登记”，避免并发 spawn 互相覆盖登记。
    let mut store = game_process_store()
        .lock()
        .map_err(|e| format!("无法读取游戏进程状态: {}", e))?;

    match command.spawn() {
        Ok(mut child) => {
            let pid = child.id();
            info!("游戏启动成功，进程ID: {}", pid);

            // 从子进程取出 stdout/stderr 管道
            let stdout = child.stdout.take();
            let stderr = child.stderr.take();

            let label = if display_name.trim().is_empty() {
                game_dir_key.clone()
            } else {
                display_name.clone()
            };

            // 追加到全局多进程登记表（启动中，尚未完成初始化）。
            insert_process(
                &mut store,
                GameProcess {
                    pid,
                    fully_started: false,
                    termination_requested: false,
                    minecraft_version: minecraft_version.clone(),
                    game_dir: game_dir_key.clone(),
                    display_name: label.clone(),
                    started_seq: 0,
                },
            )?;
            drop(store);

            let _ = app_handle.emit(
                "game-process-started",
                GameProcessStartedEvent {
                    pid,
                    game_dir: game_dir_key.clone(),
                    display_name: label,
                },
            );

            // 用于检测"完全启动"的共享 flag
            let fully_started_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

            // 读取 stdout 并逐行转发给前端
            if let Some(out) = stdout {
                let handle = app_handle.clone();
                let flag = fully_started_flag.clone();
                thread::spawn(move || {
                    let reader = BufReader::new(out);
                    for line in reader.lines() {
                        if let Ok(line) = line {
                            let level = parse_log_level(&line).to_string();
                            println!("[{}] {}", level, line);
                            let _ = handle.emit(
                                "game-log",
                                GameLogEvent {
                                    pid: Some(pid),
                                    level: level.clone(),
                                    message: line.clone(),
                                },
                            );
                            // 检测游戏是否已完全启动
                            if is_game_fully_started(&line) && claim_startup_transition(&flag) {
                                let is_current_process = {
                                    let mut store = game_process_store().lock().unwrap();
                                    mark_fully_started_if_pid(&mut store, pid)
                                };
                                if is_current_process {
                                    let _ = handle.emit("game-fully-started", GamePidEvent { pid });
                                }
                            }
                        }
                    }
                });
            }

            // 读取 stderr 并逐行转发给前端（通常为错误/警告信息）
            if let Some(err) = stderr {
                let handle = app_handle.clone();
                let flag = fully_started_flag.clone();
                thread::spawn(move || {
                    let reader = BufReader::new(err);
                    for line in reader.lines() {
                        if let Ok(line) = line {
                            let level = parse_log_level(&line).to_string();
                            println!("[{}] {}", level, line);
                            let _ = handle.emit(
                                "game-log",
                                GameLogEvent {
                                    pid: Some(pid),
                                    level: level.clone(),
                                    message: line.clone(),
                                },
                            );
                            // 同样在 stderr 中检测启动完成（有些启动日志走 stderr）
                            if is_game_fully_started(&line) && claim_startup_transition(&flag) {
                                let is_current_process = {
                                    let mut store = game_process_store().lock().unwrap();
                                    mark_fully_started_if_pid(&mut store, pid)
                                };
                                if is_current_process {
                                    let _ = handle.emit("game-fully-started", GamePidEvent { pid });
                                }
                            }
                        }
                    }
                });
            }

            // 在后台线程中等待进程结束，结束时向前端发送事件
            thread::spawn(move || {
                let exit_code = match child.wait() {
                    Ok(status) => display_exit_code(status),
                    Err(e) => {
                        error!("等待游戏进程 {} 时出错: {}", pid, e);
                        -1
                    }
                };

                info!("游戏进程 {} 已结束，退出码: {}", pid, exit_code);

                // 仅清除此等待线程对应的进程。旧线程不能清除或上报新进程。
                let (should_emit, launched_mc_version, launched_game_dir) = game_process_store()
                    .lock()
                    .map(|mut store| {
                        let snapshot = store
                            .get(&pid)
                            .map(|gp| (gp.minecraft_version.clone(), gp.game_dir.clone()));
                        let mc = snapshot.as_ref().map(|s| s.0.clone()).unwrap_or_default();
                        let gd = snapshot.as_ref().map(|s| s.1.clone()).unwrap_or_default();
                        (clear_process_if_pid(&mut store, pid), mc, gd)
                    })
                    .unwrap_or((false, String::new(), String::new()));
                if should_emit {
                    if exit_code == 0 && !launched_mc_version.is_empty() {
                        crate::handler::mod_updates::on_successful_game_exit(
                            &launched_mc_version,
                            &launched_game_dir,
                        );
                    }
                    let _ = app_handle.emit(
                        "game-exited",
                        GameExitedEvent { pid, exit_code },
                    );
                }
            });
            Ok(())
        }
        Err(e) => {
            let msg = format!("游戏启动失败 (Java: {}): {}", javaPath.display(), e);
            println!("{}", msg);
            Err(msg.into())
        }
    }
}

#[cfg(windows)]
fn terminate_process(pid: u32) -> Result<(), String> {
    let output = Command::new("taskkill")
        .args(["/F", "/PID", &pid.to_string()])
        .output()
        .map_err(|e| format!("无法运行 taskkill: {}", e))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "taskkill 失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

#[cfg(not(windows))]
fn terminate_process(pid: u32) -> Result<(), String> {
    let output = Command::new("kill")
        .args(["-9", &pid.to_string()])
        .output()
        .map_err(|e| format!("无法运行 kill: {}", e))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "kill 失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

/// 终止指定（或最近一个）游戏进程（在游戏未完全启动前可调用）
#[tauri::command]
pub fn kill_game_process(pid: Option<u32>) -> Result<String, String> {
    // 先在锁内登记终止请求，再释放锁运行外部命令。
    let (target_pid, started) = {
        let mut store = game_process_store().lock().map_err(|e| e.to_string())?;
        claim_termination_request(&mut store, pid)?
    };

    if let Err(error) = terminate_process(target_pid) {
        if let Ok(mut store) = game_process_store().lock() {
            reset_termination_request_if_pid(&mut store, target_pid);
        }
        return Err(error);
    }

    if started {
        Ok(format!("游戏进程 (PID {}) 已终止", target_pid))
    } else {
        Ok(format!("启动中的游戏进程 (PID {}) 已取消", target_pid))
    }
}

#[cfg(test)]
mod tests {
    use super::{claim_startup_transition, parse_log_level};
    use crate::handler::launcher::game_process_state::{
        claim_termination_request, clear_process_if_pid, insert_process,
        reset_termination_request_if_pid, GameProcess, GameProcessMap,
    };
    use std::sync::atomic::{AtomicBool, Ordering};

    fn sample_process(pid: u32) -> GameProcess {
        GameProcess {
            pid,
            fully_started: false,
            termination_requested: false,
            minecraft_version: "1.20.1".to_string(),
            game_dir: "C:\\game".to_string(),
            display_name: "1.20.1".to_string(),
            started_seq: 0,
        }
    }

    #[test]
    fn reads_the_level_from_the_thread_tag_after_a_timestamp() {
        assert_eq!(
            parse_log_level("[12:00:00] [Render thread/ERROR]: failed"),
            "error"
        );
        assert_eq!(parse_log_level("[12:00:00] [Worker/WARN]: delayed"), "warn");
        assert_eq!(
            parse_log_level("[12:00:00] [Render thread/INFO]: ready"),
            "info"
        );
    }

    #[test]
    fn claims_the_startup_transition_only_once() {
        let started = AtomicBool::new(false);

        assert!(claim_startup_transition(&started));
        assert!(!claim_startup_transition(&started));
        assert!(started.load(Ordering::SeqCst));
    }

    #[test]
    fn detects_mods_loaded_as_fully_started_not_world_or_title() {
        use super::is_game_fully_started;

        assert!(is_game_fully_started(
            "[Client thread/INFO] [FML]: Forge Mod Loader has successfully loaded 42 mods"
        ));
        assert!(is_game_fully_started(
            "[main/INFO]: Early mod loading complete"
        ));
        assert!(is_game_fully_started(
            "[Render thread/INFO]: Sound engine started"
        ));
        assert!(is_game_fully_started(
            "[Render thread/INFO]: Backend library: LWJGL version 3.3.3"
        ));
        // 不再把进世界 / 主菜单当作启动成功
        assert!(!is_game_fully_started(
            "[Server thread/INFO]: Preparing spawn area: 0%"
        ));
        assert!(!is_game_fully_started(
            "[Render thread/INFO]: Displaying screen TitleScreen"
        ));
    }

    #[cfg(unix)]
    #[test]
    fn adds_only_the_owner_execute_permission() {
        use super::ensure_owner_executable;
        use std::os::unix::fs::PermissionsExt;

        let path = std::env::temp_dir().join(format!(
            "OpenXLauncher-java-permissions-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        std::fs::write(&path, []).expect("create temporary Java executable");
        let mut permissions = std::fs::metadata(&path)
            .expect("read temporary file metadata")
            .permissions();
        permissions.set_mode(0o640);
        std::fs::set_permissions(&path, permissions).expect("set initial permissions");

        ensure_owner_executable(&path).expect("add owner execute permission");

        let mode = std::fs::metadata(&path)
            .expect("read updated metadata")
            .permissions()
            .mode()
            & 0o777;
        let _ = std::fs::remove_file(&path);
        assert_eq!(mode, 0o740);
    }

    #[test]
    fn allows_multiple_processes_and_clears_only_matching_pid() {
        let mut store = GameProcessMap::new();

        insert_process(&mut store, sample_process(100)).expect("insert the first process");
        insert_process(&mut store, sample_process(200)).expect("insert a second process");
        assert_eq!(store.len(), 2);

        assert!(!clear_process_if_pid(&mut store, 999));
        assert_eq!(store.len(), 2);

        assert!(clear_process_if_pid(&mut store, 100));
        assert!(!store.contains_key(&100));
        assert!(store.contains_key(&200));
    }

    #[test]
    fn rejects_a_repeated_termination_request() {
        let mut store = GameProcessMap::new();
        insert_process(&mut store, sample_process(100)).expect("insert");

        assert_eq!(
            claim_termination_request(&mut store, Some(100)),
            Ok((100, false))
        );
        assert!(claim_termination_request(&mut store, Some(100)).is_err());
    }

    #[test]
    fn resets_a_failed_termination_request_only_for_the_same_pid() {
        let mut store = GameProcessMap::new();
        insert_process(&mut store, sample_process(100)).expect("insert");
        claim_termination_request(&mut store, Some(100))
            .expect("claim the first termination request");

        reset_termination_request_if_pid(&mut store, 200);
        assert!(claim_termination_request(&mut store, Some(100)).is_err());

        reset_termination_request_if_pid(&mut store, 100);
        assert_eq!(
            claim_termination_request(&mut store, Some(100)),
            Ok((100, false))
        );
    }

    #[test]
    fn kills_most_recent_when_pid_omitted() {
        let mut store = GameProcessMap::new();
        insert_process(&mut store, sample_process(100)).expect("insert first");
        insert_process(&mut store, sample_process(200)).expect("insert second");

        assert_eq!(
            claim_termination_request(&mut store, None),
            Ok((200, false))
        );
    }
}
