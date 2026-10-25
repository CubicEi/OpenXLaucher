use chrono::Local;
use serde_json::Value;
use std::io::Write;

/// Map caller level strings to launcher log labels: INFO / WARN / ERROR / PANIC.
pub fn normalize_log_level(level: &str) -> &'static str {
    match level.to_ascii_lowercase().as_str() {
        "warn" | "warning" => "WARN",
        "error" | "err" => "ERROR",
        "panic" => "PANIC",
        "debug" | "trace" => "INFO",
        _ => "INFO",
    }
}

/// Local system time with second precision (`YYYY-MM-DD HH:MM:SS`).
pub fn format_local_timestamp() -> String {
    Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

/// `[系统时间 LEVEL] 用户操作/结果`
pub fn format_runtime_log_line(level: &str, body: &str) -> String {
    format!(
        "[{} {}] {}",
        format_local_timestamp(),
        normalize_log_level(level),
        body
    )
}

pub fn build_log_body(category: &str, message: &str, data: Option<&Value>) -> String {
    let main = if category.is_empty() {
        message.to_string()
    } else {
        format!("{}/{}", category, message)
    };

    match data {
        None => main,
        Some(v) if v.is_null() => main,
        Some(v) => {
            let extra = serde_json::to_string(v).unwrap_or_default();
            if extra.is_empty() || extra == "{}" {
                main
            } else {
                format!("{} {}", main, extra)
            }
        }
    }
}

pub fn append_runtime_log(
    level: &str,
    category: &str,
    message: &str,
    data: Option<Value>,
) -> Result<(), String> {
    crate::app_paths::ensure_portable_dirs();
    let path = crate::app_paths::portable_logs_dir().join("launcher.log");

    let body = build_log_body(category, message, data.as_ref());
    let line = format_runtime_log_line(level, &body);

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open {}: {}", path.display(), e))?;
    writeln!(file, "{}", line).map_err(|e| e.to_string())?;
    Ok(())
}

/// Append one line to `<exe_dir>/OpenX/logs/launcher.log`.
#[tauri::command]
pub fn write_runtime_log(
    level: String,
    category: String,
    message: String,
    data: Option<Value>,
) -> Result<(), String> {
    append_runtime_log(&level, &category, &message, data)
}
