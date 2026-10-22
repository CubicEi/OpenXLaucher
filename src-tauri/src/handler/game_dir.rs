//! Canonical game directory paths for instance-scoped mod update guards.

use std::fs;
use std::path::{Path, PathBuf};

/// Normalize a game directory for stable comparison (instanceDir / `--game-dir`).
pub fn canonical_game_dir(path: &Path) -> String {
    let resolved = if path.exists() {
        fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
    } else {
        path.to_path_buf()
    };
    normalize_path_key(resolved)
}

fn normalize_path_key(path: PathBuf) -> String {
    let s = path.to_string_lossy();
    #[cfg(target_os = "windows")]
    {
        return s.replace('/', "\\").to_ascii_lowercase();
    }
    #[cfg(not(target_os = "windows"))]
    {
        s.to_string()
    }
}

pub fn game_dirs_equal(a: &str, b: &str) -> bool {
    if a.trim().is_empty() || b.trim().is_empty() {
        return false;
    }
    canonical_game_dir(Path::new(a)) == canonical_game_dir(Path::new(b))
}

/// Same rule as launcher JVM `--game-dir` (version-isolated instance vs vanilla root).
pub fn compute_game_directory(minecraft_path: &str, load_type: &str, load_name: &str) -> PathBuf {
    let root = PathBuf::from(minecraft_path);
    if load_type != "0" && !load_name.trim().is_empty() {
        root.join("versions").join(load_name.trim())
    } else {
        root
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn game_dirs_equal_is_case_insensitive_on_windows() {
        if cfg!(target_os = "windows") {
            assert!(game_dirs_equal(r"C:\Games\.minecraft", r"c:\games\.minecraft"));
        }
    }
}
