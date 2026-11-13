//! 启动流程遥测 → `OpenX/logs/launcher.log`（与 runtime_log 同格式）。
//! 从用户点击启动到 Java 进程 spawn 的各步骤。

use serde_json::{json, Value};

fn merge_payload(step: &str, data: Option<Value>) -> Value {
    match data {
        Some(Value::Object(mut map)) => {
            map.insert("step".to_string(), json!(step));
            Value::Object(map)
        }
        Some(other) => json!({ "step": step, "extra": other }),
        None => json!({ "step": step }),
    }
}

pub fn launch_trace(step: &str, message: &str, data: Option<Value>) {
    let _ = crate::handler::runtime_log::append_runtime_log(
        "info",
        "launch",
        message,
        Some(merge_payload(step, data)),
    );
}

pub fn launch_trace_warn(step: &str, message: &str, data: Option<Value>) {
    let _ = crate::handler::runtime_log::append_runtime_log(
        "warn",
        "launch",
        message,
        Some(merge_payload(step, data)),
    );
}

pub fn launch_trace_error(step: &str, message: &str, data: Option<Value>) {
    let _ = crate::handler::runtime_log::append_runtime_log(
        "error",
        "launch",
        message,
        Some(merge_payload(step, data)),
    );
}
