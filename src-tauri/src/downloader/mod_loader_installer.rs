use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use zip::ZipArchive;

async fn ensure_options_lang(
    version_dir: &Path,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let options_path = version_dir.join("options.txt");
    if options_path.exists() {
        let content = fs::read_to_string(&options_path)?;
        if content.contains("lang:") {
            let new_content = content
                .lines()
                .map(|line| {
                    if line.trim().starts_with("lang:") {
                        "lang:zh_cn"
                    } else {
                        line
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");
            fs::write(&options_path, new_content)?;
        } else {
            fs::write(&options_path, format!("{}\nlang:zh_cn", content))?;
        }
    } else {
        fs::write(&options_path, "lang:zh_cn")?;
    }
    Ok(())
}
#[derive(Debug, Deserialize, Clone)]
pub struct ProfileLibrary {
    pub name: String,
    #[serde(default)]
    pub downloads: Option<ProfileDownloads>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub checksums: Option<Vec<String>>,
    #[serde(default)]
    pub clientreq: Option<bool>,
    #[serde(default)]
    pub serverreq: Option<bool>,
}
#[derive(Debug, Deserialize, Clone, Default)]
pub struct ProfileDownloads {
    #[serde(default)]
    pub artifact: Option<ProfileArtifact>,
}
#[derive(Debug, Deserialize, Clone)]
pub struct ProfileArtifact {
    pub path: String,
    pub url: String,
    #[serde(default)]
    pub sha1: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
}
#[derive(Debug, Deserialize, Clone)]
pub struct Processor {
    #[serde(default)]
    pub jar: Option<String>,
    #[serde(default)]
    pub classpath: Vec<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub sides: Option<Vec<String>>,
    #[serde(default)]
    pub outputs: Option<HashMap<String, Value>>,
}
#[derive(Debug, Deserialize, Clone)]
pub struct DataEntry {
    #[serde(default)]
    pub client: Option<String>,
    #[serde(default)]
    pub server: Option<String>,
    #[serde(rename = "type")]
    #[serde(default)]
    pub type_: Option<String>,
}
#[derive(Debug, Deserialize, Clone)]
pub struct InstallProfile {
    #[serde(default)]
    pub spec: Option<i32>,
    #[serde(default)]
    pub profile: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub minecraft: Option<String>,
    #[serde(default)]
    pub libraries: Vec<ProfileLibrary>,
    #[serde(default)]
    pub processors: Vec<Processor>,
    #[serde(default)]
    pub data: HashMap<String, DataEntry>,
    #[serde(default)]
    pub install: Option<Value>,
    #[serde(default)]
    pub versionInfo: Option<Value>,
}
pub fn maven_to_path(name: &str) -> String {
    if !name.contains(':') && !name.contains('@') {
        return name.to_string();
    }
    let (core, ext) = if let Some(idx) = name.rfind('@') {
        (&name[..idx], &name[idx + 1..])
    } else {
        (name, "jar")
    };
    let parts: Vec<&str> = core.split(':').collect();
    if parts.len() < 3 {
        return name.to_string();
    }
    let group = parts[0].replace('.', "/");
    let artifact = parts[1];
    let version = parts[2];
    let classifier = if parts.len() >= 4 && !parts[3].is_empty() {
        format!("-{}", parts[3])
    } else {
        String::new()
    };
    format!(
        "{}/{}/{}/{}-{}{}.{}",
        group, artifact, version, artifact, version, classifier, ext
    )
}
fn normalize_path(p: &str) -> String {
    if cfg!(windows) {
        p.replace('/', "\\").replace("\\\\", "\\")
    } else {
        p.replace('\\', "/").replace("//", "/")
    }
}
fn default_maven_url(name: &str, base: &str) -> String {
    let path = maven_to_path(name);
    format!("{}/{}", base.trim_end_matches('/'), path)
}
pub struct InstallerContents {
    pub profile: InstallProfile,
    pub version_json: Value,
    pub installer_jar_path: PathBuf,
}
impl InstallerContents {
    pub fn parse(installer_jar_path: &Path) -> Result<Self> {
        let file = File::open(installer_jar_path).with_context(|| {
            format!("Failed to open installer {}", installer_jar_path.display())
        })?;
        let mut zip = ZipArchive::new(file).context("Failed to parse installer zip structure ")?;
        let mut profile_text = String::new();
        let mut version_text = String::new();
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).context("Failed to read zip entry ")?;
            let name = entry.name().to_string();
            if name.ends_with("install_profile.json ") && profile_text.is_empty() {
                entry.read_to_string(&mut profile_text)?;
            } else if name.ends_with("version.json ") && version_text.is_empty() {
                entry.read_to_string(&mut version_text)?;
            }
        }
        if profile_text.is_empty() {
            return Err(anyhow!(
                "install_profile.json not found in installer, this may not be a valid Forge/NeoForge installer "
            ));
        }
        if version_text.is_empty() {
            return Err(anyhow!(
                "version.json not found in installer, this may not be a valid Forge/NeoForge installer "
            ));
        }
        let profile: InstallProfile =
            serde_json::from_str(&profile_text).context("Failed to parse install_profile.json ")?;
        let version_json: Value =
            serde_json::from_str(&version_text).context("Failed to parse version.json ")?;
        Ok(InstallerContents {
            profile,
            version_json,
            installer_jar_path: installer_jar_path.to_path_buf(),
        })
    }
}
async fn http_client_async() -> Result<reqwest::Client> {
    Ok(crate::http_client::shared_client().await.as_ref().clone())
}
async fn download_if_missing_async(url: &str, target: &Path) -> Result<()> {
    if target.exists() && fs::metadata(target).map(|m| m.len() > 0).unwrap_or(false) {
        return Ok(());
    }
    let url_str = url.to_string();
    let target_buf = target.to_path_buf();
    crate::downloader::concurrent_download::download_one(
        crate::downloader::concurrent_download::DownloadTask {
            file_name: target_buf
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
            target_dir: target_buf
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| PathBuf::from(".")),
            urls: vec![url_str],
            sha1: None,
        },
    )
    .await
    .map(|_| ())
    .with_context(|| format!("下载 {} 失败", url))
}
#[allow(dead_code)]
fn download_if_missing(url: &str, target: &Path) -> Result<()> {
    use reqwest::blocking::Client as BClient;
    if target.exists() && fs::metadata(target).map(|m| m.len() > 0).unwrap_or(false) {
        return Ok(());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).ok();
    }
    let client = BClient::builder()
        .user_agent("RTLauncher/1.0")
        .build()
        .context("Failed to build reqwest blocking client ")?;
    let mut resp = client
        .get(url)
        .send()
        .with_context(|| format!("请求下载 {} 失败", url))?;
    if !resp.status().is_success() {
        return Err(anyhow!("下载 {} 失败，HTTP 状态码: {}", url, resp.status()));
    }
    let mut bytes = Vec::new();
    resp.read_to_end(&mut bytes)
        .with_context(|| format!("读取 {} 响应体失败", url))?;
    let mut file =
        File::create(target).with_context(|| format!("创建文件 {} 失败", target.display()))?;
    file.write_all(&bytes)?;
    drop(file);
    Ok(())
}
pub struct LibraryDownloadPlan<'a> {
    pub name: String,
    pub path: PathBuf,
    pub url: String,
    pub _lib: &'a ProfileLibrary,
}
pub fn collect_library_plan<'a>(
    profile: &'a InstallProfile,
    libraries_dir: &Path,
    default_mirrors: &[&str],
) -> Vec<LibraryDownloadPlan<'a>> {
    let mut plans = Vec::new();
    for lib in &profile.libraries {
        if let Some(false) = lib.clientreq {
            continue;
        }
        if lib.name.contains(":natives-") || lib.name.contains(":natives-") {}
        let (path, url) = if let Some(dl) = &lib.downloads {
            if let Some(artifact) = &dl.artifact {
                let path = libraries_dir.join(&artifact.path);
                let url = artifact.url.clone();
                (path, url)
            } else {
                let rel = maven_to_path(&lib.name);
                let base = lib
                    .url
                    .as_deref()
                    .unwrap_or(default_mirrors[0].trim_end_matches('/'));
                (libraries_dir.join(&rel), format!("{}/{}", base, rel))
            }
        } else {
            let rel = maven_to_path(&lib.name);
            let base = lib
                .url
                .as_deref()
                .unwrap_or(default_mirrors[0].trim_end_matches('/'));
            (libraries_dir.join(&rel), format!("{}/{}", base, rel))
        };
        plans.push(LibraryDownloadPlan {
            name: lib.name.clone(),
            path,
            url,
            _lib: lib,
        });
    }
    plans
}
pub async fn download_libraries_async(
    profile: &InstallProfile,
    libraries_dir: &Path,
    default_mirrors: &[&str],
) -> Result<usize> {
    let plans = collect_library_plan(profile, libraries_dir, default_mirrors);
    let mut tasks: Vec<crate::downloader::concurrent_download::DownloadTask> =
        Vec::with_capacity(plans.len());
    let mut already_existing = 0usize;
    for plan in &plans {
        if plan.path.exists()
            && fs::metadata(&plan.path)
                .map(|m| m.len() > 0)
                .unwrap_or(false)
        {
            already_existing += 1;
            continue;
        }
        let mut urls: Vec<String> = Vec::with_capacity(1 + default_mirrors.len());
        urls.push(plan.url.clone());
        for mirror in default_mirrors {
            let rel = maven_to_path(&plan.name);
            urls.push(format!("{}/{}", mirror.trim_end_matches('/'), rel));
        }
        let target_dir = plan
            .path
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| libraries_dir.to_path_buf());
        let file_name = plan
            .path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        tasks.push(crate::downloader::concurrent_download::DownloadTask {
            file_name,
            target_dir,
            urls,
            sha1: None,
        });
    }
    if tasks.is_empty() {
        return Ok(already_existing);
    }
    println!(
        "  并行下载 {} 个库文件（已有 {} 个跳过）",
        tasks.len(),
        already_existing
    );
    let result = crate::downloader::concurrent_download::download_all(tasks, None).await;
    for failure in &result.failures {
        println!(
            "  警告：库 {} 下载失败：{}",
            failure.file_name, failure.error
        );
    }
    Ok(already_existing + result.success_count)
}
#[allow(dead_code)]
pub fn download_libraries(
    profile: &InstallProfile,
    libraries_dir: &Path,
    default_mirrors: &[&str],
) -> Result<usize> {
    let plans = collect_library_plan(profile, libraries_dir, default_mirrors);
    let mut downloaded = 0usize;
    for plan in &plans {
        let mut last_err = None;
        let mut tried_main = false;
        for mirror in default_mirrors {
            let url = if !tried_main {
                tried_main = true;
                plan.url.clone()
            } else {
                let rel = maven_to_path(&plan.name);
                format!("{}/{}", mirror.trim_end_matches('/'), rel)
            };
            match download_if_missing(&url, &plan.path) {
                Ok(_) => {
                    downloaded += 1;
                    last_err = None;
                    break;
                }
                Err(e) => {
                    last_err = Some(e);
                }
            }
        }
        if let Some(e) = last_err {
            println!("  警告：库 {} 下载失败：{}", plan.name, e);
        }
    }
    Ok(downloaded)
}
fn resolve_data_value(
    raw: &str,
    libraries_dir: &Path,
    installer_path: &Path,
    mc_dir: &Path,
) -> Result<String> {
    if raw.starts_with('[') && raw.ends_with(']') {
        return Ok(raw[1..raw.len() - 1].to_string());
    }
    if raw.starts_with('/') {
        let internal = raw.trim_start_matches('/');
        let file = File::open(installer_path)
            .with_context(|| format!("无法重新打开 {} 抽取资源", installer_path.display()))?;
        let mut zip = ZipArchive::new(file)
            .with_context(|| format!("解析 {} 抽取资源失败", installer_path.display()))?;
        let mut found_idx: Option<usize> = None;
        for i in 0..zip.len() {
            let entry = zip.by_index(i).ok();
            if let Some(e) = entry {
                let name = e.name().to_string();
                if name == internal || name.ends_with(internal) {
                    found_idx = Some(i);
                    break;
                }
            }
        }
        if let Some(idx) = found_idx {
            let mut entry = zip.by_index(idx).with_context(|| {
                format!(
                    "在安装器 {} 中抽取 {} 失败",
                    installer_path.display(),
                    internal
                )
            })?;
            let temp_dir = mc_dir.join("temp_installer_resources");
            fs::create_dir_all(&temp_dir).ok();
            let safe_name = internal.replace('/', "_");
            let out_path = temp_dir.join(&safe_name);
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes)?;
            fs::write(&out_path, bytes)
                .with_context(|| format!("写入临时资源 {} 失败", out_path.display()))?;
            return Ok(normalize_path(&out_path.to_string_lossy()));
        }
        return Ok(format!(
            "{}!/{}",
            normalize_path(&installer_path.to_string_lossy()),
            internal
        ));
    }
    if raw.contains(':') {
        let rel = maven_to_path(raw);
        let full = libraries_dir.join(&rel);
        return Ok(normalize_path(&full.to_string_lossy()));
    }
    Ok(normalize_path(raw))
}
pub fn build_data_map(
    profile: &InstallProfile,
    libraries_dir: &Path,
    installer_path: &Path,
    mc_dir: &Path,
) -> Result<HashMap<String, String>> {
    let mut map: HashMap<String, String> = HashMap::new();
    map.insert("SIDE".to_string(), "client".to_string());
    map.insert(
        "INSTALLER".to_string(),
        normalize_path(&installer_path.to_string_lossy()),
    );
    for (key, entry) in &profile.data {
        let raw = entry
            .client
            .clone()
            .or_else(|| entry.server.clone())
            .unwrap_or_default();
        let resolved = resolve_data_value(&raw, libraries_dir, installer_path, mc_dir)
            .unwrap_or_else(|_| raw.clone());
        map.insert(key.clone(), resolved);
    }
    Ok(map)
}
pub fn substitute(text: &str, data: &HashMap<String, String>) -> String {
    let mut out = text.to_string();
    let mut keys: Vec<&String> = data.keys().collect();
    keys.sort_by(|a, b| b.len().cmp(&a.len()));
    for k in keys {
        let placeholder = format!("{{{}}}", k);
        if let Some(v) = data.get(k) {
            out = out.replace(&placeholder, v);
        }
    }
    out
}
async fn ensure_library_async(
    coord: &str,
    libraries_dir: &Path,
    mirrors: &[&str],
) -> Result<PathBuf> {
    let rel = maven_to_path(coord);
    let target = libraries_dir.join(&rel);
    if target.exists() && fs::metadata(&target).map(|m| m.len() > 0).unwrap_or(false) {
        return Ok(target);
    }
    if coord.starts_with("net.minecraft:") {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).ok();
        }
        return Ok(target);
    }
    let urls: Vec<String> = mirrors
        .iter()
        .map(|m| format!("{}/{}", m.trim_end_matches('/'), rel))
        .collect();
    let task = crate::downloader::concurrent_download::DownloadTask {
        file_name: target
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        target_dir: target
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| libraries_dir.to_path_buf()),
        urls,
        sha1: None,
    };
    crate::downloader::concurrent_download::download_one(task)
        .await
        .with_context(|| format!("库 {} 下载失败（目标: {}）", coord, target.display()))
}
#[allow(dead_code)]
async fn download_url_async(url: &str, target: &Path) -> Result<()> {
    let task = crate::downloader::concurrent_download::DownloadTask {
        file_name: target
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        target_dir: target
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from(".")),
        urls: vec![url.to_string()],
        sha1: None,
    };
    crate::downloader::concurrent_download::download_one(task)
        .await
        .map(|_| ())
}
async fn fetch_minecraft_version_package(mc_version: &str) -> Result<serde_json::Value> {
    let client = crate::http_client::shared_client().await;
    let manifest_url = "https://launchermeta.mojang.com/mc/game/version_manifest.json";
    let manifest: serde_json::Value = client
        .get(manifest_url)
        .send()
        .await
        .with_context(|| format!("请求 {} 失败", manifest_url))?
        .json()
        .await
        .context("解析 version_manifest.json 失败")?;
    let versions = manifest["versions"]
        .as_array()
        .ok_or_else(|| anyhow!("缺少 versions 数组"))?;
    let package_url = versions
        .iter()
        .find(|v| v["id"].as_str() == Some(mc_version))
        .and_then(|v| v["url"].as_str().map(|s| s.to_string()))
        .ok_or_else(|| anyhow!("未在 Mojang 版本清单中找到 Minecraft {}", mc_version))?;
    let package: serde_json::Value = client
        .get(&package_url)
        .send()
        .await
        .with_context(|| format!("请求 {} 失败", package_url))?
        .json()
        .await
        .context("解析 Minecraft package.json 失败")?;
    Ok(package)
}
pub async fn ensure_minecraft_client_jar_async(
    mc_version: &str,
    libraries_dir: &Path,
) -> Result<PathBuf> {
    let rel = maven_to_path(&format!("net.minecraft:client:{}@jar", mc_version));
    let target = libraries_dir.join(&rel);
    if target.exists() && fs::metadata(&target).map(|m| m.len() > 0).unwrap_or(false) {
        return Ok(target);
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).ok();
    }
    let package = fetch_minecraft_version_package(mc_version).await?;
    let client_url = package["downloads"]["client"]["url"]
        .as_str()
        .ok_or_else(|| anyhow!("package.json 缺少 downloads.client.url"))?
        .to_string();
    println!(
        "  下载原版 Minecraft {} client jar → {}",
        mc_version,
        target.display()
    );
    let task = crate::downloader::concurrent_download::DownloadTask {
        file_name: target
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        target_dir: target
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| libraries_dir.to_path_buf()),
        urls: vec![client_url],
        sha1: package["downloads"]["client"]["sha1"]
            .as_str()
            .map(|s| s.to_string()),
    };
    crate::downloader::concurrent_download::download_one(task)
        .await
        .map(|_| target)
}
pub async fn ensure_minecraft_client_mappings_async(
    mc_version: &str,
    libraries_dir: &Path,
) -> Result<PathBuf> {
    let rel = maven_to_path(&format!("net.minecraft:client:{}:mappings@txt", mc_version));
    let target = libraries_dir.join(&rel);
    if target.exists() && fs::metadata(&target).map(|m| m.len() > 0).unwrap_or(false) {
        return Ok(target);
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).ok();
    }
    let package = fetch_minecraft_version_package(mc_version).await?;
    let mapping_url = package["downloads"]["client_mappings"]["url"]
        .as_str()
        .or_else(|| package["downloads"]["server_mappings"]["url"].as_str())
        .ok_or_else(|| anyhow!("package.json 缺少 client_mappings"))?
        .to_string();
    println!(
        "  下载原版 Minecraft {} client mappings → {}",
        mc_version,
        target.display()
    );
    let task = crate::downloader::concurrent_download::DownloadTask {
        file_name: target
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        target_dir: target
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| libraries_dir.to_path_buf()),
        urls: vec![mapping_url],
        sha1: None,
    };
    crate::downloader::concurrent_download::download_one(task)
        .await
        .map(|_| target)
}
pub async fn run_processors_async(
    profile: &InstallProfile,
    libraries_dir: &Path,
    installer_path: &Path,
    mc_dir: &Path,
    java_bin: &str,
) -> Result<usize> {
    let data_map = build_data_map(profile, libraries_dir, installer_path, mc_dir)?;
    let mirrors: &[&str] = &[
        "https://bmclapi2.bangbang93.com/maven/",
        "https://files.minecraftforge.net/maven/",
        "https://libraries.minecraft.net/",
        "https://maven.aliyun.com/repository/public/",
        "https://repo.spongepowered.org/maven/",
        "https://repo1.maven.org/maven2/",
    ];
    let mut all_needed_coords: Vec<String> = Vec::new();
    for proc in &profile.processors {
        if let Some(sides) = &proc.sides {
            if !sides.iter().any(|s| s == "client") {
                continue;
            }
        }
        if let Some(jar) = &proc.jar {
            all_needed_coords.push(jar.clone());
        }
        for lib in &proc.classpath {
            all_needed_coords.push(lib.clone());
        }
    }
    all_needed_coords.sort();
    all_needed_coords.dedup();
    {
        let mut pre_tasks: Vec<crate::downloader::concurrent_download::DownloadTask> =
            Vec::with_capacity(all_needed_coords.len());
        for coord in &all_needed_coords {
            if coord.starts_with("net.minecraft:") {
                continue;
            }
            let rel = maven_to_path(coord);
            let target = libraries_dir.join(&rel);
            if target.exists() && fs::metadata(&target).map(|m| m.len() > 0).unwrap_or(false) {
                continue;
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).ok();
            }
            let urls: Vec<String> = mirrors
                .iter()
                .map(|m| format!("{}/{}", m.trim_end_matches('/'), rel))
                .collect();
            pre_tasks.push(crate::downloader::concurrent_download::DownloadTask {
                file_name: target
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default(),
                target_dir: target
                    .parent()
                    .map(|p| p.to_path_buf())
                    .unwrap_or_else(|| libraries_dir.to_path_buf()),
                urls,
                sha1: None,
            });
        }
        if !pre_tasks.is_empty() {
            println!("  预热并行下载 {} 个 processor 依赖库", pre_tasks.len());
            let _ = crate::downloader::concurrent_download::download_all(pre_tasks, None).await;
        }
    }
    let mut ran = 0usize;
    for proc in &profile.processors {
        if let Some(sides) = &proc.sides {
            if !sides.iter().any(|s| s == "client") {
                continue;
            }
        }
        let mut needed: Vec<String> = Vec::new();
        if let Some(jar) = &proc.jar {
            needed.push(jar.clone());
        }
        for lib in &proc.classpath {
            needed.push(lib.clone());
        }
        needed.dedup();
        let mut local_paths: Vec<String> = Vec::new();
        for coord in &needed {
            match ensure_library_async(coord, libraries_dir, mirrors).await {
                Ok(p) => local_paths.push(normalize_path(&p.to_string_lossy())),
                Err(e) => println!("    警告：库 {} 下载警告：{}", coord, e),
            }
        }
        if local_paths.is_empty() {
            println!("    跳过 processor：没有可执行的 jar");
            continue;
        }
        let main_class = if let Some(jar_name) = &proc.jar {
            let rel = maven_to_path(jar_name);
            let jar_path = libraries_dir.join(&rel);
            match read_manifest_main_class(&jar_path) {
                Ok(Some(cls)) => Some(cls),
                _ => None,
            }
        } else {
            None
        };
        let args: Vec<String> = proc.args.iter().map(|a| substitute(a, &data_map)).collect();
        let mut cmd = Command::new(java_bin);
        if let Some(cls) = &main_class {
            cmd.arg("-cp");
            cmd.arg(local_paths.join(if cfg!(windows) { ";" } else { ":" }));
            cmd.arg(cls);
        } else if let Some(jar_name) = &proc.jar {
            let rel = maven_to_path(jar_name);
            cmd.arg("-jar");
            cmd.arg(normalize_path(&libraries_dir.join(rel).to_string_lossy()));
        } else {
            continue;
        }
        for a in &args {
            cmd.arg(a);
        }
        let display_args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        println!("  运行 processor: java {}", display_args.join(" "));
        let status = cmd.status().with_context(|| {
            format!(
                "运行 processor {} 失败",
                proc.jar.clone().unwrap_or_default()
            )
        })?;
        if !status.success() {
            return Err(anyhow!(
                "processor 执行失败（退出码 {:?}）：java {}",
                status.code(),
                display_args.join(" ")
            ));
        }
        ran += 1;
    }
    Ok(ran)
}
fn read_manifest_main_class(jar_path: &Path) -> Result<Option<String>> {
    let file = File::open(jar_path).with_context(|| format!("读取 {} 失败", jar_path.display()))?;
    let mut zip = ZipArchive::new(file)
        .with_context(|| format!("解析 {} 为 zip 失败", jar_path.display()))?;
    let mut manifest = String::new();
    for i in 0..zip.len() {
        let mut entry = match zip.by_index(i) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = entry.name().to_string();
        if name.ends_with("META-INF/MANIFEST.MF") {
            entry.read_to_string(&mut manifest)?;
            break;
        }
    }
    if manifest.is_empty() {
        return Ok(None);
    }
    let mut joined = String::new();
    for line in manifest.lines() {
        if line.starts_with(' ') || line.starts_with('\t') {
            joined.push_str(line.trim_start());
        } else {
            joined.push('\n');
            joined.push_str(line);
        }
    }
    for line in joined.lines() {
        if let Some(rest) = line.strip_prefix("Main-Class:") {
            return Ok(Some(rest.trim().to_string()));
        }
    }
    Ok(None)
}
pub fn write_version_json(
    version_id: &str,
    version_json: &Value,
    mc_dir: &Path,
) -> Result<PathBuf> {
    let version_dir = mc_dir.join("versions").join(version_id);
    fs::create_dir_all(&version_dir)
        .with_context(|| format!("创建 {} 失败", version_dir.display()))?;
    let out_path = version_dir.join(format!("{}.json", version_id));
    let text = serde_json::to_string_pretty(version_json).context("序列化 version.json 失败")?;
    let mut f =
        File::create(&out_path).with_context(|| format!("创建 {} 失败", out_path.display()))?;
    f.write_all(text.as_bytes())?;
    Ok(out_path)
}
#[allow(dead_code)]
fn _unused_cursor(_: Cursor<Vec<u8>>) {}