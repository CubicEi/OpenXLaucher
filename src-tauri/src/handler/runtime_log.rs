use serde::Serialize;
use serde_json::Value;
use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize)]
struct RuntimeLogRecord {
    timestamp: u64,
    level: String,
    category: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn append_runtime_log(
    level: &str,
    category: &str,
    message: &str,
    data: Option<Value>,
) -> Result<(), String> {
    crate::app_paths::ensure_portable_dirs();
    let path = crate::app_paths::portable_logs_dir().join("launcher.log");

    let record = RuntimeLogRecord {
        timestamp: unix_ms(),
        level: level.to_string(),
        category: category.to_string(),
        message: message.to_string(),
        data,
    };

    let line = serde_json::to_string(&record).map_err(|e| e.to_string())?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open {}: {}", path.display(), e))?;
    writeln!(file, "{}", line).map_err(|e| e.to_string())?;
    Ok(())
}

/// Append one NDJSON line to `<exe_dir>/OpenX/logs/launcher.log`.
#[tauri::command]
pub fn write_runtime_log(
    level: String,
    category: String,
    message: String,
    data: Option<Value>,
) -> Result<(), String> {
    append_runtime_log(&level, &category, &message, data)
}
