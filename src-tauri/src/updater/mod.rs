pub mod config;
pub mod fetcher;
pub mod github_release;
pub mod handler;
pub mod identity;
pub mod update_ack;
#[cfg(target_os = "windows")]
pub mod windows_replace;