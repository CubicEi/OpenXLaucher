pub mod config;
pub mod fetcher;
pub mod github_release;
pub mod handler;
pub mod identity;
#[cfg(any(target_os = "macos", test))]
pub mod macos_replace;
pub mod update_ack;
#[cfg(target_os = "windows")]
pub mod windows_replace;