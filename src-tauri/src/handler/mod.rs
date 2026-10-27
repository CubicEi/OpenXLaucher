pub mod cache_paths;
pub mod custom_download;
pub mod runtime_dependencies;
pub mod runtime_log;
pub mod config;
pub mod game_dir;
pub mod instance_export;
pub mod mod_file_registry;
pub mod diagnostics;
// Tauri command argument names intentionally match the existing frontend API.
#[allow(dead_code, non_snake_case)]
pub mod fabric_handler;
#[allow(dead_code, non_snake_case)]
pub mod forge_handler;
#[allow(dead_code)]
pub mod java_downloader;
pub mod java_scanner;
#[allow(dead_code, non_snake_case)]
pub mod launcher;
#[allow(dead_code, non_snake_case)]
pub mod liteloader_handler;
#[allow(dead_code, non_snake_case)]
pub mod mod_links;
pub mod mod_parser;
pub mod mod_platform;
pub mod mod_platform_probe;
pub mod mod_update_locks;
pub mod mod_updates;
pub mod resource_kind_resolve;
#[allow(dead_code)]
pub mod modpack_builder;
#[allow(non_snake_case)]
pub mod modpack_installer_handler;
#[allow(dead_code, non_snake_case)]
pub mod neoforge_handler;
pub mod combined_install_handler;
#[allow(dead_code, non_snake_case)]
pub mod optifine_handler;
#[allow(dead_code, non_snake_case)]
pub mod quilt_handler;
#[allow(dead_code, non_snake_case)]
pub mod system;