use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::error::Error;
use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use zip::ZipArchive;
#[derive(Debug, Deserialize)]
struct VersionManifest {
    libraries: Vec<Library>,
}
#[derive(Debug, Deserialize)]
struct Library {
    downloads: Downloads,
    #[serde(flatten)]
    _extra: Value,
}
#[derive(Debug, Deserialize)]
struct Downloads {
    #[serde(default)]
    artifact: Option<Artifact>,
    #[serde(default)]
    classifiers: Option<HashMap<String, Artifact>>,
}
#[derive(Debug, Deserialize, Clone)]
struct Artifact {
    path: String,
}
fn get_system_tag() -> Vec<&'static str> {
    match std::env::consts::OS {
        "windows" => vec!["-windows"],
        "linux" => vec!["-linux"],
        "macos" => vec!["-macos", "-osx"],
        _ => vec![],
    }
}
fn match_system(path: &str) -> bool {
    let system_tags = get_system_tag();
    if system_tags.is_empty() {
        return false;
    }
    let parts: Vec<&str> = path.split("-natives").collect();
    if parts.len() < 2 {
        return false;
    }
    let post_native = parts[1];
    system_tags.iter().any(|&tag| post_native.starts_with(tag))
}
fn extract_arch_info(path: &str) -> (Option<String>, bool) {
    const OS_NAMES: [&str; 4] = ["windows", "linux", "macos", "osx"];
    let segments: Vec<&str> = path.split('-').collect();
    let (arch_part, has_arch) = segments
        .iter()
        .rev()
        .find(|s| !s.is_empty())
        .and_then(|s| s.split('.').next())
        .map(|s| {
            let is_os = OS_NAMES.contains(&s);
            (s, !is_os)
        })
        .unwrap_or(("", false));
    (
        if has_arch {
            Some(arch_part.to_lowercase())
        } else {
            None
        },
        !has_arch,
    )
}
#[tauri::command]
pub async fn extract_library_paths(
    minecraft_path: String,
    version: String,
) -> Result<Vec<String>, String> {
    extract_library_paths_inner(&minecraft_path, &version).map_err(|e| e.to_string())
}
fn extract_library_paths_inner(
    minecraft_path: &str,
    version: &str,
) -> Result<Vec<String>, Box<dyn Error>> {
    let json_path = Path::new(minecraft_path)
        .join("versions")
        .join(version)
        .join(format!("{}.json", version));
    let json_data = fs::read_to_string(json_path)?;
    let manifest: VersionManifest = serde_json::from_str(&json_data)?;
    let current_arch = std::env::consts::ARCH;
    let system_name = std::env::consts::OS;
    let is_windows = system_name == "windows";
    let mut paths = Vec::new();
    let base_path = PathBuf::from(minecraft_path).join("libraries");
    let target_dir = PathBuf::from(minecraft_path)
        .join("versions")
        .join(version)
        .join(format!("{}-natives", version));
    fs::create_dir_all(&target_dir)?;
    for lib in manifest.libraries {
        if let Some(artifact) = lib.downloads.artifact {
            let path = &artifact.path;
            if path.contains("-natives") && match_system(path) {
                let (arch_opt, is_implicit) = extract_arch_info(path);
                let should_keep = match (arch_opt.as_deref(), is_implicit) {
                    (_, true) if current_arch == "x86_64" => true,
                    (Some(arch), false) => match current_arch {
                        "x86_64" => arch == "x86_64",
                        "x86" => arch == "x86",
                        "aarch64" => arch == "arm64" || arch == "aarch_64",
                        _ => false,
                    },
                    _ => false,
                };
                if should_keep {
                    let full_path = base_path.join(path).to_string_lossy().into_owned();
                    println!(
                        "[Native][{}][Arch: {}] {}",
                        system_name,
                        arch_opt.unwrap_or_else(|| "x86_64".into()), 
                        full_path
                    );
                    process_jar_file(&full_path, &target_dir)?;
                    paths.push(full_path);
                }
            }
        }
        if let Some(classifiers) = lib.downloads.classifiers {
            for classifier in classifiers.values() {
                let path = &classifier.path;
                if path.contains("-natives") {
                    let is_win64_case = is_windows && path.contains("natives-windows-64");
                    if match_system(path) || is_win64_case {
                        let (arch_opt, is_implicit) = extract_arch_info(path);
                        let should_keep = is_win64_case
                            || match (arch_opt.as_deref(), is_implicit) {
                                (_, true) if current_arch == "x86_64" => true,
                                (Some(arch), false) => match current_arch {
                                    "x86_64" => arch == "x86_64",
                                    "x86" => arch == "x86",
                                    "aarch64" => arch == "arm64" || arch == "aarch_64",
                                    _ => false,
                                },
                                _ => false,
                            };
                        if should_keep {
                            let full_path = base_path.join(path).to_string_lossy().into_owned();
                            println!(
                                "[Native][{}][Arch: {}] {}",
                                system_name,
                                if is_win64_case {
                                    "x86_64".to_string()
                                } else {
                                    arch_opt.unwrap_or_else(|| "x86_64".to_string())
                                },
                                full_path
                            );
                            process_jar_file(&full_path, &target_dir)?;
                            paths.push(full_path);
                        }
                    }
                }
            }
        }
    }
    Ok(paths)
}
fn process_jar_file(jar_path: &str, target_dir: &Path) -> Result<(), Box<dyn Error>> {
    if !Path::new(jar_path).exists() {
        return Err(format!("JAR 文件不存在: {}\n请重新下载该版本", jar_path).into());
    }
    let file = File::open(jar_path).map_err(|e| {
        format!(
            "无法打开 JAR 文件: {}\n错误: {}\n请重新下载该版本",
            jar_path, e
        )
    })?;
    let mut zip = ZipArchive::new(file).map_err(|e| {
        format!(
            "损坏的 JAR 文件: {}\n错误: {}\n请重新下载该版本",
            jar_path, e
        )
    })?;
    let target_ext = match std::env::consts::OS {
        "windows" => "dll",
        "macos" => "dylib",
        "linux" => "so",
        _ => return Ok(()),
    };
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| {
            format!(
                "损坏的 ZIP 条目: {}\n错误: {}\n请重新下载该版本",
                jar_path, e
            )
        })?;
        let entry_path = PathBuf::from(entry.name());
        if entry_path.extension() == Some(OsStr::new(target_ext))
            || entry_path.file_name() == Some(OsStr::new("Tracy_LICENSE"))
        {
            let dest_path = target_dir.join(entry_path.file_name().unwrap());
            let mut buffer = Vec::with_capacity(entry.size() as usize);
            entry.read_to_end(&mut buffer).map_err(|e| {
                format!(
                    "读取文件失败: {}\n错误: {}\n请重新下载该版本",
                    entry.name(),
                    e
                )
            })?;
            fs::write(&dest_path, &buffer).map_err(|e| {
                format!(
                    "写入文件失败: {}\n错误: {}\n请检查文件权限",
                    dest_path.display(),
                    e
                )
            })?;
        }
    }
    Ok(())
}