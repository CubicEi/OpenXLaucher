//! Unified dual-task version install session (download + install).

pub mod commands;
pub mod events;
pub mod java_check;
pub mod orchestrator;
pub mod plan;
pub mod progress_network;
pub mod rollback;
pub mod session;
pub mod stages;

pub use commands::{
    cancel_by_task_id, cancel_version_install_session, check_java_for_mc_version,
    list_active_download_tasks, start_combined_legacy, start_loader_legacy, start_modpack_legacy,
    start_vanilla_legacy, start_version_install_session,
};
pub use events::LegacyEventFamily;
pub use plan::{InstallPlan, LoaderSelection};
