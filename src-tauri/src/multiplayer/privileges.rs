use serde::Serialize;
use tauri::command;

use super::logs::append_text;
use super::paths::{executable_path, tool_path};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivilegePrepareResult {
    pub ok: bool,
    pub platform: String,
    pub firewall_ok: Option<bool>,
    pub tun_ok: Option<bool>,
    pub needs_admin: bool,
    pub message: String,
    pub manual_steps: Vec<String>,
}

#[command(rename_all = "camelCase")]
pub fn mp_prepare_privileges() -> PrivilegePrepareResult {
    #[cfg(target_os = "windows")]
    {
        prepare_windows()
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        prepare_unix()
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        PrivilegePrepareResult {
            ok: false,
            platform: std::env::consts::OS.to_string(),
            firewall_ok: None,
            tun_ok: None,
            needs_admin: true,
            message: "当前平台暂不支持自动权限配置".to_string(),
            manual_steps: vec!["请手动为 easytier-core 配置防火墙与 TUN 权限".to_string()],
        }
    }
}

#[cfg(target_os = "windows")]
fn prepare_windows() -> PrivilegePrepareResult {
    let platform = "windows".to_string();
    let Ok(path) = tool_path() else {
        return PrivilegePrepareResult {
            ok: false,
            platform,
            firewall_ok: Some(false),
            tun_ok: None,
            needs_admin: true,
            message: "未找到 easytier-core，请先完成安装".to_string(),
            manual_steps: vec![
                "在联机页等待自动下载完成，或重新初始化 EasyTier".to_string(),
                "然后再次点击权限准备".to_string(),
            ],
        };
    };
    if !path.is_file() {
        return PrivilegePrepareResult {
            ok: false,
            platform,
            firewall_ok: Some(false),
            tun_ok: None,
            needs_admin: true,
            message: format!("easytier-core 不存在: {}", path.display()),
            manual_steps: vec!["请先安装 EasyTier 模块".to_string()],
        };
    }

    let path_str = match executable_path(&path) {
        Ok(s) => s,
        Err(e) => {
            return PrivilegePrepareResult {
                ok: false,
                platform,
                firewall_ok: Some(false),
                tun_ok: None,
                needs_admin: true,
                message: e,
                manual_steps: vec![],
            };
        }
    };

    let bridge = path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| path.clone());
    let has_wintun = bridge.join("wintun.dll").is_file();
    if !has_wintun {
        append_text(
            "[OpenXLauncher] ⚠ bridge 目录缺少 wintun.dll，TUN 创建可能失败；请在设置中重新下载/修复 EasyTier。\n",
        );
    }

    append_text("[OpenXLauncher] 正在请求管理员权限以添加防火墙放行规则...\n");
    match add_firewall_rule_elevated(&path_str) {
        Ok(()) => {
            append_text("[OpenXLauncher] ✅ 防火墙规则已添加（或已存在）\n");
            append_text(
                "[OpenXLauncher] 说明：开房/加入时仍会弹出 UAC，以管理员权限启动 easytier-core 创建虚拟网卡。\n",
            );
            let mut steps = vec![
                "创建/加入房间时请在 UAC 中选择「是」，否则会出现 Failed to create adapter / 拒绝访问。"
                    .to_string(),
                "也可右键 OpenXLauncher → 以管理员身份运行，之后开房将不再二次提权。".to_string(),
            ];
            if !has_wintun {
                steps.insert(
                    0,
                    "缺少 wintun.dll：请到「设置 → 联机」点击重新下载/修复。".to_string(),
                );
            }
            PrivilegePrepareResult {
                ok: has_wintun,
                platform,
                firewall_ok: Some(true),
                tun_ok: None,
                needs_admin: true,
                message: if has_wintun {
                    "防火墙已配置。开房/加入时仍需允许 UAC，以便创建 TUN 虚拟网卡。"
                        .to_string()
                } else {
                    "防火墙已配置，但缺少 wintun.dll，请先修复安装。".to_string()
                },
                manual_steps: steps,
            }
        }
        Err(err) => {
            append_text(&format!("[OpenXLauncher] ⚠ 防火墙规则添加失败: {}\n", err));
            PrivilegePrepareResult {
                ok: false,
                platform,
                firewall_ok: Some(false),
                tun_ok: None,
                needs_admin: true,
                message: format!("未能自动配置防火墙（可能拒绝了 UAC）：{}", err),
                manual_steps: vec![
                    format!("打开「高级安全 Windows 防火墙」，为入站规则允许程序：{}", path_str),
                    "开房/加入时请允许 UAC，否则无法创建 TUN（日志会出现 Failed to create adapter）"
                        .to_string(),
                    "或右键 OpenXLauncher → 以管理员身份运行".to_string(),
                ],
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn add_firewall_rule_elevated(program_path: &str) -> Result<(), String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::path::PathBuf;
    use std::ptr;
    use winapi::um::shellapi::ShellExecuteW;
    use winapi::um::winuser::SW_HIDE;

    let rule_name = "OpenXLauncher EasyTier";
    // 先删同名规则再添加，避免重复；失败不致命。
    let script = format!(
        "$ErrorActionPreference='SilentlyContinue'; \
         netsh advfirewall firewall delete rule name=\"{rule}\" program=\"{prog}\" | Out-Null; \
         netsh advfirewall firewall add rule name=\"{rule}\" dir=in action=allow program=\"{prog}\" enable=yes profile=any; \
         if ($LASTEXITCODE -ne 0) {{ exit $LASTEXITCODE }}; \
         netsh advfirewall firewall add rule name=\"{rule} Out\" dir=out action=allow program=\"{prog}\" enable=yes profile=any; \
         exit $LASTEXITCODE",
        rule = rule_name,
        prog = program_path.replace('\'', "''")
    );

    let windows_dir =
        std::env::var_os("WINDIR").unwrap_or_else(|| OsStr::new("C:\\Windows").to_os_string());
    let powershell_path = PathBuf::from(windows_dir)
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
        "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command \"{}\"",
        script.replace('"', "\\\"")
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
    // ShellExecuteW: >32 means success (started). UAC cancel is typically <=32.
    if (result as isize) <= 32 {
        return Err(format!(
            "管理员提权未完成（ShellExecute 返回 {}）。未静默绕过 UAC。",
            result as isize
        ));
    }
    // 规则由提升后的进程异步执行；给一点时间。
    std::thread::sleep(std::time::Duration::from_millis(800));
    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn prepare_unix() -> PrivilegePrepareResult {
    let platform = std::env::consts::OS.to_string();
    let (tun_ok, tun_msg, steps) = check_tun_device();
    PrivilegePrepareResult {
        ok: tun_ok,
        platform,
        firewall_ok: None,
        tun_ok: Some(tun_ok),
        needs_admin: !tun_ok,
        message: tun_msg,
        manual_steps: steps,
    }
}

#[cfg(target_os = "linux")]
fn check_tun_device() -> (bool, String, Vec<String>) {
    let tun_path = std::path::Path::new("/dev/net/tun");
    if tun_path.exists() {
        (
            true,
            "检测到 /dev/net/tun，通常可创建虚拟网卡。若仍失败，请确认用户具备 CAP_NET_ADMIN 或以 root 运行。"
                .to_string(),
            vec![
                "必要时：sudo setcap cap_net_admin=eip <easytier-core 路径>".to_string(),
                "或使用 sudo 启动联机会话（不推荐长期如此）".to_string(),
            ],
        )
    } else {
        (
            false,
            "未检测到 /dev/net/tun，无法创建 TUN 设备".to_string(),
            vec![
                "加载 tun 模块：sudo modprobe tun".to_string(),
                "确认内核启用 CONFIG_TUN".to_string(),
                "安装完成后重新运行权限检查".to_string(),
            ],
        )
    }
}

#[cfg(target_os = "macos")]
fn check_tun_device() -> (bool, String, Vec<String>) {
    // macOS 通过 utun 创建虚拟接口，通常需要管理员权限。
    (
        false,
        "macOS 上 EasyTier 创建虚拟网卡通常需要管理员权限，请按提示授权。".to_string(),
        vec![
            "在系统弹窗中允许网络扩展 / 管理员权限".to_string(),
            "若失败，请使用管理员账户重新启动启动器后再试".to_string(),
            "检查「系统设置 → 隐私与安全性」中的网络相关授权".to_string(),
        ],
    )
}
