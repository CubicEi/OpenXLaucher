use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use super::config::update_temp_root;
use super::identity::APP_BUNDLE_NAME;

const OLD_APP_NAME: &str = "OpenXLauncher_old.app";
const ACK_TIMEOUT_SECONDS: u32 = 120;
const PID_WAIT_SECONDS: u32 = 120;

/// Walk upward from an executable path and return the enclosing `.app` bundle.
pub fn resolve_app_bundle_from_exe(exe: &Path) -> Result<PathBuf, String> {
    let mut current = exe.to_path_buf();
    loop {
        if current
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.ends_with(".app"))
            .unwrap_or(false)
        {
            return Ok(current);
        }
        match current.parent() {
            Some(parent) if parent != current => current = parent.to_path_buf(),
            _ => {
                return Err(
                    "当前进程不在 OpenXLauncher.app 内。请先将应用安装到 Applications 后再更新。"
                        .to_string(),
                );
            }
        }
    }
}

fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

pub fn build_replace_shell_script(
    install_app: &Path,
    dmg_path: &Path,
    old_pid: u32,
    ack_path: &Path,
    fail_notice_template: &Path,
    fail_notice_flag: &Path,
) -> String {
    let install = shell_single_quote(&install_app.to_string_lossy());
    let dmg = shell_single_quote(&dmg_path.to_string_lossy());
    let ack = shell_single_quote(&ack_path.to_string_lossy());
    let fail_tpl = shell_single_quote(&fail_notice_template.to_string_lossy());
    let fail_flag = shell_single_quote(&fail_notice_flag.to_string_lossy());
    let parent = install_app
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let old_app = parent.join(OLD_APP_NAME);
    let old = shell_single_quote(&old_app.to_string_lossy());
    let app_name = APP_BUNDLE_NAME;
    let binary_rel = format!("Contents/MacOS/OpenXLauncher");

    format!(
        r#"#!/bin/sh
set -eu

INSTALL_APP={install}
DMG={dmg}
OLD_APP={old}
ACK={ack}
FAIL_TPL={fail_tpl}
FAIL_FLAG={fail_flag}
OLD_PID={old_pid}
MOUNT_POINT=""
NEW_APP=""

cleanup_mount() {{
  if [ -n "$MOUNT_POINT" ] && [ -d "$MOUNT_POINT" ]; then
    hdiutil detach "$MOUNT_POINT" -force >/dev/null 2>&1 || true
  fi
}}

fail_and_restore() {{
  cleanup_mount
  if [ -d "$OLD_APP" ]; then
    rm -rf "$INSTALL_APP" >/dev/null 2>&1 || true
    mv "$OLD_APP" "$INSTALL_APP" >/dev/null 2>&1 || true
  fi
  if [ -f "$FAIL_TPL" ]; then
    cp -f "$FAIL_TPL" "$FAIL_FLAG" >/dev/null 2>&1 || true
  fi
  if [ -d "$INSTALL_APP" ]; then
    "$INSTALL_APP/{binary_rel}" --openx-update-fail="$FAIL_FLAG" >/dev/null 2>&1 &
  fi
  rm -f "$0" >/dev/null 2>&1 || true
  exit 1
}}

# Wait for the old process to exit so the .app is not busy.
WAIT=0
while kill -0 "$OLD_PID" >/dev/null 2>&1; do
  WAIT=$((WAIT + 1))
  if [ "$WAIT" -ge {pid_wait} ]; then
    fail_and_restore
  fi
  sleep 1
done

sleep 1

rm -rf "$OLD_APP" >/dev/null 2>&1 || true

MOUNT_POINT="${{TMPDIR:-/tmp}}/openx_update_mount_$$"
rm -rf "$MOUNT_POINT" >/dev/null 2>&1 || true
mkdir -p "$MOUNT_POINT" || fail_and_restore
if ! hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MOUNT_POINT" >/dev/null; then
  fail_and_restore
fi

if [ -d "$MOUNT_POINT/{app_name}" ]; then
  NEW_APP="$MOUNT_POINT/{app_name}"
else
  NEW_APP=$(find "$MOUNT_POINT" -maxdepth 2 -type d -name '{app_name}' 2>/dev/null | head -n 1 || true)
fi

if [ -z "$NEW_APP" ] || [ ! -d "$NEW_APP" ]; then
  fail_and_restore
fi

if [ ! -d "$INSTALL_APP" ]; then
  fail_and_restore
fi

mv "$INSTALL_APP" "$OLD_APP" || fail_and_restore
if ! ditto "$NEW_APP" "$INSTALL_APP"; then
  fail_and_restore
fi

cleanup_mount
MOUNT_POINT=""

"$INSTALL_APP/{binary_rel}" --openx-update-ack="$ACK" >/dev/null 2>&1 &

WAIT=0
while [ ! -f "$ACK" ]; do
  WAIT=$((WAIT + 1))
  if [ "$WAIT" -ge {ack_timeout} ]; then
    fail_and_restore
  fi
  sleep 1
done

rm -rf "$OLD_APP" >/dev/null 2>&1 || true
rm -f "$0" >/dev/null 2>&1 || true
exit 0
"#,
        install = install,
        dmg = dmg,
        old = old,
        ack = ack,
        fail_tpl = fail_tpl,
        fail_flag = fail_flag,
        old_pid = old_pid,
        binary_rel = binary_rel,
        app_name = app_name,
        pid_wait = PID_WAIT_SECONDS,
        ack_timeout = ACK_TIMEOUT_SECONDS,
    )
}

pub fn launch_macos_replace(download_path: &Path) -> Result<(), String> {
    let ext = download_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if ext != "dmg" {
        return Err(format!(
            "不支持的更新包格式: {}（macOS 需要 .dmg）",
            download_path.display()
        ));
    }
    if !download_path.exists() {
        return Err("更新 DMG 不存在".to_string());
    }

    let current_exe =
        std::env::current_exe().map_err(|e| format!("无法获取当前程序路径: {}", e))?;
    let install_app = resolve_app_bundle_from_exe(&current_exe)?;
    if !install_app
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.eq_ignore_ascii_case(APP_BUNDLE_NAME))
        .unwrap_or(false)
    {
        return Err(format!(
            "应用包名不是 {}（当前: {}）",
            APP_BUNDLE_NAME,
            install_app.display()
        ));
    }

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    fs::create_dir_all(update_temp_root()).map_err(|e| format!("创建临时目录失败: {}", e))?;
    let ack_path = update_temp_root().join(format!("update_ack_{}.flag", timestamp));
    let fail_notice_path =
        update_temp_root().join(format!("update_fail_template_{}.txt", timestamp));
    let fail_notice_flag =
        update_temp_root().join(format!("update_fail_notice_{}.flag", timestamp));
    let script_path = update_temp_root().join(format!("replace_{}.sh", timestamp));

    let fail_message = super::config::read_ui_language()
        .eq_ignore_ascii_case("en-US")
        .then_some("Update failed. The previous version has been restored.")
        .unwrap_or("更新失败，已恢复旧版本。");
    fs::write(&fail_notice_path, fail_message)
        .map_err(|e| format!("写入更新失败说明失败: {}", e))?;

    let old_pid = std::process::id();
    let script = build_replace_shell_script(
        &install_app,
        download_path,
        old_pid,
        &ack_path,
        &fail_notice_path,
        &fail_notice_flag,
    );
    fs::write(&script_path, script).map_err(|e| format!("写入替换脚本失败: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&script_path)
            .map_err(|e| format!("读取脚本权限失败: {}", e))?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&script_path, perms)
            .map_err(|e| format!("设置脚本可执行权限失败: {}", e))?;
    }

    let _ = crate::handler::runtime_log::append_runtime_log(
        "info",
        "updater",
        "已写入 macOS 替换脚本，即将重启安装",
        Some(serde_json::json!({
            "script": script_path.to_string_lossy(),
            "dmg": download_path.to_string_lossy(),
            "installApp": install_app.to_string_lossy(),
        })),
    );

    #[cfg(target_os = "macos")]
    {
        Command::new("/bin/sh")
            .arg(&script_path)
            .spawn()
            .map_err(|e| format!("启动替换脚本失败: {}", e))?;
        crate::launcher_restart_focus::mark_focus_after_restart();
        std::process::exit(0);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = Command::new("/bin/sh");
        Err("macOS replace script can only run on macOS".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::{build_replace_shell_script, resolve_app_bundle_from_exe};
    use std::path::PathBuf;

    #[test]
    fn resolves_app_bundle_from_macos_exe_path() {
        let exe = PathBuf::from(
            "/Applications/OpenXLauncher.app/Contents/MacOS/OpenXLauncher",
        );
        let app = resolve_app_bundle_from_exe(&exe).expect("should resolve");
        assert_eq!(app, PathBuf::from("/Applications/OpenXLauncher.app"));
    }

    #[test]
    fn rejects_bare_binary_without_app_bundle() {
        let exe = PathBuf::from("/usr/local/bin/OpenXLauncher");
        let err = resolve_app_bundle_from_exe(&exe).expect_err("should fail");
        assert!(err.contains("OpenXLauncher.app"));
    }

    #[test]
    fn replace_script_contains_hdiutil_and_ditto() {
        let script = build_replace_shell_script(
            &PathBuf::from("/Applications/OpenXLauncher.app"),
            &PathBuf::from("/tmp/OpenXLauncher_1.0.0_macos-aarch64.dmg"),
            12345,
            &PathBuf::from("/tmp/ack.flag"),
            &PathBuf::from("/tmp/fail.txt"),
            &PathBuf::from("/tmp/fail.flag"),
        );
        assert!(script.contains("hdiutil attach"));
        assert!(script.contains("ditto"));
        assert!(script.contains("--openx-update-ack="));
        assert!(script.contains("--openx-update-fail="));
        assert!(script.contains("${TMPDIR:-/tmp}/openx_update_mount_$$"));
        assert!(script.contains("OpenXLauncher_old.app"));
    }
}
