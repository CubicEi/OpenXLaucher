use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;

use serde::Serialize;
use tauri::command;

use super::codec::{
    self, build_host_invite, decode_invite, encode_invite, generate_network_secret, host_arguments,
    join_arguments, peer_url, sanitize_hostname, sanitize_room_name, InvitePayload, HOST_VIP,
};
use super::download::current_download_progress;
use super::logs::{self, append_text};
use super::paths::{
    bridge_dir, executable_path, is_easytier_managed_file, read_installed_version, read_peer_url,
    tool_dir, tool_path, write_peer_url, DEFAULT_PEER,
};
use super::EASYTIER_BIN;

static SESSION_PROCESS: Mutex<Option<Child>> = Mutex::new(None);
static SESSION_START_LOCK: Mutex<()> = Mutex::new(());
static PENDING_HOST: Mutex<Option<InvitePayload>> = Mutex::new(None);
static ACTIVE_SESSION: Mutex<Option<ActiveSession>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveSession {
    pub mode: String,
    pub room_info: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub path: String,
    pub bridge_dir: String,
    pub running: bool,
    pub peer: String,
    pub download: super::download::MpDownloadProgress,
    pub run_mode: Option<String>,
    pub room_info: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MpPaths {
    pub bridge_dir: String,
    pub tool_path: String,
    pub tool_name: String,
    pub peer: String,
    pub default_peer: String,
    pub host_vip: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodeRoomResult {
    pub invite: String,
    pub network_name: String,
    pub host_ipv4: String,
    pub port: u16,
    pub peer: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartHostResult {
    pub invite: String,
    pub network_name: String,
    pub host_ipv4: String,
    pub port: u16,
    pub peer: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartJoinResult {
    pub path: String,
    pub network_name: String,
    pub host_ipv4: String,
    pub port: u16,
    pub connect_hint: String,
    pub peer: String,
}

fn is_easytier_process_name(name: &str) -> bool {
    name.eq_ignore_ascii_case("easytier-core") || name.eq_ignore_ascii_case("easytier-core.exe")
}

fn has_session_system_process() -> bool {
    let system = sysinfo::System::new_all();
    let our_path = tool_path().ok();
    system.processes().values().any(|process| {
        if !is_easytier_process_name(&process.name().to_string_lossy()) {
            return false;
        }
        if let Some(ref expected) = our_path {
            if let Some(exe) = process.exe() {
                return exe == expected.as_path();
            }
        }
        true
    })
}

fn kill_tracked_child() {
    if let Ok(mut guard) = SESSION_PROCESS.lock() {
        if let Some(child) = guard.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        *guard = None;
    }
}

fn kill_our_easytier_processes() -> Result<(), String> {
    let system = sysinfo::System::new_all();
    let our_path = tool_path().ok();
    let mut killed_any = false;
    for process in system.processes().values() {
        if !is_easytier_process_name(&process.name().to_string_lossy()) {
            continue;
        }
        let matches_path = match (&our_path, process.exe()) {
            (Some(expected), Some(exe)) => exe == expected.as_path(),
            (Some(_), None) => false,
            (None, _) => true,
        };
        if matches_path {
            let _ = process.kill();
            killed_any = true;
        }
    }
    if killed_any {
        thread::sleep(std::time::Duration::from_millis(300));
    }

    // 管理员启动的 easytier 可能杀不掉，再请求提升后的 Stop-Process。
    #[cfg(target_os = "windows")]
    if has_session_system_process() {
        let _ = kill_easytier_elevated();
        thread::sleep(std::time::Duration::from_millis(400));
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn kill_easytier_elevated() -> Result<(), String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;
    use winapi::um::shellapi::ShellExecuteW;
    use winapi::um::winuser::SW_HIDE;

    let script = "Get-Process -Name 'easytier-core' -ErrorAction SilentlyContinue | Stop-Process -Force; exit 0";
    let windows_dir =
        std::env::var_os("WINDIR").unwrap_or_else(|| OsStr::new("C:\\Windows").to_os_string());
    let powershell_path = std::path::PathBuf::from(windows_dir)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    let powershell_wide: Vec<u16> = powershell_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let runas_wide: Vec<u16> = OsStr::new("runas")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let args = format!(
        "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command \"{}\"",
        script
    );
    let args_wide: Vec<u16> = OsStr::new(&args)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let result = unsafe {
        ShellExecuteW(
            ptr::null_mut(),
            runas_wide.as_ptr(),
            powershell_wide.as_ptr(),
            args_wide.as_ptr(),
            ptr::null(),
            SW_HIDE,
        )
    };
    if (result as isize) <= 32 {
        return Err(format!(
            "无法提权结束 EasyTier（ShellExecute 返回 {}）",
            result as isize
        ));
    }
    Ok(())
}

fn store_active_session(mode: &str, room_info: &str) {
    if let Ok(mut guard) = ACTIVE_SESSION.lock() {
        *guard = Some(ActiveSession {
            mode: mode.to_string(),
            room_info: room_info.to_string(),
        });
    }
}

fn clear_active_session() {
    if let Ok(mut guard) = ACTIVE_SESSION.lock() {
        *guard = None;
    }
}

fn active_session_snapshot() -> Option<ActiveSession> {
    ACTIVE_SESSION.lock().ok().and_then(|guard| guard.clone())
}

fn stop_session_inner() -> Result<(), String> {
    append_text("[OpenXLauncher] 正在停止 EasyTier 会话…\n");
    kill_tracked_child();
    kill_our_easytier_processes()?;
    clear_active_session();
    append_text("[OpenXLauncher] ✅ EasyTier 会话已停止（模块文件保留）\n");
    Ok(())
}

#[cfg(target_os = "windows")]
fn is_process_elevated() -> bool {
    // winapi 0.3 未导出该符号；直接链接 shell32。
    #[link(name = "shell32")]
    extern "system" {
        fn IsUserAnAdmin() -> i32;
    }
    unsafe { IsUserAnAdmin() != 0 }
}

#[cfg(target_os = "windows")]
fn start_elevated_with_args(
    bin_path: &std::path::Path,
    working_dir: &std::path::Path,
    args: &[String],
) -> Result<String, String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;
    use winapi::um::shellapi::ShellExecuteW;
    use winapi::um::winuser::SW_HIDE;

    logs::reset_session_log(working_dir);
    let log_path = logs::session_log_path(working_dir);
    let path_str = executable_path(bin_path)?;

    // PowerShell 在管理员上下文中启动 easytier，并把输出写入会话日志供前端轮询。
    let arg_literals: String = args
        .iter()
        .map(|a| format!("'{}'", a.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(", ");
    let script = format!(
        "$ErrorActionPreference='Continue'; \
         Set-Location -LiteralPath '{}'; \
         $log = '{}'; \
         $exe = '{}'; \
         $argList = @({args}); \
         & $exe @argList *>&1 | ForEach-Object {{ \
           $line = $_.ToString(); \
           Add-Content -LiteralPath $log -Value $line -Encoding utf8 \
         }}; \
         exit $LASTEXITCODE",
        working_dir.display().to_string().replace('\'', "''"),
        log_path.display().to_string().replace('\'', "''"),
        path_str.replace('\'', "''"),
        args = arg_literals,
    );

    let windows_dir =
        std::env::var_os("WINDIR").unwrap_or_else(|| OsStr::new("C:\\Windows").to_os_string());
    let powershell_path = std::path::PathBuf::from(windows_dir)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    let powershell_wide: Vec<u16> = powershell_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let runas_wide: Vec<u16> = OsStr::new("runas")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let ps_args = format!(
        "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command \"{}\"",
        script.replace('"', "\\\"")
    );
    let args_wide: Vec<u16> = OsStr::new(&ps_args)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let cwd_wide: Vec<u16> = working_dir
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    append_text(
        "[OpenXLauncher] 正在请求管理员权限启动 easytier-core（创建 TUN 虚拟网卡需要）…\n\
         [OpenXLauncher] 请在 UAC 提示中选择「是」。若选择「否」，将无法创建虚拟网卡。\n\n",
    );

    let result = unsafe {
        ShellExecuteW(
            ptr::null_mut(),
            runas_wide.as_ptr(),
            powershell_wide.as_ptr(),
            args_wide.as_ptr(),
            cwd_wide.as_ptr(),
            SW_HIDE,
        )
    };
    if (result as isize) <= 32 {
        let err = format!(
            "管理员启动未完成（ShellExecute 返回 {}）。创建 TUN 需要管理员权限，请在 UAC 中允许，或右键以管理员身份运行启动器。",
            result as isize
        );
        append_text(&format!("[OpenXLauncher] ❌ {}\n", err));
        return Err(err);
    }

    // ShellExecute 异步拉起；等待进程出现。
    for _ in 0..40 {
        thread::sleep(std::time::Duration::from_millis(150));
        if has_session_system_process() {
            // 提升后的进程不由我们持有 Child 句柄
            if let Ok(mut guard) = SESSION_PROCESS.lock() {
                *guard = None;
            }
            append_text(
                "[OpenXLauncher] ✅ 已以管理员权限启动 easytier-core（输出写入会话日志）\n\n",
            );
            return Ok(path_str);
        }
    }

    // 可能启动极快失败；仍返回成功路径让前端轮询日志，同时提示检查日志。
    append_text(
        "[OpenXLauncher] ⚠ 未在短时间内检测到 easytier-core 进程，请查看下方日志（常见原因：UAC 拒绝或 TUN/wintun 失败）\n\n",
    );
    Ok(path_str)
}

fn start_with_args(args: &[String]) -> Result<String, String> {
    let _start_guard = SESSION_START_LOCK
        .lock()
        .map_err(|_| "EasyTier 启动流程锁异常".to_string())?;
    if is_running_inner() {
        return Err("EasyTier 会话已在运行，请先停止当前联机后再启动".to_string());
    }
    // 清理残留进程，降低 AddrInUse(10048) 概率。
    let _ = kill_our_easytier_processes();

    let bin_path = tool_path()?;
    if !bin_path.is_file() {
        return Err(format!(
            "{} 不存在于: {}，请先执行安装初始化",
            EASYTIER_BIN,
            bin_path.display()
        ));
    }
    let working_dir = tool_dir()?;
    let path_str = executable_path(&bin_path)?;
    logs::clear_buffer();
    append_text(&format!(
        "[OpenXLauncher] 正在启动 easytier-core…\n\
         [OpenXLauncher]   可执行文件: {}\n\
         [OpenXLauncher]   工作目录: {}\n\
         [OpenXLauncher]   参数: {:?}\n\n",
        path_str,
        working_dir.display(),
        args
    ));

    #[cfg(target_os = "windows")]
    {
        let wintun = working_dir.join("wintun.dll");
        if !wintun.is_file() {
            append_text(
                "[OpenXLauncher] ⚠ 未在 bridge 目录发现 wintun.dll。若随后报 Failed to create adapter，请重新下载/修复 EasyTier 模块。\n",
            );
        }
        // 非管理员进程无法创建 TUN；提权启动。已是管理员则直接管道捕获输出。
        if !is_process_elevated() {
            return start_elevated_with_args(&bin_path, &working_dir, args);
        }
    }

    #[cfg(target_os = "windows")]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new(&bin_path);
        c.creation_flags(0x08000000); // CREATE_NO_WINDOW
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = Command::new(&bin_path);

    cmd.current_dir(&working_dir);
    for arg in args {
        cmd.arg(arg);
    }
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.stdin(Stdio::null());

    match cmd.spawn() {
        Ok(mut child) => {
            if let Some(stdout) = child.stdout.take() {
                thread::spawn(move || {
                    let reader = BufReader::new(stdout);
                    for line in reader.lines() {
                        match line {
                            Ok(text) => append_text(&(text + "\n")),
                            Err(_) => break,
                        }
                    }
                });
            }
            if let Some(stderr) = child.stderr.take() {
                thread::spawn(move || {
                    let reader = BufReader::new(stderr);
                    for line in reader.lines() {
                        match line {
                            Ok(text) => append_text(&format!("[stderr] {}\n", text)),
                            Err(_) => break,
                        }
                    }
                });
            }
            {
                let mut guard = SESSION_PROCESS
                    .lock()
                    .map_err(|_| "无法锁定进程句柄".to_string())?;
                *guard = Some(child);
            }
            append_text("[OpenXLauncher] ✅ easytier-core 已启动，正在捕获输出…\n\n");
            Ok(path_str)
        }
        Err(e) => {
            let err_msg = format!(
                "[OpenXLauncher] ❌ 启动失败: {}\n\
                 [OpenXLauncher]   路径: {}\n\
                 [OpenXLauncher]   若提示权限/TUN 相关错误，请允许 UAC 或以管理员运行启动器\n",
                e, path_str
            );
            append_text(&err_msg);
            Err(err_msg)
        }
    }
}

fn is_running_inner() -> bool {
    if let Ok(mut guard) = SESSION_PROCESS.lock() {
        if let Some(child) = guard.as_mut() {
            match child.try_wait() {
                Ok(None) => return true,
                Ok(Some(_)) => {
                    *guard = None;
                }
                Err(e) => {
                    append_text(&format!("[OpenXLauncher] 检查进程句柄失败: {}\n", e));
                }
            }
        }
    }
    has_session_system_process()
}

fn take_or_create_host_invite(room_name: &str, port: &str) -> Result<InvitePayload, String> {
    let network_name = sanitize_room_name(room_name)?;
    let port_num = codec::parse_port(port)?;

    if let Ok(mut guard) = PENDING_HOST.lock() {
        if let Some(pending) = guard.as_ref() {
            if pending.network_name == network_name && pending.port == port_num {
                let payload = pending.clone();
                *guard = None;
                return Ok(payload);
            }
        }
    }

    let secret = generate_network_secret();
    build_host_invite(&network_name, port, &secret)
}

fn store_pending_host(payload: InvitePayload) {
    if let Ok(mut guard) = PENDING_HOST.lock() {
        *guard = Some(payload);
    }
}

fn delete_easytier_files(dir: &std::path::Path) -> Result<(), String> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir).map_err(|e| format!("读取 bridge 失败: {}", e))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        if path.is_file() && is_easytier_managed_file(name) {
            std::fs::remove_file(&path)
                .map_err(|e| format!("删除 {} 失败: {}", path.display(), e))?;
        } else if path.is_dir() {
            let lower = name.to_ascii_lowercase();
            if lower.starts_with("easytier") || lower == "log" {
                let _ = std::fs::remove_dir_all(&path);
            }
        }
    }
    Ok(())
}

#[command(rename_all = "camelCase")]
pub fn mp_get_tool_status() -> ToolStatus {
    let path = tool_path().unwrap_or_default();
    let bridge = bridge_dir().unwrap_or_default();
    let running = is_running_inner();
    let session = if running {
        active_session_snapshot()
    } else {
        clear_active_session();
        None
    };
    ToolStatus {
        installed: path.is_file(),
        version: read_installed_version(),
        path: path.display().to_string(),
        bridge_dir: bridge.display().to_string(),
        running,
        peer: read_peer_url(),
        download: current_download_progress(),
        run_mode: session.as_ref().map(|s| s.mode.clone()),
        room_info: session.as_ref().map(|s| s.room_info.clone()),
    }
}

#[command(rename_all = "camelCase")]
pub fn mp_get_paths() -> MpPaths {
    MpPaths {
        bridge_dir: bridge_dir()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
        tool_path: tool_path()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
        tool_name: EASYTIER_BIN.to_string(),
        peer: read_peer_url(),
        default_peer: DEFAULT_PEER.to_string(),
        host_vip: HOST_VIP.to_string(),
    }
}

#[command(rename_all = "camelCase")]
pub fn mp_set_peer(peer: String) -> Result<String, String> {
    write_peer_url(&peer)?;
    Ok(read_peer_url())
}

#[command(rename_all = "camelCase")]
pub fn mp_encode_room_info(room_name: String, port: String) -> Result<EncodeRoomResult, String> {
    let secret = generate_network_secret();
    let payload = build_host_invite(&room_name, &port, &secret)?;
    store_pending_host(payload.clone());
    Ok(EncodeRoomResult {
        invite: encode_invite(&payload),
        network_name: payload.network_name,
        host_ipv4: payload.host_ipv4,
        port: payload.port,
        peer: peer_url(),
    })
}

#[command(rename_all = "camelCase")]
pub fn mp_start_host(room_name: String, port: String) -> Result<StartHostResult, String> {
    let payload = take_or_create_host_invite(&room_name, &port)?;
    let hostname = sanitize_hostname(&payload.network_name)?;
    let peer = peer_url();
    let args = host_arguments(
        &payload.network_name,
        &payload.network_secret,
        &hostname,
        &peer,
    );
    let path = start_with_args(&args)?;
    let invite = encode_invite(&payload);
    store_active_session("host", &invite);
    Ok(StartHostResult {
        invite,
        network_name: payload.network_name,
        host_ipv4: payload.host_ipv4,
        port: payload.port,
        peer,
        path,
    })
}

#[command(rename_all = "camelCase")]
pub fn mp_start_join(encoded_invite: String, player_name: String) -> Result<StartJoinResult, String> {
    let invite = decode_invite(&encoded_invite)?;
    let hostname = sanitize_hostname(&player_name)?;
    // 优先使用邀请码中的节点，保证与房主同一引导入口。
    let peer = if invite.peer.trim().is_empty() {
        peer_url()
    } else {
        invite.peer.clone()
    };
    let args = join_arguments(
        &invite.network_name,
        &invite.network_secret,
        &hostname,
        &peer,
    );
    let path = start_with_args(&args)?;
    store_active_session("join", &encoded_invite);
    Ok(StartJoinResult {
        path,
        network_name: invite.network_name,
        host_ipv4: invite.host_ipv4.clone(),
        port: invite.port,
        connect_hint: format!("{}:{}", invite.host_ipv4, invite.port),
        peer,
    })
}

#[command(rename_all = "camelCase")]
pub async fn mp_stop_session() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(stop_session_inner)
        .await
        .map_err(|e| format!("停止会话任务异常: {}", e))?
}

#[command(rename_all = "camelCase")]
pub fn mp_is_running() -> bool {
    is_running_inner()
}

#[command(rename_all = "camelCase")]
pub fn mp_poll_log() -> String {
    logs::poll()
}

#[command(rename_all = "camelCase")]
pub async fn mp_uninstall_tool() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        stop_session_inner()?;
        let dir = bridge_dir()?;
        append_text(&format!(
            "[OpenXLauncher] 正在卸载 EasyTier 文件（{}）…\n",
            dir.display()
        ));
        delete_easytier_files(&dir)?;
        append_text("[OpenXLauncher] ✅ EasyTier 模块已卸载\n");
        Ok(())
    })
    .await
    .map_err(|e| format!("卸载任务异常: {}", e))?
}

#[command(rename_all = "camelCase")]
pub async fn mp_force_kill_process() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        append_text("[OpenXLauncher] 强制结束 EasyTier 进程（不卸载）…\n");
        kill_tracked_child();
        kill_our_easytier_processes()?;
        clear_active_session();
        append_text("[OpenXLauncher] ✅ 强制结束完成\n");
        Ok(())
    })
    .await
    .map_err(|e| format!("强制结束任务异常: {}", e))?
}

/// Best-effort stop used when the launcher process is exiting.
pub fn ensure_easytier_stopped_on_exit() {
    let _ = stop_session_inner();
}
