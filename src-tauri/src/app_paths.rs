#[cfg(target_os = "linux")]
use std::path::{Path, PathBuf};

#[cfg(target_os = "linux")]
const APP_DIRECTORY_NAME: &str = "RTLauncher";

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

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn linux_writable_paths_are_absolute_and_outside_appimage_mount() {
        let home = Path::new("/home/tester");
        let appdir = Path::new("/tmp/.mount_RTLaun");

        let paths = linux_writable_paths(None, Some(home));

        assert!(paths.iter().all(|path| path.is_absolute()));
        assert!(paths.iter().all(|path| !path.starts_with(appdir)));
        assert_eq!(paths[0], home.join(".config/RTLauncher"));
        assert_eq!(paths[1], home.join(".local/share/RTLauncher/java"));
        assert_eq!(paths[2], home.join(".cache/RTLauncher"));
        assert_eq!(paths[3], home.join(".minecraft"));
    }

    #[test]
    fn linux_writable_paths_honor_absolute_xdg_directories() {
        let home = Path::new("/home/tester");
        let xdg = LinuxXdgDirs {
            config: Some(Path::new("/mnt/config")),
            data: Some(Path::new("/mnt/data")),
            cache: Some(Path::new("/mnt/cache")),
        };

        let paths = linux_writable_paths(Some(xdg), Some(home));

        assert_eq!(paths[0], Path::new("/mnt/config/RTLauncher"));
        assert_eq!(paths[1], Path::new("/mnt/data/RTLauncher/java"));
        assert_eq!(paths[2], Path::new("/mnt/cache/RTLauncher"));
        assert_eq!(paths[3], home.join(".minecraft"));
    }

    #[test]
    fn linux_writable_paths_never_use_relative_environment_directories() {
        let xdg = LinuxXdgDirs {
            config: Some(Path::new("relative/config")),
            data: Some(Path::new("relative/data")),
            cache: Some(Path::new("relative/cache")),
        };

        let paths = linux_writable_paths(Some(xdg), Some(Path::new("relative/home")));

        assert!(paths.iter().all(|path| path.is_absolute()));
    }
}
