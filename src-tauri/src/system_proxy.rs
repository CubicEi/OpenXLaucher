use serde_json::json;

/// 将操作系统代理设置同步到进程环境变量，供 reqwest 自动使用。
/// 若已设置 `HTTP_PROXY` / `HTTPS_PROXY` 则不再覆盖（尊重用户/父进程配置）。
pub fn apply_system_proxy_env() {
    if proxy_env_already_set() {
        return;
    }

    let sys = match sysproxy::Sysproxy::get_system_proxy() {
        Ok(p) => p,
        Err(e) => {
            let _ = crate::handler::runtime_log::append_runtime_log(
                "debug",
                "network",
                "读取系统代理失败",
                Some(json!({ "error": e.to_string() })),
            );
            return;
        }
    };

    if !sys.enable || sys.host.is_empty() || sys.port == 0 {
        return;
    }

    let proxy_url = format!("http://{}:{}", sys.host, sys.port);
    std::env::set_var("HTTP_PROXY", &proxy_url);
    std::env::set_var("HTTPS_PROXY", &proxy_url);
    if !sys.bypass.is_empty() {
        std::env::set_var("NO_PROXY", &sys.bypass);
    }

    let _ = crate::handler::runtime_log::append_runtime_log(
        "info",
        "network",
        "已应用系统代理",
        Some(json!({
            "httpProxy": proxy_url,
            "bypass": sys.bypass,
        })),
    );
}

fn proxy_env_already_set() -> bool {
    ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]
        .iter()
        .any(|key| std::env::var_os(key).is_some())
}
