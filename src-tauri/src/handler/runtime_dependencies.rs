use serde::Serialize;

#[derive(Clone, Serialize)]
pub struct RuntimeDependency {
    pub id: String,
    pub name: String,
    pub description: String,
    pub download_url: String,
}

#[derive(Clone, Serialize)]
pub struct RuntimeDependencyReport {
    pub ready: bool,
    pub missing: Vec<RuntimeDependency>,
}

#[cfg(target_os = "windows")]
fn webview2_version_from_key(hkey: winreg::HKEY, subkey: &str) -> bool {
    use winreg::RegKey;

    RegKey::predef(hkey)
        .open_subkey(subkey)
        .and_then(|key| key.get_value::<String, _>("pv"))
        .ok()
        .map(|version| {
            !version.is_empty() && version != "0.0.0.0" && version != "0.0.0.0.0"
        })
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn is_webview2_installed() -> bool {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

    const CLIENT_ID: &str =
        r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7CC4D}";
    const CLIENT_ID_WOW: &str =
        r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7CC4D}";

    for hkey in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        if webview2_version_from_key(hkey, CLIENT_ID)
            || webview2_version_from_key(hkey, CLIENT_ID_WOW)
        {
            return true;
        }
    }

    false
}

#[tauri::command]
pub fn check_runtime_dependencies() -> RuntimeDependencyReport {
    let mut missing = Vec::new();

    #[cfg(target_os = "windows")]
    {
        if !is_webview2_installed() {
            missing.push(RuntimeDependency {
                id: "webview2".into(),
                name: "Microsoft Edge WebView2 运行时".into(),
                description:
                    "便携版启动器界面依赖 WebView2。请安装 Evergreen 运行时后重新启动 RTLauncher。"
                        .into(),
                download_url: "https://go.microsoft.com/fwlink/p/?LinkId=2124703".into(),
            });
        }
    }

    RuntimeDependencyReport {
        ready: missing.is_empty(),
        missing,
    }
}
