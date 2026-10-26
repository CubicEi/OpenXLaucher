//! Stage keys and Chinese draft labels (see version-install-api.md §4).

pub const STAGE_PREP: &str = "prep";
pub const STAGE_VANILLA: &str = "vanilla";
pub const STAGE_LOADER_INSTALLER: &str = "loader_installer";
pub const STAGE_COMMUNITY: &str = "community";
pub const STAGE_WAITING: &str = "waiting";
pub const STAGE_LOADER: &str = "loader";
pub const STAGE_OPTIFINE: &str = "optifine";
pub const STAGE_MERGE: &str = "merge";
pub const STAGE_RESOURCES: &str = "resources";
pub const STAGE_TRANSFER: &str = "transfer_data";
pub const STAGE_CLEANUP: &str = "cleanup";
pub const STAGE_DONE: &str = "done";
pub const STAGE_CANCELLED: &str = "cancelled";

pub fn stage_label(stage: &str) -> String {
    match stage {
        STAGE_PREP => "准备安装".to_string(),
        STAGE_VANILLA => "下载原版文件".to_string(),
        STAGE_LOADER_INSTALLER => "下载 Mod 加载器安装文件".to_string(),
        STAGE_COMMUNITY => "下载社区资源".to_string(),
        STAGE_WAITING => "等待下载完成".to_string(),
        STAGE_LOADER => "安装 Mod 加载器".to_string(),
        STAGE_OPTIFINE => "安装 OptiFine".to_string(),
        STAGE_MERGE => "合并游戏版本文件夹".to_string(),
        STAGE_RESOURCES => "安装社区资源".to_string(),
        STAGE_TRANSFER => "转移数据".to_string(),
        STAGE_CLEANUP => "清理与登记".to_string(),
        STAGE_DONE => "安装完成".to_string(),
        STAGE_CANCELLED => "已取消".to_string(),
        other => other.to_string(),
    }
}
