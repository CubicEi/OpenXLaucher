//! Roll back partial modpack install artifacts on session failure or cancel.

use std::fs;
use std::path::Path;

use crate::downloader::modpack_installer::{self, ModpackLoaderType};
use crate::downloader::shared_utils::{
    cleanup_after_modpack_merge, cleanup_vanilla_version_dir, sanitize_instance_name,
};

use super::rollback::RollbackLedger;

pub fn rollback_modpack_after_failure(
    minecraft_path: &Path,
    staging_root: &Path,
    zip_path: &Path,
    ledger: &RollbackLedger,
) {
    println!("[Modpack] 安装失败或已取消，正在清理不完整文件…");

    let parsed = modpack_installer::parse_modpack_from_zip(zip_path).ok();
    let instance_name = read_staging_trim(staging_root, "modpack_instance_name.txt").or_else(|| {
        parsed.as_ref().map(|p| {
            sanitize_instance_name(&format!("{}-{}", p.name, p.mc_version))
        })
    });
    let mc_version = parsed.as_ref().map(|p| p.mc_version.as_str());
    let has_mod_loader = parsed
        .as_ref()
        .is_some_and(|p| !matches!(p.loader_type, ModpackLoaderType::Vanilla));
    let loader_version_name = read_staging_trim(staging_root, "modpack_loader_version.txt");
    let downloaded_vanilla = staging_root.join("vanilla_downloaded.flag").exists();
    let vanilla_pre_existed = staging_root.join("vanilla_pre_existed.flag").exists();

    if let Some(ref inst) = instance_name {
        let inst_dir = minecraft_path.join("versions").join(inst);
        if inst_dir.exists() && !ledger.is_pre_existing(&inst_dir) {
            match fs::remove_dir_all(&inst_dir) {
                Ok(()) => println!(
                    "[Modpack] rollback removed instance dir {}",
                    inst_dir.display()
                ),
                Err(e) => println!(
                    "[Modpack] rollback failed to remove instance dir {}: {}",
                    inst_dir.display(),
                    e
                ),
            }
        }
    }

    if let (Some(mc), Some(inst)) = (mc_version, instance_name.as_deref()) {
        let loader_ver = loader_version_name.as_deref().unwrap_or(inst);
        let loader_installed = has_mod_loader && loader_version_name.is_some();
        cleanup_after_modpack_merge(
            minecraft_path,
            mc,
            inst,
            loader_ver,
            loader_installed,
            downloaded_vanilla,
            vanilla_pre_existed,
        );
    } else if let Some(mc) = mc_version {
        if downloaded_vanilla && !vanilla_pre_existed {
            cleanup_vanilla_version_dir(mc, minecraft_path);
        }
    }
}

fn read_staging_trim(staging_root: &Path, name: &str) -> Option<String> {
    fs::read_to_string(staging_root.join(name))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}
