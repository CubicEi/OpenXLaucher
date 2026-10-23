use std::fs;
use std::path::{Path, PathBuf};

const ACK_ARG_PREFIX: &str = "--openx-update-ack=";

/// Parse `--openx-update-ack=<path>` from process args (Windows update verify).
pub fn parse_update_ack_path_from_args() -> Option<PathBuf> {
    std::env::args()
        .find_map(|arg| arg.strip_prefix(ACK_ARG_PREFIX).map(PathBuf::from))
}

/// Ack files must live under the system temp directory (fail closed).
pub fn is_allowed_ack_path(path: &Path) -> bool {
    let temp = std::env::temp_dir();
    let Ok(canonical_temp) = temp.canonicalize() else {
        return false;
    };
    let Ok(canonical_path) = path.canonicalize() else {
        // File may not exist yet; check parent under temp.
        let parent = path.parent();
        if parent.is_none() {
            return false;
        }
        let parent = parent.unwrap();
        if let Ok(p) = parent.canonicalize() {
            return p.starts_with(&canonical_temp);
        }
        let temp_str = canonical_temp.to_string_lossy().to_lowercase();
        let path_str = path.to_string_lossy().to_lowercase();
        return path_str.starts_with(&temp_str);
    };
    canonical_path.starts_with(canonical_temp)
}

/// Write ack after the main window is ready (called from `lib.rs` setup).
pub fn write_update_ack_if_requested() {
    let Some(path) = parse_update_ack_path_from_args() else {
        return;
    };
    if !is_allowed_ack_path(&path) {
        eprintln!(
            "[更新器] 拒绝写入 ack：路径不在系统临时目录内 ({})",
            path.display()
        );
        return;
    }
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    match fs::write(&path, b"ok\n") {
        Ok(()) => eprintln!("[更新器] 已写入更新 ack: {}", path.display()),
        Err(e) => eprintln!("[更新器] 写入 ack 失败: {}", e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ack_arg_extracts_path() {
        let path = PathBuf::from(r"C:\Temp\OpenXLauncher\ack.flag");
        let arg = format!("{}{}", ACK_ARG_PREFIX, path.display());
        assert_eq!(
            arg.strip_prefix(ACK_ARG_PREFIX).map(PathBuf::from),
            Some(path)
        );
    }
}
