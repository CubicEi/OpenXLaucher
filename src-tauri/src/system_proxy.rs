use serde_json::json;
use std::sync::Mutex;

static LAST_APPLIED_PROXY: Mutex<Option<(String, String, Option<String>)>> = Mutex::new(None);

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProxySettings {
    enable: bool,
    host: String,
    port: u16,
    bypass: String,
}

/// 将操作系统代理设置同步到进程环境变量，供 reqwest 自动使用。
/// 若已设置 `HTTP_PROXY` / `HTTPS_PROXY` 则不再覆盖（尊重用户/父进程配置）。
pub fn apply_system_proxy_env() {
    if !crate::handler::config::network_proxy_preference_enabled() {
        return;
    }

    if proxy_env_already_set() {
        return;
    }

    let sys = match read_system_proxy() {
        Ok(p) => p,
        Err(e) => {
            let _ = crate::handler::runtime_log::append_runtime_log(
                "debug",
                "network",
                "读取系统代理失败",
                Some(json!({ "error": e })),
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
    let no_proxy_val = if sys.bypass.is_empty() {
        None
    } else {
        std::env::set_var("NO_PROXY", &sys.bypass);
        Some(sys.bypass.clone())
    };
    if let Ok(mut last) = LAST_APPLIED_PROXY.lock() {
        *last = Some((proxy_url.clone(), proxy_url.clone(), no_proxy_val));
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

fn read_system_proxy() -> Result<ProxySettings, String> {
    #[cfg(target_os = "windows")]
    {
        return read_windows_system_proxy();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let sys = sysproxy::Sysproxy::get_system_proxy().map_err(|e| e.to_string())?;
        Ok(ProxySettings {
            enable: sys.enable,
            host: sys.host,
            port: sys.port,
            bypass: sys.bypass,
        })
    }
}

#[cfg(target_os = "windows")]
fn read_windows_system_proxy() -> Result<ProxySettings, String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;

    const SUB_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let settings = hkcu
        .open_subkey_with_flags(SUB_KEY, KEY_READ)
        .map_err(|e| format!("打开注册表失败: {}", e))?;

    let enable = settings
        .get_value::<u32, _>("ProxyEnable")
        .unwrap_or(0)
        == 1;
    let server = settings
        .get_value::<String, _>("ProxyServer")
        .unwrap_or_default();
    let bypass = settings
        .get_value::<String, _>("ProxyOverride")
        .unwrap_or_default();

    let (host, port) = parse_windows_proxy_server(&server)?;

    Ok(ProxySettings {
        enable,
        host,
        port,
        bypass,
    })
}

/// Windows `ProxyServer` 常见格式：
/// - `127.0.0.1:7890`
/// - `http=127.0.0.1:7890;https=127.0.0.1:7890`
/// - `socks=127.0.0.1:1080`
#[cfg(any(target_os = "windows", test))]
fn parse_windows_proxy_server(server: &str) -> Result<(String, u16), String> {
    let trimmed = server.trim();
    if trimmed.is_empty() {
        return Ok((String::new(), 0));
    }

    let segment = select_proxy_segment(trimmed);
    let addr = strip_proxy_scheme_prefix(segment);
    parse_host_port(addr).ok_or_else(|| format!("failed to parse string"))
}

#[cfg(any(target_os = "windows", test))]
fn select_proxy_segment(server: &str) -> &str {
    if !server.contains('=') {
        return server;
    }
    for part in server.split(';') {
        let p = part.trim();
        if p.len() >= 5 && p[..5].eq_ignore_ascii_case("http=") {
            return p;
        }
    }
    for part in server.split(';') {
        let p = part.trim();
        if p.len() >= 6 && p[..6].eq_ignore_ascii_case("https=") {
            return p;
        }
    }
    server.split(';').next().unwrap_or(server).trim()
}

#[cfg(any(target_os = "windows", test))]
fn strip_proxy_scheme_prefix(segment: &str) -> &str {
    let value = if let Some(eq) = segment.find('=') {
        segment[eq + 1..].trim()
    } else {
        segment.trim()
    };
    value
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .trim_start_matches("socks://")
        .trim_start_matches("socks5://")
}

#[cfg(any(target_os = "windows", test))]
fn parse_host_port(addr: &str) -> Option<(String, u16)> {
    let addr = addr.trim();
    if addr.is_empty() {
        return Some((String::new(), 0));
    }

    if let Some(rest) = addr.strip_prefix('[') {
        let end = rest.find(']')?;
        let host = rest[..end].to_string();
        let port_part = rest[end + 1..].strip_prefix(':')?;
        let port = port_part.parse().ok()?;
        return Some((host, port));
    }

    if let Some((host, port_str)) = addr.rsplit_once(':') {
        if !host.is_empty() && host.contains('.') && !host.contains(':') {
            let port: u16 = port_str.parse().ok()?;
            return Some((host.to_string(), port));
        }
        if host.chars().all(|c| c.is_ascii_digit() || c == '.') {
            let port: u16 = port_str.parse().ok()?;
            return Some((host.to_string(), port));
        }
    }

    if let Some((host, port_str)) = addr.rsplit_once(':') {
        if !host.is_empty() {
            if let Ok(port) = port_str.parse::<u16>() {
                return Some((host.to_string(), port));
            }
        }
    }

    None
}

fn proxy_env_already_set() -> bool {
    ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]
        .iter()
        .any(|key| std::env::var_os(key).is_some())
}

/// 清除本进程曾根据系统代理写入的环境变量（仅在值仍一致时移除，避免误删用户手动设置）。
pub fn clear_applied_system_proxy_env() {
    let snapshot = LAST_APPLIED_PROXY.lock().ok().and_then(|g| g.clone());
    let Some((http, https, no_proxy)) = snapshot else {
        return;
    };
    if std::env::var("HTTP_PROXY").ok().as_ref() == Some(&http) {
        std::env::remove_var("HTTP_PROXY");
    }
    if std::env::var("HTTPS_PROXY").ok().as_ref() == Some(&https) {
        std::env::remove_var("HTTPS_PROXY");
    }
    match no_proxy {
        Some(ref bypass) if std::env::var("NO_PROXY").ok().as_ref() == Some(bypass) => {
            std::env::remove_var("NO_PROXY");
        }
        Some(_) => {}
        None => {
            if std::env::var("NO_PROXY").ok().unwrap_or_default().is_empty() {
                std::env::remove_var("NO_PROXY");
            }
        }
    }
    if let Ok(mut g) = LAST_APPLIED_PROXY.lock() {
        *g = None;
    }
}

/// 设置项「使用系统代理」变更后调用：按偏好重新应用或清除。
pub fn reapply_system_proxy_from_preferences() {
    clear_applied_system_proxy_env();
    apply_system_proxy_env();
    crate::http_client::reset_cached_http_clients();
}

#[cfg(test)]
mod tests {
    use super::{parse_host_port, parse_windows_proxy_server, select_proxy_segment};

    #[test]
    fn parses_simple_host_port() {
        assert_eq!(
            parse_windows_proxy_server("127.0.0.1:7890").unwrap(),
            ("127.0.0.1".into(), 7890)
        );
    }

    #[test]
    fn parses_multi_protocol_string() {
        assert_eq!(
            parse_windows_proxy_server("http=127.0.0.1:7890;https=127.0.0.1:7890").unwrap(),
            ("127.0.0.1".into(), 7890)
        );
    }

    #[test]
    fn prefers_http_in_mixed_list() {
        let seg = select_proxy_segment("socks=127.0.0.1:1080;http=127.0.0.1:7890");
        assert!(seg.starts_with("http="));
    }

    #[test]
    fn parses_ipv6_bracket_form() {
        assert_eq!(
            parse_host_port("[::1]:7890").unwrap(),
            ("::1".into(), 7890)
        );
    }
}
