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
    )
    .map_err(|e| e.to_string())?;

    Ok(args.join(" "))
}

#[cfg(test)]
mod tests {
    use super::{
        arguments::{
            append_loader_jvm_args, dedup_path_list, launcher_rules_allow, merge_loader_game_args,
            merge_version_jvm_args,
        },
        identity::launch_auth_identity,
        java_runtime::is_plausible_minecraft_version,
        memory::{safe_max_memory_mb, SafeMemoryLimit},
        process::display_exit_code,
    };
    use serde_json::json;

    #[test]
    fn removes_duplicate_jars_from_a_loader_classpath() {
        // PCL CE 生成的 NeoForge 实例 json 会携带字面量 -cp，其中同一
        // jar 可能因原版库与加载器库重复拼接而出现两次。
        let mut args = Vec::new();
        let classpath = format!(
            "{p}{p}{p2}{p3}",
            p = "C:/Users/Hill233/AppData/Roaming/.minecraft/libraries/com/google/code/gson/gson/2.10.1/gson-2.10.1.jar;",
            p2 = "C:/Users/Hill233/AppData/Roaming/.minecraft/libraries/com/mojang/logging/1.2.7/logging-1.2.7.jar;",
            p3 = "C:/Users/Hill233/AppData/Roaming/.minecraft/libraries/com/google/code/gson/gson/2.10.1/gson-2.10.1.jar"
        );

        append_loader_jvm_args(&mut args, &["-cp".to_string(), classpath.clone()]);

        let idx = args.iter().position(|a| a == "-cp").unwrap();
        let value = &args[idx + 1];
        assert_eq!(value.matches("gson-2.10.1.jar").count(), 1);
        assert_eq!(value.matches("logging-1.2.7.jar").count(), 1);
    }

    #[test]
    fn dedup_path_list_keeps_order_and_case_insensitive_duplicates() {
        let deduped = dedup_path_list(
            "C:/a.jar;C:/b.jar;c:/A.JAR;C:/c.jar;C:/b.jar",
        );
        assert_eq!(deduped, "C:/a.jar;C:/b.jar;C:/c.jar");
    }

    #[test]
    fn dedup_path_list_handles_unix_style_separator() {
        let deduped = dedup_path_list("/l/a.jar:/l/b.jar:/l/a.jar");
        assert_eq!(deduped, "/l/a.jar:/l/b.jar");
    }

    #[test]
    fn keeps_loader_module_path_when_vanilla_supplies_classpath() {
        let mut args = vec!["-cp".to_string(), "C:/Minecraft/libraries/*".to_string()];
        let loader_args = vec![
            "-p".to_string(),
            "C:/Minecraft/libraries/bootstrap.jar;C:/Minecraft/libraries/asm-commons.jar"
                .to_string(),
            "--add-modules".to_string(),
            "ALL-MODULE-PATH".to_string(),
        ];

        append_loader_jvm_args(&mut args, &loader_args);

        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "-p" && pair[1].contains("asm-commons.jar")));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--add-modules" && pair[1] == "ALL-MODULE-PATH"));
    }

    #[test]
    fn preserves_a_module_path_containing_spaces_as_one_argument() {
        let mut args = Vec::new();
        let module_path = "C:/Users/Test User/.minecraft/libraries/bootstrap.jar".to_string();

        append_loader_jvm_args(&mut args, &["-p".to_string(), module_path.clone()]);

        assert_eq!(args, vec!["-p".to_string(), module_path]);
    }

    #[test]
    fn keeps_an_existing_effective_module_path() {
        let mut args = vec!["-p".to_string(), "effective-module-path".to_string()];

        append_loader_jvm_args(
            &mut args,
            &["-p".to_string(), "loader-module-path".to_string()],
        );

        assert_eq!(args, vec!["-p", "effective-module-path"]);
    }

    #[test]
    fn keeps_loader_add_opens_for_named_modules() {
        // --add-opens/--add-exports 可多次出现且目标模块不同，即使固定参数
        // 已带 --add-opens（ALL-UNNAMED 或 securejarhandler），loader 的
        // 具名模块开放也必须保留，否则 securejarhandler 类初始化崩溃。
        let mut args = vec![
            "--add-opens".to_string(),
            "java.base/java.lang.invoke=cpw.mods.securejarhandler".to_string(),
            "-p".to_string(),
            "module-path".to_string(),
        ];
        let loader_args = vec![
            "--add-modules".to_string(),
            "ALL-MODULE-PATH".to_string(),
            "--add-opens".to_string(),
            "java.base/java.util.jar=cpw.mods.securejarhandler".to_string(),
            "--add-exports".to_string(),
            "java.base/sun.security.util=cpw.mods.securejarhandler".to_string(),
        ];

        append_loader_jvm_args(&mut args, &loader_args);

        assert_eq!(
            args,
            vec![
                "--add-opens",
                "java.base/java.lang.invoke=cpw.mods.securejarhandler",
                "-p",
                "module-path",
                "--add-modules",
                "ALL-MODULE-PATH",
                "--add-opens",
                "java.base/java.util.jar=cpw.mods.securejarhandler",
                "--add-exports",
                "java.base/sun.security.util=cpw.mods.securejarhandler",
            ]
        );
    }

    #[test]
    fn skips_loader_args_whose_key_is_already_effective() {
        // 与 keeps_an_existing_effective_module_path 不同，这里连 -Xss1M、
        // -Djava.library.path 这类普通键也要去重，否则同一参数被拼接多次
        // （固定参数、version json jvm 参数、loader 参数三处都会出现）。
        let mut args = vec![
            "-Xss1M".to_string(),
            "-Djava.library.path=/minecraft/natives".to_string(),
            "-p".to_string(),
            "effective-module-path".to_string(),
        ];
        let loader_args = vec![
            "-Xss1M".to_string(),
            "-Djava.library.path=/other/natives".to_string(),
            "-Dminecraft.launcher.brand=OpenXLauncher".to_string(),
            "-p".to_string(),
            "loader-module-path".to_string(),
        ];

        append_loader_jvm_args(&mut args, &loader_args);

        // -Xss1M 与 -Djava.library.path（-D 前缀键去重）都被跳过，
        // 保留已生效的值；只有新键 -Dminecraft.launcher.brand 被补入。
        assert_eq!(
            args,
            vec![
                "-Xss1M",
                "-Djava.library.path=/minecraft/natives",
                "-p",
                "effective-module-path",
                "-Dminecraft.launcher.brand=OpenXLauncher",
            ]
        );
    }

    #[test]
    fn merge_version_jvm_args_skips_placeholder_garbage_by_key() {
        // version json 的 jvm 参数里 -Djava.library.path 的占位符替换结果
        // 是 -Djava.library.path={}（垃圾值），而 loader 参数里是完整路径。
        // 必须按键（= 之前的部分）去重，把垃圾值跳过去；
        // 即使 loader 里没有同名键（如 -Djna.tmpdir），垃圾值也直接丢弃。
        let mut args = Vec::new();
        let jvm_args_from_version = vec![
            "-Djava.library.path={}".to_string(),
            "-Djna.tmpdir={}".to_string(),
            "-Dminecraft.launcher.brand=OpenXLauncher".to_string(),
            "-cp".to_string(),
            "version-classpath".to_string(),
        ];
        let extra_before_cp = vec![
            "-Djava.library.path=C:/minecraft/versions/inst/inst-natives".to_string(),
        ];

        merge_version_jvm_args(&mut args, &jvm_args_from_version, &extra_before_cp);

        // -Djava.library.path={} 因键已存在被跳过，-Djna.tmpdir={} 因垃圾值被
        // 丢弃；loader 没有的合法键 -Dminecraft.launcher.brand 被加入；
        // -cp 作为关键参数始终补入
        assert_eq!(
            args,
            vec![
                "-Dminecraft.launcher.brand=OpenXLauncher".to_string(),
                "-cp".to_string(),
                "version-classpath".to_string(),
            ]
        );
    }

    #[test]
    fn merge_version_jvm_args_keeps_absent_keys() {
        // loader 里没有的键（如 -Xmn768m）仍然会被加入
        let mut args = Vec::new();
        let jvm_args_from_version = vec!["-Xmn768m".to_string()];
        let extra_before_cp = vec!["-Dminecraft.launcher.brand=OpenXLauncher".to_string()];

        merge_version_jvm_args(&mut args, &jvm_args_from_version, &extra_before_cp);

        assert_eq!(args, vec!["-Xmn768m".to_string()]);
    }

    #[test]
    fn merge_loader_game_args_does_not_append_values_of_existing_keys() {
        // PCL CE 生成的 NeoForge 实例 json 的 game 参数携带
        // --fml.neoForgeVersion 21.1.238 等字面量；这些 --key 已存在于
        // 原版/实例 json 参数中，此时只能整对跳过，否则 21.1.238 等裸值
        // 会被重复拼到命令尾部（报告中命令末尾出现的大量重复拼接）。
        let mut game_args = vec![
            "--launchTarget".to_string(),
            "forgeclient".to_string(),
            "--width".to_string(),
            "873".to_string(),
            "--height".to_string(),
            "486".to_string(),
            "--fml.forgeVersion".to_string(),
            "21.1.238".to_string(),
            "--fml.fmlVersion".to_string(),
            "4.0.43".to_string(),
            "--fml.mcVersion".to_string(),
            "1.21.1".to_string(),
            "--fml.neoFormVersion".to_string(),
            "20240808.144430".to_string(),
        ];
        let extra_after_cp = vec![
            "--fml.forgeVersion".to_string(),
            "21.1.238".to_string(),
            "--fml.fmlVersion".to_string(),
            "4.0.43".to_string(),
            "--fml.mcVersion".to_string(),
            "1.21.1".to_string(),
            "--fml.neoFormVersion".to_string(),
            "20240808.144430".to_string(),
            "--launchTarget".to_string(),
            "forgeclient".to_string(),
            "--fml.legacyCPVersion".to_string(),
            "21.1.238".to_string(),
        ];

        merge_loader_game_args(&mut game_args, &extra_after_cp);

        // 已有键整对跳过（不再产生 21.1.238 4.0.43 ... forgeclient 尾部垃圾）；
        // 只有全新的 --fml.legacyCPVersion 连值一起补入
        assert_eq!(
            game_args,
            vec![
                "--launchTarget",
                "forgeclient",
                "--width",
                "873",
                "--height",
                "486",
                "--fml.forgeVersion",
                "21.1.238",
                "--fml.fmlVersion",
                "4.0.43",
                "--fml.mcVersion",
                "1.21.1",
                "--fml.neoFormVersion",
                "20240808.144430",
                "--fml.legacyCPVersion",
                "21.1.238",
            ]
        );
    }

    #[test]
    fn merge_loader_game_args_keeps_new_key_and_bare_value() {
        // 全新的 --key 及其值、以及不属于任何已存在 --key 的裸值仍被保留
        let mut game_args = vec!["--width".to_string(), "873".to_string()];
        let extra_after_cp = vec![
            "--new-key".to_string(),
            "new-value".to_string(),
            "bare-value".to_string(),
        ];

        merge_loader_game_args(&mut game_args, &extra_after_cp);

        assert_eq!(
            game_args,
            vec![
                "--width",
                "873",
                "--new-key",
                "new-value",
                "bare-value",
            ]
        );
    }

    #[test]
    fn skips_demo_argument_rule_for_a_normal_launch() {
        let rules = json!([
            {
                "action": "allow",
                "features": { "is_demo_user": true }
            }
        ]);

        assert!(!launcher_rules_allow(Some(&rules)));
    }

    #[test]
    fn accepts_an_unconditional_allow_rule() {
        let rules = json!([{ "action": "allow" }]);

        assert!(launcher_rules_allow(Some(&rules)));
    }

    #[test]
    fn validates_base_minecraft_version_formats() {
        for version in ["1.20.1", "1.21-rc1", "25w42a", "26", "26.3-snapshot-5"] {
            assert!(is_plausible_minecraft_version(version), "{version}");
        }
        for instance_name in ["PVZ_Survive", "SHser-Basic-Package", "fabric-loader-0.15.0"] {
            assert!(
                !is_plausible_minecraft_version(instance_name),
                "{instance_name}"
            );
        }
    }

    #[test]
    fn chooses_auth_identity_that_matches_the_account_type() {
        assert_eq!(
            launch_auth_identity("third-party-token", "https://example.invalid/api/yggdrasil"),
            ("mojang", "{}")
        );
        assert_eq!(launch_auth_identity("0", ""), ("legacy", "{}"));
        assert_eq!(launch_auth_identity("microsoft-token", ""), ("msa", "{}"));
    }

    #[test]
    fn limits_heap_to_memory_available_after_system_reserve() {
        // 4GB 设备、约 2.3GB 当前可用时，不能预分配 4GB 堆。
        assert_eq!(
            safe_max_memory_mb(4096, 3819, 2335),
            SafeMemoryLimit::Limited(1823)
        );
        assert_eq!(
            safe_max_memory_mb(1024, 3819, 2335),
            SafeMemoryLimit::Limited(1024)
        );
    }

    #[test]
    fn distinguishes_unknown_and_insufficient_memory() {
        assert_eq!(safe_max_memory_mb(4096, 0, 2048), SafeMemoryLimit::Unknown);
        assert_eq!(
            safe_max_memory_mb(4096, 3819, 800),
            SafeMemoryLimit::Insufficient {
                min_available_mb: 1024
            }
        );
    }

    #[test]
    #[cfg(unix)]
    fn preserves_unix_termination_signal_in_exit_code() {
        use std::os::unix::process::ExitStatusExt;

        assert_eq!(display_exit_code(std::process::ExitStatus::from_raw(0)), 0);
        assert_eq!(display_exit_code(std::process::ExitStatus::from_raw(6)), -6);
    }
}
