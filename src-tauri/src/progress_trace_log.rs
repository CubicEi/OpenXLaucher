//! Progress telemetry → `OpenX/logs/launcher.log` (same format as runtime_log).

use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};

const SESSION_ID: &str = "ffb500";

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Progress trace point. Written as `[time INFO] progress/<message> {json}` in launcher.log.
pub fn progress_trace(hypothesis_id: &str, location: &str, message: &str, data: Value) {
    let payload = json!({
        "sessionId": SESSION_ID,
        "hypothesisId": hypothesis_id,
        "location": location,
        "timestamp": now_ms(),
        "data": data,
    });
    let _ = crate::handler::runtime_log::append_runtime_log(
        "info",
        "progress",
        message,
        Some(payload),
    );
}
