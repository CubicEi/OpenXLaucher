use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

const ACK_ARG_PREFIX: &str = "--openx-update-ack=";

static POST_UPDATE_SUCCESS_PENDING: AtomicBool = AtomicBool::new(false);

fn normalize_ack_path_str(raw: &str) -> &str {
    raw.trim().trim_matches('"')
}

/// Parse `--openx-update-ack=<path>` from process args (Windows update verify).
pub fn parse_update_ack_path_from_args() -> Option<PathBuf> {
    std::env::args().find_map(|arg| {
        arg.strip_prefix(ACK_ARG_PREFIX)
            .map(normalize_ack_path_str)
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
    })
}

/// Parse ack path from argv slices (e.g. single-instance second launch).
pub fn parse_update_ack_path_from_argv(args: &[String]) -> Option<PathBuf> {
    args.iter().find_map(|arg| {
        arg.strip_prefix(ACK_ARG_PREFIX)
            .map(normalize_ack_path_str)
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
    })
}

/// Frontend calls once per process to show the in-app update success dialog.
pub fn take_post_update_success_pending() -> bool {
    POST_UPDATE_SUCCESS_PENDING.swap(false, Ordering::SeqCst)
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

fn write_ack_file(path: &Path) -> bool {
    if !is_allowed_ack_path(path) {
        eprintln!(
            "[更新器] 拒绝写入 ack：路径不在系统临时目录内 ({})",
            path.display()
        );
        return false;
    }
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    match fs::write(path, b"ok\n") {
        Ok(()) => {
            eprintln!("[更新器] 已写入更新 ack: {}", path.display());
            POST_UPDATE_SUCCESS_PENDING.store(true, Ordering::SeqCst);
            true
        }
        Err(e) => {
            eprintln!("[更新器] 写入 ack 失败: {}", e);
            false
        }
    }
}

/// Write ack as early as possible so the Windows replace script can finish (called from `lib.rs` setup).
pub fn write_update_ack_if_requested() {
    let Some(path) = parse_update_ack_path_from_args() else {
        return;
    };
    write_ack_file(&path);
}

/// When a second instance forwards update ack args to the running process.
pub fn write_update_ack_from_argv(args: &[String]) {
    let Some(path) = parse_update_ack_path_from_argv(args) else {
        return;
    };
    write_ack_file(&path);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ack_arg_extracts_path() {
        let path = PathBuf::from(r"C:\Temp\OpenXLauncher\ack.flag");
        let arg = format!("{}{}", ACK_ARG_PREFIX, path.display());
        assert_eq!(
            parse_update_ack_path_from_argv(&[arg]),
            Some(path)
        );
    }

    #[test]
    fn parse_ack_arg_strips_surrounding_quotes() {
        let path = PathBuf::from(r"C:\Temp\OpenXLauncher\ack.flag");
        let arg = format!("{}\"{}\"", ACK_ARG_PREFIX, path.display());
        assert_eq!(
            parse_update_ack_path_from_argv(&[arg]),
            Some(path)
        );
    }
}
