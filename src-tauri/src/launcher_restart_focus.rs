//! 用户触发的 `app.restart()` 后，下一段进程将主窗口置于前台。

use std::path::PathBuf;
use std::time::Duration;

use tauri::WebviewWindow;

use crate::app_paths::portable_config_dir;

const FLAG_FILE: &str = "focus-after-restart.flag";

fn flag_path() -> PathBuf {
    portable_config_dir().join(FLAG_FILE)
}

pub fn mark_focus_after_restart() {
    let _ = std::fs::write(flag_path(), b"1");
}

pub fn take_focus_after_restart() -> bool {
    let path = flag_path();
    if !path.is_file() {
        return false;
    }
    let _ = std::fs::remove_file(path);
    true
}

pub fn raise_main_window(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();

    #[cfg(target_os = "windows")]
    {
        // 部分场景下仅 set_focus 无法压过前台窗口锁；短暂置顶再还原更可靠。
        let _ = window.set_always_on_top(true);
        let _ = window.set_focus();
        let _ = window.set_always_on_top(false);
    }
}

/// 窗口刚创建时 WebView 可能尚未就绪，略延迟再抢焦点。
pub fn schedule_raise_main_window_after_restart(window: WebviewWindow) {
    if !take_focus_after_restart() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(120)).await;
        raise_main_window(&window);
        tokio::time::sleep(Duration::from_millis(280)).await;
        raise_main_window(&window);
    });
}
