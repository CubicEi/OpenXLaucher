//! Strict Java resolution — never falls back to bare `"java"`.

use crate::downloader::mod_loader_installer_shared::{
    pick_java_executable_strict, required_java_major_for_mc,
};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaCheckResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub java_path: Option<String>,
    pub required_major: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

pub fn check_java_for_mc(mc_version: &str, needs_java: bool) -> JavaCheckResult {
    let required_major = required_java_major_for_mc(mc_version);
    if !needs_java {
        return JavaCheckResult {
            ok: true,
            java_path: None,
            required_major,
            error_code: None,
            error_message: None,
        };
    }
    match pick_java_executable_strict(mc_version) {
        Ok(path) => JavaCheckResult {
            ok: true,
            java_path: Some(path),
            required_major,
            error_code: None,
            error_message: None,
        },
        Err(code) => {
            let (error_code, error_message) = match code.as_str() {
                "JAVA_TOO_OLD" => (
                    "JAVA_TOO_OLD".to_string(),
                    format!(
                        "当前 Java 版本过低（需要 {}+），请下载或选择更高版本的 Java。",
                        required_major
                    ),
                ),
                "JAVA_INVALID" => (
                    "JAVA_INVALID".to_string(),
                    "已配置的 Java 路径无效或不可执行，请重新配置。".to_string(),
                ),
                _ => (
                    "JAVA_MISSING".to_string(),
                    format!(
                        "未找到适用于 Minecraft {} 的 Java {}+，请先前往设置下载或配置 Java。",
                        mc_version, required_major
                    ),
                ),
            };
            JavaCheckResult {
                ok: false,
                java_path: None,
                required_major,
                error_code: Some(error_code),
                error_message: Some(error_message),
            }
        }
    }
}

/// Err string with `CODE: message` prefix for invoke callers.
pub fn require_java_or_err(mc_version: &str) -> Result<String, String> {
    let r = check_java_for_mc(mc_version, true);
    if r.ok {
        Ok(r.java_path.unwrap_or_default())
    } else {
        Err(format!(
            "{}: {}",
            r.error_code.as_deref().unwrap_or("JAVA_MISSING"),
            r.error_message
                .as_deref()
                .unwrap_or("未找到合适的 Java")
        ))
    }
}
