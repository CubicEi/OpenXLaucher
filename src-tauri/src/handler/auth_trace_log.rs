//! 登录 / 鉴权各子阶段 → `OpenX/logs/launcher.log`。

use serde_json::{json, Value};

fn merge_payload(step: &str, flow: &str, data: Option<Value>) -> Value {
    match data {
        Some(Value::Object(mut map)) => {
            map.insert("step".to_string(), json!(step));
            map.insert("flow".to_string(), json!(flow));
            Value::Object(map)
        }
        Some(other) => json!({ "step": step, "flow": flow, "extra": other }),
        None => json!({ "step": step, "flow": flow }),
    }
}

pub fn auth_trace(flow: &str, step: &str, message: &str, data: Option<Value>) {
    let _ = crate::handler::runtime_log::append_runtime_log(
        "info",
        "auth",
        message,
        Some(merge_payload(step, flow, data)),
    );
}

pub fn auth_trace_warn(flow: &str, step: &str, message: &str, data: Option<Value>) {
    let _ = crate::handler::runtime_log::append_runtime_log(
        "warn",
        "auth",
        message,
        Some(merge_payload(step, flow, data)),
    );
}

pub fn auth_trace_error(flow: &str, step: &str, message: &str, data: Option<Value>) {
    let _ = crate::handler::runtime_log::append_runtime_log(
        "error",
        "auth",
        message,
        Some(merge_payload(step, flow, data)),
    );
}
