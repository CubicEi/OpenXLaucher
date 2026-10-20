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
fn is_webview2_installed() -> bool {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;

    const WEBVIEW2_CLIENT_ID: &str =
        r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7CC4D}";
    const WEBVIEW2_CLIENT_ID_WOW: &str =
        r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7CC4D}";

    fn version_from_key(key_path: &str) -> bool {
        RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey(key_path)
            .and_then(|key| key.get_value::<String, _>("pv"))
            .ok()
            .map(|version| {
                !version.is_empty() && version != "0.0.0.0" && version != "0.0.0.0.0"
            })
            .unwrap_or(false)
    }

    version_from_key(WEBVIEW2_CLIENT_ID) || version_from_key(WEBVIEW2_CLIENT_ID_WOW)
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
