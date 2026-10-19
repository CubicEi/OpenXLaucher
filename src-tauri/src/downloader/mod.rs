pub mod decompression;
pub mod original_dwl;
pub mod version_fetcher;
// 仓库历史上同时存在 dwPatch.rs 与 dwpatch.rs；显式绑定小写文件，
// 避免大小写敏感的 Linux/macOS 与 Windows 解析到不同实现。
pub mod concurrent_download;
#[path = "dwpatch.rs"]
#[allow(non_snake_case)]
pub mod dwPatch;
// Optional installer paths and manifest fields are kept for compatibility with
// the loader formats we support, even when the current UI does not call them.
pub mod fabric_installer;
pub mod forge_installer;
#[allow(dead_code)]
pub mod liteloader_installer;
#[allow(dead_code, non_snake_case)]
pub mod mod_loader_installer;
pub mod mod_loader_installer_shared;
#[allow(non_snake_case)]
pub mod modpack_installer;
#[allow(dead_code)]
pub mod modular_download;
#[allow(dead_code, non_snake_case)]
pub mod neoforge_installer;
#[allow(dead_code)]
pub mod optifine_installer;
pub mod quilt_installer;
#[allow(dead_code)]
pub mod shared_utils;
