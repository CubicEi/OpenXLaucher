use chrono::{Local, TimeZone};
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

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

pub fn launcher_log_path() -> PathBuf {
    crate::app_paths::portable_logs_dir().join("launcher.log")
}

/// 从日志行 `[YYYY-MM-DD HH:MM:SS LEVEL] ...` 解析时间戳。
fn parse_log_line_timestamp(line: &str) -> Option<String> {
    let line = line.trim();
    if !line.starts_with('[') {
        return None;
    }
    let rest = line.strip_prefix('[')?;
    let end = rest.find(']')?;
    let header = &rest[..end];
    let ts = header.split_whitespace().next()?;
    if ts.len() != 19 {
        return None;
    }
    let bytes = ts.as_bytes();
    let ok = bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b' '
        && bytes[13] == b':'
        && bytes[16] == b':'
        && bytes[..4].iter().all(|c| c.is_ascii_digit())
        && bytes[5..7].iter().all(|c| c.is_ascii_digit())
        && bytes[8..10].iter().all(|c| c.is_ascii_digit())
        && bytes[11..13].iter().all(|c| c.is_ascii_digit())
        && bytes[14..16].iter().all(|c| c.is_ascii_digit())
        && bytes[17..19].iter().all(|c| c.is_ascii_digit());
    if ok {
        Some(ts.to_string())
    } else {
        None
    }
}

fn first_timestamp_in_log_file(path: &Path) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    for line in content.lines() {
        if let Some(ts) = parse_log_line_timestamp(line) {
            return Some(ts);
        }
    }
    None
}

fn timestamp_to_archive_suffix(ts: &str) -> String {
    ts.replace(' ', "_").replace(':', "-")
}

fn unique_archive_path(logs_dir: &Path, base_name: &str) -> PathBuf {
    let mut candidate = logs_dir.join(base_name);
    if !candidate.exists() {
        return candidate;
    }
    let stem = base_name.strip_suffix(".log").unwrap_or(base_name);
    for n in 2..10_000 {
        let name = format!("{}-{}.log", stem, n);
        candidate = logs_dir.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    logs_dir.join(format!(
        "{}-{}.log",
        stem,
        Local::now().format("%Y%m%d%H%M%S")
    ))
}

/// 启动时将现有 `launcher.log` 归档为 `launcher-<首条时间戳>.log`（时间戳中的空格、冒号会规范化）。
pub fn rotate_launcher_log_on_startup() {
    crate::app_paths::ensure_portable_dirs();
    let path = launcher_log_path();
    let meta = match fs::metadata(&path) {
        Ok(m) => m,
        Err(_) => return,
    };
    if meta.len() == 0 {
        let _ = fs::remove_file(&path);
        return;
    }

    let ts = first_timestamp_in_log_file(&path).unwrap_or_else(|| {
        meta.modified()
            .ok()
            .and_then(|t| {
                let secs = t
                    .duration_since(std::time::UNIX_EPOCH)
                    .ok()?
                    .as_secs();
                let dt = Local.timestamp_opt(secs as i64, 0).single()?;
                Some(dt.format("%Y-%m-%d %H:%M:%S").to_string())
            })
            .unwrap_or_else(|| Local::now().format("%Y-%m-%d %H:%M:%S").to_string())
    });

    let archive_name = format!("launcher-{}.log", timestamp_to_archive_suffix(&ts));
    let logs_dir = crate::app_paths::portable_logs_dir();
    let dest = unique_archive_path(&logs_dir, &archive_name);

    if let Err(e) = fs::rename(&path, &dest) {
        eprintln!(
            "[runtime_log] 归档 launcher.log 失败: {} → {} ({})",
            path.display(),
            dest.display(),
            e
        );
    }
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
    let path = launcher_log_path();

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
