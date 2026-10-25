mod arguments;
pub(crate) mod game_process_state;
mod identity;
mod java_runtime;
mod memory;
mod process;

use std::path::PathBuf;

use arguments::{build_jvm_arguments_inner, VersionJson};
use java_runtime::{get_java_major_version, required_java_major_from_jar};
use crate::downloader::mod_loader_installer_shared::pick_java_executable;
use crate::handler::config::is_auto_java_selection;
use crate::handler::game_dir::compute_game_directory;
use process::run_command;
use tauri::Emitter;

pub use arguments::build_jvm_arguments;
pub use game_process_state::get_running_game_state;
pub use process::kill_game_process;

/// 启动游戏（构建参数并执行 Java 进程）
#[tauri::command]
pub fn launch_game(
    app: tauri::AppHandle,
    minecraft_path: &str,
    java_path: &str,
    wrapper_path: &str,
    max_memory: &str,
    version_name: &str,
    minecraft_version: &str,
    player_name: &str,
    auth_token: &str,
    uuid: &str,
    authlib_injector_path: &str,
    yggdrasil_api: &str,
    prefetched_data: &str,
    loadType: &str,
    loadName: &str,
    window_width: &str,
    window_height: &str,
    custom_jvm_args: &str,
) -> Result<String, String> {
    crate::handler::system::schedule_launcher_profiles_check();

    let mut resolved_java_path = if is_auto_java_selection(java_path) {
        let picked = pick_java_executable(minecraft_version);
        if picked.is_empty() {
            return Err(
                "未配置可用的 Java：请先扫描或添加 Java，或下载对应版本的 Java 运行时".to_string(),
            );
        }
        println!(
            "[启动器] 自动选择 Java（游戏版本 {}）: {}",
            minecraft_version,
            picked
        );
        picked
    } else {
        java_path.to_string()
    };
    let version_json_path = PathBuf::from(minecraft_path)
        .join("versions")
        .join(version_name)
        .join(format!("{}.json", version_name));

    let metadata_major: Option<u32> = (|| {
        let file = std::fs::File::open(&version_json_path).ok()?;
        let vj: VersionJson = serde_json::from_reader(file).ok()?;
        vj.java_version.map(|jv| jv.major_version)
    })();

    let version_jar_path = PathBuf::from(minecraft_path)
        .join("versions")
        .join(version_name)
        .join(format!("{}.jar", version_name));
    let jar_major = required_java_major_from_jar(&version_jar_path);
    let target_major = match (metadata_major, jar_major) {
        (Some(metadata), Some(actual)) if actual > metadata => {
            println!(
                "[启动器] 版本 JSON 声明 Java {}，但游戏 JAR 字节码需要 Java {}，以 JAR 为准",
                metadata, actual
            );
            Some(actual)
        }
        (Some(metadata), _) => Some(metadata),
        (None, actual) => actual,
    };

    if let Some(major) = target_major {
        println!(
            "[启动器] 版本 {} 的 javaVersion.majorVersion = {}",
            version_name, major
        );

        let current_major =
            crate::handler::java_scanner::validate_java_path(resolved_java_path.clone())
                .ok()
                .map(|inst| inst.major_version);

        let needs_swap = match current_major {
            Some(m) => {
                println!(
                    "[启动器] 当前 Java 路径 {} 的大版本号 = {}",
                    resolved_java_path,
                    m
                );
                m != major as i32
            }
            None => {
                println!(
                    "[启动器] 当前 Java 路径 {} 无效或无法获取版本号",
                    resolved_java_path
                );
                true
            }
        };

        if needs_swap {
            println!(
                "[启动器] Java 版本不匹配（需要 {}），正在搜索匹配的 Java 安装...",
                major
            );
            if let Some(matched) = crate::handler::java_scanner::find_java_by_major_version(major) {
                println!(
                    "[启动器] 已自动切换到匹配的 Java: {} (版本 {})",
                    matched.path, matched.version
                );
                resolved_java_path = matched.path;
            } else {
                println!(
                    "[启动器] 未找到匹配的 Java {}，中止启动并通知前端",
                    major
                );
                let _ = app.emit(
                    "java-incompatible",
                    serde_json::json!({
                        "requiredMajor": major,
                        "versionName": version_name,
                        "currentJavaPath": resolved_java_path,
                    }),
                );
                return Err(format!(
                    "需要 Java {}，当前环境未找到匹配的安装",
                    major
                ));
            }
        }
    } else {
        println!(
            "[启动器] 版本 {} 的版本 json 中未找到 javaVersion 字段",
            version_name
        );
        let java_major = get_java_major_version(&resolved_java_path);
        println!(
            "[启动器] Java 路径 {} 的大版本号 = {}",
            resolved_java_path, java_major
        );
    }

    // 先构建参数
    let args = build_jvm_arguments_inner(
        app.clone(),
        minecraft_path,
        &resolved_java_path,
        wrapper_path,
        max_memory,
        version_name,
        minecraft_version,
        player_name,
        auth_token,
        uuid,
        authlib_injector_path,
        yggdrasil_api,
        prefetched_data,
        loadType,
        loadName,
        window_width,
        window_height,
        custom_jvm_args,
    )
    .map_err(|e| e.to_string())?;

    let game_directory = compute_game_directory(minecraft_path, loadType, loadName);

    // 再启动游戏
    run_command(
        args.clone(),
        PathBuf::from(&resolved_java_path),
        PathBuf::from(minecraft_path),
        app,
        minecraft_version.to_string(),
        game_directory.to_string_lossy().to_string(),
        version_name.to_string(),
    )
    .map_err(|e| e.to_string())?;

    Ok(args.join(" "))
}
