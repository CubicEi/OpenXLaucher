use std::path::PathBuf;

#[cfg(target_os = "linux")]
use std::path::Path;

#[cfg(target_os = "linux")]
const APP_DIRECTORY_NAME: &str = "OpenXLauncher";

const PORTABLE_DATA_DIR_NAME: &str = "OpenX";
const LEGACY_PORTABLE_DATA_DIR_NAME: &str = "RTL";

#[cfg(target_os = "linux")]
struct LinuxXdgDirs<'a> {
    config: Option<&'a Path>,
    data: Option<&'a Path>,
    cache: Option<&'a Path>,
}

#[cfg(target_os = "linux")]
fn linux_writable_paths(xdg: Option<LinuxXdgDirs<'_>>, home: Option<&Path>) -> [PathBuf; 4] {
    let fallback_root = std::env::temp_dir().join(APP_DIRECTORY_NAME);
    let home = home.filter(|path| path.is_absolute());
    let config = xdg
        .as_ref()
        .and_then(|dirs| dirs.config)
        .filter(|path| path.is_absolute())
        .map(|path| path.join(APP_DIRECTORY_NAME))
        .or_else(|| home.map(|path| path.join(".config").join(APP_DIRECTORY_NAME)))
        .unwrap_or_else(|| fallback_root.join("config"));
    let java = xdg
        .as_ref()
        .and_then(|dirs| dirs.data)
        .filter(|path| path.is_absolute())
        .map(|path| path.join(APP_DIRECTORY_NAME).join("java"))
        .or_else(|| {
            home.map(|path| {
                path.join(".local")
                    .join("share")
                    .join(APP_DIRECTORY_NAME)
                    .join("java")
            })
        })
        .unwrap_or_else(|| fallback_root.join("data").join("java"));
    let cache = xdg
        .as_ref()
        .and_then(|dirs| dirs.cache)
        .filter(|path| path.is_absolute())
        .map(|path| path.join(APP_DIRECTORY_NAME))
        .or_else(|| home.map(|path| path.join(".cache").join(APP_DIRECTORY_NAME)))
        .unwrap_or_else(|| fallback_root.join("cache"));
    let minecraft = home
        .map(|path| path.join(".minecraft"))
        .unwrap_or_else(|| fallback_root.join("minecraft"));

    [config, java, cache, minecraft]
}

#[cfg(target_os = "linux")]
fn linux_paths_from_environment() -> [PathBuf; 4] {
    let config = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from);
    let data = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from);
    let cache = std::env::var_os("XDG_CACHE_HOME").map(PathBuf::from);
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let xdg = LinuxXdgDirs {
        config: config.as_deref(),
        data: data.as_deref(),
        cache: cache.as_deref(),
    };

    linux_writable_paths(Some(xdg), home.as_deref())
}

#[cfg(target_os = "linux")]
pub fn linux_config_dir() -> PathBuf {
    linux_paths_from_environment()[0].clone()
}

#[cfg(target_os = "linux")]
pub fn linux_data_dir() -> PathBuf {
    linux_paths_from_environment()[1]
        .parent()
        .expect("Linux Java 目录始终位于应用数据目录下")
        .to_path_buf()
}

#[cfg(target_os = "linux")]
pub fn linux_java_dir() -> PathBuf {
    linux_paths_from_environment()[1].clone()
}

#[cfg(target_os = "linux")]
pub fn linux_cache_dir() -> PathBuf {
    linux_paths_from_environment()[2].clone()
}

#[cfg(target_os = "linux")]
pub fn linux_minecraft_dir() -> PathBuf {
    linux_paths_from_environment()[3].clone()
}

pub fn launcher_exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Portable data root: `<launcher_exe_dir>/OpenX` on Windows, `./OpenX` elsewhere.
pub fn portable_data_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        return launcher_exe_dir().join(PORTABLE_DATA_DIR_NAME);
    }
    #[cfg(not(target_os = "windows"))]
    {
        PathBuf::from(PORTABLE_DATA_DIR_NAME)
    }
}

fn legacy_portable_data_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        return launcher_exe_dir().join(LEGACY_PORTABLE_DATA_DIR_NAME);
    }
    #[cfg(not(target_os = "windows"))]
    {
        PathBuf::from(LEGACY_PORTABLE_DATA_DIR_NAME)
    }
}

/// Launcher-side cache/data root under OpenX (NOT the game `.minecraft` directory).
pub fn portable_minecraft_data_dir() -> PathBuf {
    portable_data_dir().join("minecraft")
}

pub fn portable_config_dir() -> PathBuf {
    portable_data_dir().join("config")
}

pub fn portable_java_dir() -> PathBuf {
    portable_data_dir().join("java")
}

pub fn portable_logs_dir() -> PathBuf {
    portable_data_dir().join("logs")
}

/// JVM 崩溃时默认在进程工作目录写 `hs_err_pid*.log`；重定向到 OpenX/logs，避免污染启动器 exe 目录。
pub fn jvm_hs_err_file_arg() -> String {
    let dir = portable_logs_dir();
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("hs_err_%p.log");
    let s = path.to_string_lossy();
    if s.contains(' ') {
        format!(r#"-XX:ErrorFile="{}""#, s)
    } else {
        format!("-XX:ErrorFile={s}")
    }
}

pub fn portable_bridge_dir() -> PathBuf {
    portable_data_dir().join("bridge")
}

pub fn portable_themes_dir() -> PathBuf {
    portable_data_dir().join("themes")
}

pub fn portable_mod_file_registry_path() -> PathBuf {
    portable_data_dir().join("mod-file-registry.db")
}

fn try_remove_legacy_moddata_db() {
    let legacy = portable_data_dir().join("moddata.db");
    if legacy.is_file() {
        if std::fs::remove_file(&legacy).is_ok() {
            log::info!(
                "Removed legacy moddata.db at {}",
                legacy.display()
            );
        }
    }
}

/// Preferred portable game directory next to the launcher executable.
pub fn portable_game_minecraft_dir() -> PathBuf {
    launcher_exe_dir().join(".minecraft")
}

fn rename_or_copy_dir(src: &std::path::Path, dest: &std::path::Path) {
    if dest.exists() || !src.exists() {
        return;
    }
    if let Some(parent) = dest.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if std::fs::rename(src, dest).is_ok() {
        return;
    }
    // Cross-device rename can fail; fall back to recursive copy then remove.
    if copy_dir_recursive(src, dest).is_ok() {
        let _ = std::fs::remove_dir_all(src);
    }
}

fn migrate_file_if_missing(src: &std::path::Path, dest: &std::path::Path) {
    if dest.exists() || !src.is_file() {
        return;
    }
    if let Some(parent) = dest.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if std::fs::rename(src, dest).is_err() {
        let _ = std::fs::copy(src, dest);
    }
}

fn migrate_dir_if_missing(src: &std::path::Path, dest: &std::path::Path) {
    if dest.exists() || !src.exists() {
        return;
    }
    rename_or_copy_dir(src, dest);
}

#[cfg(target_os = "windows")]
fn migrate_windows_appdata_to_portable() {
    if let Ok(appdata) = std::env::var("APPDATA") {
        let roaming = PathBuf::from(&appdata);
        let legacy = roaming.join("OpenXLauncher");
        migrate_dir_if_missing(&legacy.join("bridge"), &portable_bridge_dir());
        migrate_dir_if_missing(
            &roaming.join("com.openxlauncher.app").join("themes"),
            &portable_themes_dir(),
        );
    }

    if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
        let legacy_bridge = PathBuf::from(&localappdata)
            .join("OpenXLauncher")
            .join("bridge");
        if !portable_bridge_dir().exists() {
            migrate_dir_if_missing(&legacy_bridge, &portable_bridge_dir());
        }
    }
}

fn copy_dir_recursive(src: &std::path::Path, dest: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let entry_path = entry.path();
        let dest_path = dest.join(entry.file_name());
        if entry_path.is_dir() {
            copy_dir_recursive(&entry_path, &dest_path)?;
        } else {
            std::fs::copy(&entry_path, &dest_path)?;
        }
    }
    Ok(())
}

/// Migrate legacy portable layouts:
/// - `RTL/` → `OpenX/`
/// - `<exe_dir>/minecraft` → `OpenX/minecraft`
#[cfg(target_os = "macos")]
fn migrate_macos_app_support() {
    if let Ok(home) = std::env::var("HOME") {
        let old = PathBuf::from(&home).join("Library/Application Support/OpenXLauncher");
        let new = PathBuf::from(&home).join("Library/Application Support/OpenXLauncher");
        rename_or_copy_dir(&old, &new);
    }
}

#[cfg(target_os = "linux")]
fn migrate_linux_xdg_dirs() {
    if let Ok(home) = std::env::var("HOME") {
        let home = PathBuf::from(home);
        rename_or_copy_dir(
            &home.join(".config/OpenXLauncher"),
            &home.join(".config/OpenXLauncher"),
        );
        rename_or_copy_dir(
            &home.join(".local/share/OpenXLauncher"),
            &home.join(".local/share/OpenXLauncher"),
        );
        rename_or_copy_dir(
            &home.join(".cache/OpenXLauncher"),
            &home.join(".cache/OpenXLauncher"),
        );
    }
}

pub fn migrate_portable_layout() {
    let new_root = portable_data_dir();
    let old_root = legacy_portable_data_dir();
    rename_or_copy_dir(&old_root, &new_root);

    let new_mc = portable_minecraft_data_dir();
    let old_mc = launcher_exe_dir().join("minecraft");
    // Avoid treating OpenX/minecraft as the legacy root when already migrated.
    if old_mc != new_mc {
        rename_or_copy_dir(&old_mc, &new_mc);
    }

    #[cfg(target_os = "macos")]
    migrate_macos_app_support();
    #[cfg(target_os = "linux")]
    migrate_linux_xdg_dirs();

    #[cfg(target_os = "windows")]
    migrate_windows_appdata_to_portable();
}

pub fn ensure_portable_dirs() {
    migrate_portable_layout();
    try_remove_legacy_moddata_db();
    let _ = std::fs::create_dir_all(portable_config_dir());
    let _ = std::fs::create_dir_all(portable_java_dir());
    let _ = std::fs::create_dir_all(portable_logs_dir());
    let _ = std::fs::create_dir_all(portable_minecraft_data_dir());
    let _ = std::fs::create_dir_all(portable_bridge_dir());
    let _ = std::fs::create_dir_all(portable_themes_dir());
}
