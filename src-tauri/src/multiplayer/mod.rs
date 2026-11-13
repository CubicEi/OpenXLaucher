mod codec;
mod download;
mod logs;
mod paths;
mod privileges;
mod process;

pub use download::{
    mp_ensure_installed, mp_finalize_install, mp_get_download_progress,
    mp_list_download_sources, mp_prepare_install_download,
};
pub use privileges::mp_prepare_privileges;
pub use process::{
    ensure_easytier_stopped_on_exit, mp_encode_room_info, mp_force_kill_process, mp_get_paths,
    mp_get_tool_status, mp_is_running, mp_poll_log, mp_set_peer, mp_start_host, mp_start_join,
    mp_stop_session, mp_uninstall_tool,
};

pub(crate) const EASYTIER_BIN: &str = if cfg!(target_os = "windows") {
    "easytier-core.exe"
} else {
    "easytier-core"
};
