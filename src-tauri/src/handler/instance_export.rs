//! Export a live game instance to standard Modrinth / CurseForge modpack archives.

use crate::handler::mod_file_registry::lookup_by_sha1;
use crate::handler::mod_platform::{compute_update_check_file_digest, file_sha1_hex};
use crate::http_client::{curseforge_client, get_with_retry, modrinth_client};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipWriter};

const SHADER_CONFIG_PREFIXES: &[&str] = &[
    "config/iris",
    "config/oculus",
    "config/embeddium",
    "config/sodium",
    "config/nvidium",
    "config/reeses-sodium-options",
    "config/vulkanmod",
];

const SHADER_ROOT_FILES: &[&str] = &["optionsshaders.txt", "optionsof.txt"];

const GAME_SETTING_FILES: &[&str] = &["options.txt", "servers.dat"];

static EXPORT_TASK_COUNTER: AtomicU64 = AtomicU64::new(2_000_000);

struct ExportActiveTask {
    cancel: Arc<AtomicBool>,
}

fn active_export_tasks() -> &'static Mutex<HashMap<u64, ExportActiveTask>> {
    static INSTANCE: OnceLock<Mutex<HashMap<u64, ExportActiveTask>>> = OnceLock::new();
    INSTANCE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceExportOptions {
    pub minecraft_path: String,
    pub instance_folder: String,
    pub pack_name: String,
    pub pack_version: String,
    pub summary: Option<String>,
    /// `modrinth` | `curseforge`
    pub format: String,
    /// `pack_only` | `portable_folder`
    pub output_mode: String,
    pub output_path: String,
    pub include_launcher: bool,
    pub include_mods: bool,
    pub include_mod_configs: bool,
    pub include_shaderpacks: bool,
    pub include_shader_configs: bool,
    pub include_resourcepacks: bool,
    pub include_game_settings: bool,
    pub include_saves: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceExportProgressPayload {
    pub task_id: u64,
    pub current: usize,
    pub total: usize,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceExportFinishedPayload {
    pub task_id: u64,
    pub success: bool,
    pub message: String,
    pub output_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundledModpackMeta {
    pub pack_file: String,
    pub format: String,
    pub pack_name: String,
    pub sha256: String,
    pub installed: bool,
    pub instance_name: Option<String>,
}

struct InstanceMeta {
    mc_version: String,
    /// fabric | forge | neoforge | quilt | liteloader | optifine | vanilla
    loader: String,
    loader_version: String,
    /// Optional OptiFine version when combined with another loader (or standalone).
    optifine_version: Option<String>,
}

struct OverrideFile {
    abs: PathBuf,
    rel: String,
}

struct ModrinthIndexFileOut {
    path: String,
    hashes: HashMap<String, String>,
    downloads: Vec<String>,
    file_size: u64,
}

struct CurseForgeFileOut {
    project_id: i64,
    file_id: i64,
}

fn validate_relative_path(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.starts_with('/')
        || path.starts_with('\\')
        || path.contains('\\')
        || path.split('/').any(|p| p.is_empty() || p == "." || p == "..")
    {
        return Err(format!("不安全的路径: {}", path));
    }
    Ok(())
}

fn is_version_engine_dir(name: &str) -> bool {
    name.to_lowercase().ends_with("-natives")
}

fn rel_path_from(instance_dir: &Path, file: &Path) -> Option<String> {
    file.strip_prefix(instance_dir)
        .ok()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
}

fn is_shader_config_rel(rel: &str) -> bool {
    let lower = rel.replace('\\', "/").to_ascii_lowercase();
    if SHADER_ROOT_FILES
        .iter()
        .any(|f| lower == *f || lower.ends_with(&format!("/{}", f)))
    {
        return true;
    }
    SHADER_CONFIG_PREFIXES
        .iter()
        .any(|prefix| lower == *prefix || lower.starts_with(&format!("{}/", prefix)))
}

fn is_mod_config_rel(rel: &str) -> bool {
    let lower = rel.replace('\\', "/");
    lower.starts_with("config/") && !is_shader_config_rel(rel)
}

fn walk_files_under(dir: &Path, rel_prefix: &str, out: &mut Vec<OverrideFile>) -> Result<(), String> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if is_version_engine_dir(&name) {
                continue;
            }
            walk_files_under(&path, rel_prefix, out)?;
            continue;
        }
        if !path.is_file() {
            continue;
        }
        let rel = if rel_prefix.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", rel_prefix.trim_end_matches('/'), name)
        };
        validate_relative_path(&rel)?;
        out.push(OverrideFile {
            abs: path,
            rel,
        });
    }
    Ok(())
}

fn walk_tree(
    instance_dir: &Path,
    sub: &str,
    filter: Option<fn(&str) -> bool>,
    out: &mut Vec<OverrideFile>,
) -> Result<(), String> {
    let root = instance_dir.join(sub);
    if !root.is_dir() {
        return Ok(());
    }
    let mut stack: Vec<PathBuf> = vec![root];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                if is_version_engine_dir(&name) {
                    continue;
                }
                stack.push(path);
                continue;
            }
            if !path.is_file() {
                continue;
            }
            let rel = rel_path_from(instance_dir, &path).ok_or_else(|| {
                format!("路径越界: {}", path.display())
            })?;
            validate_relative_path(&rel)?;
            if filter.map(|f| f(&rel)).unwrap_or(true) {
                out.push(OverrideFile { abs: path, rel });
            }
        }
    }
    Ok(())
}

fn push_unique(
    files: &mut Vec<OverrideFile>,
    seen: &mut HashSet<String>,
    f: OverrideFile,
) {
    if seen.insert(f.rel.clone()) {
        files.push(f);
    }
}

fn collect_override_files(
    instance_dir: &Path,
    opts: &InstanceExportOptions,
) -> Result<Vec<OverrideFile>, String> {
    let mut files: Vec<OverrideFile> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    if opts.include_mods {
        walk_tree(instance_dir, "mods", None, &mut files)?;
    }
    if opts.include_shaderpacks {
        walk_tree(instance_dir, "shaderpacks", None, &mut files)?;
    }
    if opts.include_resourcepacks {
        walk_tree(instance_dir, "resourcepacks", None, &mut files)?;
    }
    if opts.include_saves {
        walk_tree(instance_dir, "saves", None, &mut files)?;
    }
    if opts.include_mod_configs {
        walk_tree(instance_dir, "config", Some(is_mod_config_rel), &mut files)?;
    }
    if opts.include_shader_configs {
        walk_tree(instance_dir, "config", Some(is_shader_config_rel), &mut files)?;
        for name in SHADER_ROOT_FILES {
            let p = instance_dir.join(name);
            if p.is_file() {
                let rel = name.to_string();
                validate_relative_path(&rel)?;
                push_unique(&mut files, &mut seen, OverrideFile { abs: p, rel });
            }
        }
    }
    if opts.include_game_settings {
        for name in GAME_SETTING_FILES {
            let p = instance_dir.join(name);
            if p.is_file() {
                let rel = name.to_string();
                push_unique(&mut files, &mut seen, OverrideFile { abs: p, rel });
            }
        }
        let srp = instance_dir.join("server-resource-packs");
        if srp.is_dir() {
            let mut tmp = Vec::new();
            walk_files_under(&srp, "server-resource-packs", &mut tmp)?;
            for f in tmp {
                push_unique(&mut files, &mut seen, f);
            }
        }
    }

    Ok(files)
}

fn json_str(value: &serde_json::Value, key: &str) -> Option<String> {
    value.get(key).and_then(|v| v.as_str()).map(str::to_owned)
}

fn extract_mc_from_name(name: &str) -> String {
    // Prefer 1.x candidates when multiple version-like tokens appear (loader vs MC).
    let re = match Regex::new(r"\d+\.\d+(?:\.\d+(?:-pre\d+|-rc\d+)?)?") {
        Ok(r) => r,
        Err(_) => return name.to_string(),
    };
    let candidates: Vec<&str> = re.find_iter(name).map(|m| m.as_str()).collect();
    if let Some(v) = candidates.iter().find(|v| v.starts_with("1.")) {
        return (*v).to_string();
    }
    candidates
        .first()
        .map(|s| (*s).to_string())
        .unwrap_or_else(|| name.to_string())
}

fn library_artifact_version(name: &str) -> Option<String> {
    // Maven coords: group:artifact:version[:classifier]
    let parts: Vec<&str> = name.split(':').collect();
    if parts.len() >= 3 {
        let ver = parts[2].trim();
        if !ver.is_empty() {
            return Some(ver.to_string());
        }
    }
    None
}

fn for_each_library_name(json: &serde_json::Value, mut f: impl FnMut(&str)) {
    if let Some(libs) = json.get("libraries").and_then(|v| v.as_array()) {
        for lib in libs {
            if let Some(name) = lib.get("name").and_then(|v| v.as_str()) {
                f(name);
            }
        }
    }
    if let Some(patches) = json.get("patches").and_then(|v| v.as_array()) {
        for patch in patches {
            if let Some(libs) = patch.get("libraries").and_then(|v| v.as_array()) {
                for lib in libs {
                    if let Some(name) = lib.get("name").and_then(|v| v.as_str()) {
                        f(name);
                    }
                }
            }
        }
    }
}

fn detect_loader_and_version_from_json(json: &serde_json::Value) -> (String, String, Option<String>) {
    let mut loader = String::new();
    let mut loader_version = String::new();
    let mut optifine_version: Option<String> = None;

    for_each_library_name(json, |name| {
        let lower = name.to_ascii_lowercase();
        if lower.starts_with("net.neoforged:neoforge:")
            || lower.starts_with("net.neoforged:forge:")
        {
            if loader.is_empty() || loader == "forge" {
                loader = "neoforge".to_string();
                if let Some(v) = library_artifact_version(name) {
                    loader_version = v;
                }
            }
        } else if lower.starts_with("net.minecraftforge:forge:")
            || lower.starts_with("net.minecraftforge:fmlloader:")
        {
            if loader.is_empty() {
                loader = "forge".to_string();
                if let Some(v) = library_artifact_version(name) {
                    // forge coords are often `1.21.1-52.0.0` — keep as-is for installer.
                    loader_version = v;
                }
            }
        } else if lower.starts_with("net.fabricmc:fabric-loader:")
            || lower.starts_with("net.fabricmc:loader:")
        {
            if loader.is_empty() {
                loader = "fabric".to_string();
                if let Some(v) = library_artifact_version(name) {
                    loader_version = v;
                }
            }
        } else if lower.starts_with("org.quiltmc:quilt-loader:") {
            if loader.is_empty() {
                loader = "quilt".to_string();
                if let Some(v) = library_artifact_version(name) {
                    loader_version = v;
                }
            }
        } else if lower.starts_with("com.mumfrey:liteloader:") {
            if loader.is_empty() {
                loader = "liteloader".to_string();
                if let Some(v) = library_artifact_version(name) {
                    loader_version = v;
                }
            }
        } else if lower.contains("optifine") {
            if let Some(v) = library_artifact_version(name) {
                optifine_version = Some(v);
            } else if optifine_version.is_none() {
                optifine_version = Some(name.to_string());
            }
        }
    });

    // Folder / id / mainClass fallbacks when libraries did not yield a loader.
    if loader.is_empty() {
        if let Some(main) = json.get("mainClass").and_then(|v| v.as_str()) {
            let mc = main.to_ascii_lowercase();
            if mc.contains("fabricmc") || mc.contains("knot") {
                loader = "fabric".to_string();
            } else if mc.contains("quilt") {
                loader = "quilt".to_string();
            } else if mc.contains("neoforged") {
                loader = "neoforge".to_string();
            } else if mc.contains("minecraftforge")
                || mc.contains("bootstraplauncher")
                || mc.contains("modlauncher")
            {
                loader = "forge".to_string();
            } else if mc.contains("liteloader") {
                loader = "liteloader".to_string();
            } else if mc.contains("optifine") {
                loader = "optifine".to_string();
            }
        }
    }

    if loader.is_empty() {
        if let Some(id) = json.get("id").and_then(|v| v.as_str()) {
            let (l, v, of) = detect_loader_from_folder_name(id);
            if !l.is_empty() && l != "vanilla" {
                loader = l;
                if loader_version.is_empty() {
                    loader_version = v;
                }
                if optifine_version.is_none() {
                    optifine_version = of;
                }
            }
        }
    }

    if loader.is_empty() {
        loader = "vanilla".to_string();
    }

    // Standalone OptiFine: promote optifine_version into primary loader.
    if loader == "vanilla" {
        if let Some(of) = optifine_version.clone() {
            loader = "optifine".to_string();
            if loader_version.is_empty() {
                loader_version = of;
            }
        }
    }

    (loader, loader_version, optifine_version)
}

fn detect_loader_from_folder_name(folder: &str) -> (String, String, Option<String>) {
    let folder_lower = folder.to_ascii_lowercase();
    let mut optifine_version = None;
    if folder_lower.contains("optifine") {
        // e.g. 1.20.1-OptiFine_HD_U_I6 or combined 1.20.1-forge-47.2.0-OptiFine_...
        if let Ok(re) = Regex::new(r"(?i)optifine[_\-]?(.+)$") {
            if let Some(caps) = re.captures(&folder_lower) {
                optifine_version = caps.get(1).map(|m| m.as_str().to_string());
            }
        }
        if optifine_version.is_none() {
            optifine_version = Some(folder.to_string());
        }
    }

    if let Ok(re) = Regex::new(
        r"(?i)^(\d+\.\d+(?:\.\d+)?(?:-pre\d+|-rc\d+)?)[-_](fabric|forge|neoforge|quilt|liteloader|optifine)[-_](.+)$",
    ) {
        if let Some(caps) = re.captures(&folder_lower) {
            let loader = caps.get(2).map(|m| m.as_str().to_string()).unwrap_or_default();
            let mut ver = caps
                .get(3)
                .map(|m| m.as_str().to_string())
                .unwrap_or_default();
            // Strip trailing OptiFine suffix from loader version when combined.
            if let Some(idx) = ver.to_ascii_lowercase().find("optifine") {
                let trimmed = ver[..idx].trim_matches(|c| c == '-' || c == '_');
                if !trimmed.is_empty() {
                    ver = trimmed.to_string();
                }
            }
            return (loader, ver, optifine_version);
        }
    }

    if folder_lower.contains("neoforge") {
        return ("neoforge".into(), String::new(), optifine_version);
    }
    if folder_lower.contains("fabric") {
        return ("fabric".into(), String::new(), optifine_version);
    }
    if folder_lower.contains("quilt") {
        return ("quilt".into(), String::new(), optifine_version);
    }
    if folder_lower.contains("forge") {
        return ("forge".into(), String::new(), optifine_version);
    }
    if folder_lower.contains("liteloader") {
        return ("liteloader".into(), String::new(), optifine_version);
    }
    if optifine_version.is_some() {
        return (
            "optifine".into(),
            optifine_version.clone().unwrap_or_default(),
            optifine_version,
        );
    }
    ("vanilla".into(), String::new(), None)
}

fn detect_mc_version_from_json(json: &serde_json::Value, folder: &str) -> String {
    if let Some(inherits) = json.get("inheritsFrom").and_then(|v| v.as_str()) {
        let extracted = extract_mc_from_name(inherits);
        if !extracted.is_empty() {
            return extracted;
        }
    }
    // patches[].id sometimes holds vanilla version
    if let Some(patches) = json.get("patches").and_then(|v| v.as_array()) {
        for patch in patches {
            if let Some(id) = patch.get("id").and_then(|v| v.as_str()) {
                let lower = id.to_ascii_lowercase();
                if lower == "game" || lower.starts_with("1.") {
                    let extracted = extract_mc_from_name(id);
                    if extracted.starts_with("1.") {
                        return extracted;
                    }
                }
            }
        }
    }
    extract_mc_from_name(folder)
}

/// Infer MC + loader metadata from the instance version JSON (libraries first),
/// then folder name. Never invent a fake fabric-loader version.
fn infer_instance_meta(instance_dir: &Path, folder: &str) -> InstanceMeta {
    let json_path = instance_dir.join(format!("{}.json", folder));
    let mut mc_version = extract_mc_from_name(folder);
    let mut loader = "vanilla".to_string();
    let mut loader_version = String::new();
    let mut optifine_version: Option<String> = None;

    if let Ok(text) = fs::read_to_string(&json_path) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
            mc_version = detect_mc_version_from_json(&json, folder);
            let (l, v, of) = detect_loader_and_version_from_json(&json);
            loader = l;
            loader_version = v;
            optifine_version = of;
        }
    }

    if loader == "vanilla" || loader_version.is_empty() {
        let (l, v, of) = detect_loader_from_folder_name(folder);
        if loader == "vanilla" && l != "vanilla" {
            loader = l;
        }
        if loader_version.is_empty() && !v.is_empty() {
            loader_version = v;
        }
        if optifine_version.is_none() {
            optifine_version = of;
        }
    }

    // Forge/NeoForge library versions may be `MC-loader` — installer accepts both.
    // Fabric/Quilt must be bare loader version (not MC version).
    if matches!(loader.as_str(), "fabric" | "quilt" | "liteloader")
        && (loader_version.is_empty() || loader_version == mc_version)
    {
        // Last resort: try folder pattern again for loader version only.
        let (_, v, _) = detect_loader_from_folder_name(folder);
        if !v.is_empty() && v != mc_version {
            loader_version = v;
        }
    }

    InstanceMeta {
        mc_version,
        loader,
        loader_version,
        optifine_version,
    }
}

fn build_modrinth_dependencies(meta: &InstanceMeta) -> Result<serde_json::Value, String> {
    if meta.mc_version.trim().is_empty() {
        return Err("无法确定 Minecraft 版本，无法导出整合包".to_string());
    }
    let mut deps = serde_json::json!({
        "minecraft": meta.mc_version,
    });
    match meta.loader.as_str() {
        "fabric" => {
            if meta.loader_version.trim().is_empty()
                || meta.loader_version == "0.0.0"
                || meta.loader_version == meta.mc_version
            {
                return Err(format!(
                    "无法确定 Fabric Loader 版本（实例: {}），请确认版本 JSON 完整后再导出",
                    meta.mc_version
                ));
            }
            deps["fabric-loader"] = serde_json::Value::String(meta.loader_version.clone());
        }
        "forge" => {
            if meta.loader_version.trim().is_empty() {
                return Err("无法确定 Forge 版本，请确认版本 JSON 完整后再导出".to_string());
            }
            deps["forge"] = serde_json::Value::String(meta.loader_version.clone());
        }
        "neoforge" => {
            if meta.loader_version.trim().is_empty() {
                return Err("无法确定 NeoForge 版本，请确认版本 JSON 完整后再导出".to_string());
            }
            deps["neoforge-loader"] = serde_json::Value::String(meta.loader_version.clone());
        }
        "quilt" => {
            if meta.loader_version.trim().is_empty() {
                return Err("无法确定 Quilt Loader 版本，请确认版本 JSON 完整后再导出".to_string());
            }
            deps["quilt-loader"] = serde_json::Value::String(meta.loader_version.clone());
        }
        "liteloader" => {
            if meta.loader_version.trim().is_empty() {
                return Err("无法确定 LiteLoader 版本，请确认版本 JSON 完整后再导出".to_string());
            }
            deps["liteloader"] = serde_json::Value::String(meta.loader_version.clone());
        }
        "optifine" => {
            let ver = meta
                .optifine_version
                .as_ref()
                .filter(|s| !s.trim().is_empty())
                .cloned()
                .unwrap_or_else(|| meta.loader_version.clone());
            if ver.trim().is_empty() {
                return Err("无法确定 OptiFine 版本，请确认版本 JSON 完整后再导出".to_string());
            }
            deps["optifine"] = serde_json::Value::String(ver);
        }
        "vanilla" => {}
        other => {
            return Err(format!("不支持导出的加载器类型: {}", other));
        }
    }
    // Combined loader + OptiFine (e.g. Forge+OptiFine / Fabric+OptiFine)
    if meta.loader != "optifine" {
        if let Some(of) = meta
            .optifine_version
            .as_ref()
            .filter(|s| !s.trim().is_empty())
        {
            deps["optifine"] = serde_json::Value::String(of.clone());
        }
    }
    Ok(deps)
}

fn curseforge_loader_id(loader: &str, version: &str) -> Result<String, String> {
    let loader = loader.trim().to_ascii_lowercase();
    let version = version.trim();
    if loader.is_empty() || loader == "vanilla" {
        return Err("原版实例无需写入 CurseForge modLoaders；若需加载器请确认实例版本 JSON".to_string());
    }
    if loader == "optifine" {
        return Err("CurseForge 标准清单不支持 OptiFine 作为 modLoader，请改用 Modrinth 格式导出".to_string());
    }
    if version.is_empty() || version == "0.0.0" {
        return Err(format!("无法确定 {} 版本，无法写入 CurseForge 清单", loader));
    }
    // CF fabric id is `fabric-<loaderVer>` (not fabric-loader-).
    let cf_loader = if loader == "liteloader" {
        "liteloader"
    } else {
        loader.as_str()
    };
    let prefix = format!("{}-", cf_loader);
    if version.to_ascii_lowercase().starts_with(&prefix) {
        Ok(version.to_string())
    } else {
        Ok(format!("{}-{}", cf_loader, version))
    }
}

async fn modrinth_file_from_sha1(
    client: &reqwest::Client,
    sha1: &str,
    rel_path: &str,
) -> Option<ModrinthIndexFileOut> {
    let url = format!(
        "https://api.modrinth.com/v2/version_file/{}?algorithm=sha1",
        sha1
    );
    let response = get_with_retry(client, &url, None).await.ok()?;
    let json: serde_json::Value = response.json().await.ok()?;
    let files = json.get("files").and_then(|f| f.as_array())?;
    let file = files
        .iter()
        .find(|f| {
            f.get("hashes")
                .and_then(|h| h.get("sha1"))
                .and_then(|v| v.as_str())
                .map(|h| h.eq_ignore_ascii_case(sha1))
                .unwrap_or(false)
        })
        .or_else(|| files.first())?;
    let download_url = json_str(file, "url")?;
    let size = file.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
    let hashes_obj = file.get("hashes").and_then(|h| h.as_object());
    let mut hashes = HashMap::new();
    if let Some(obj) = hashes_obj {
        for (k, v) in obj {
            if let Some(s) = v.as_str() {
                hashes.insert(k.clone(), s.to_string());
            }
        }
    }
    if !hashes.contains_key("sha1") {
        hashes.insert("sha1".to_string(), sha1.to_string());
    }
    Some(ModrinthIndexFileOut {
        path: rel_path.replace('\\', "/"),
        hashes,
        downloads: vec![download_url],
        file_size: size,
    })
}

async fn curseforge_file_from_path(path: &Path) -> Option<CurseForgeFileOut> {
    let client = curseforge_client().await;
    let digest = compute_update_check_file_digest(path)?;
    let body = serde_json::json!({ "fingerprints": [digest.curseforge_fingerprint as u32] });
    let response = client
        .post("https://api.curseforge.com/v1/fingerprints/432")
        .json(&body)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let json: serde_json::Value = response.json().await.ok()?;
    let data = json.get("data")?;
    let exact = data
        .get("exactMatches")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())?;
    let file = exact.get("file").unwrap_or(exact);
    let project_id = exact
        .get("id")
        .and_then(|v| v.as_i64())
        .or_else(|| file.get("modId").and_then(|v| v.as_i64()))?;
    let file_id = file.get("id").and_then(|v| v.as_i64())?;
    if project_id <= 0 || file_id <= 0 {
        return None;
    }
    Some(CurseForgeFileOut {
        project_id,
        file_id,
    })
}

fn file_sha256_hex(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn emit_progress(app: &AppHandle, task_id: u64, current: usize, total: usize, message: &str) {
    let _ = app.emit(
        "instance-export-progress",
        InstanceExportProgressPayload {
            task_id,
            current,
            total,
            message: message.to_string(),
        },
    );
}

fn emit_finished(
    app: &AppHandle,
    task_id: u64,
    success: bool,
    message: &str,
    output_path: Option<String>,
) {
    let _ = app.emit(
        "instance-export-finished",
        InstanceExportFinishedPayload {
            task_id,
            success,
            message: message.to_string(),
            output_path,
        },
    );
}

fn write_zip_pack(
    output: &Path,
    format: &str,
    index_json: &serde_json::Value,
    overrides: &[OverrideFile],
    skip_rel: &HashSet<String>,
    cancel: &AtomicBool,
    app: &AppHandle,
    task_id: u64,
) -> Result<(), String> {
    let tmp = output.with_extension("export.tmp");
    if tmp.exists() {
        fs::remove_file(&tmp).ok();
    }
    let file = fs::File::create(&tmp).map_err(|e| format!("创建导出文件失败: {}", e))?;
    let mut zip = ZipWriter::new(file);
    let options = FileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);

    let meta_name = if format == "curseforge" {
        "manifest.json"
    } else {
        "modrinth.index.json"
    };

    zip.start_file(meta_name, options)
        .map_err(|e| format!("写入元数据失败: {}", e))?;
    let meta_bytes = serde_json::to_vec_pretty(index_json).map_err(|e| e.to_string())?;
    zip.write_all(&meta_bytes)
        .map_err(|e| format!("写入元数据失败: {}", e))?;

    if format == "curseforge" {
        zip.start_file("modlist.html", options)
            .map_err(|e| format!("写入 modlist 失败: {}", e))?;
        zip.write_all(b"<html><body><p>Exported from OpenXLauncher</p></body></html>")
            .map_err(|e| e.to_string())?;
    }

    let total = overrides.len();
    for (i, item) in overrides.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            return Err("导出已取消".to_string());
        }
        if skip_rel.contains(&item.rel) {
            continue;
        }
        let zip_path = format!("overrides/{}", item.rel.replace('\\', "/"));
        emit_progress(
            app,
            task_id,
            i + 1,
            total,
            &format!("打包 {}", item.rel),
        );
        zip.start_file(&zip_path, options)
            .map_err(|e| format!("写入 {} 失败: {}", zip_path, e))?;
        let mut src = fs::File::open(&item.abs).map_err(|e| e.to_string())?;
        let mut buf = [0u8; 64 * 1024];
        loop {
            let n = src.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            zip.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        }
    }

    zip.finish().map_err(|e| format!("完成 ZIP 失败: {}", e))?;
    if output.exists() {
        fs::remove_file(output).map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, output).map_err(|e| format!("保存导出文件失败: {}", e))?;
    Ok(())
}

async fn run_export(
    app: AppHandle,
    task_id: u64,
    opts: InstanceExportOptions,
    cancel: Arc<AtomicBool>,
) {
    let result = async {
        let instance_folder = opts.instance_folder.trim();
        if instance_folder.is_empty() {
            return Err("实例文件夹名不能为空".to_string());
        }
        let instance_dir = PathBuf::from(&opts.minecraft_path)
            .join("versions")
            .join(instance_folder);
        if !instance_dir.is_dir() {
            return Err(format!("实例目录不存在: {}", instance_dir.display()));
        }

        let overrides = collect_override_files(&instance_dir, &opts)?;
        if overrides.is_empty() {
            return Err("没有可导出的内容，请调整勾选项".to_string());
        }

        let meta = infer_instance_meta(&instance_dir, instance_folder);
        println!(
            "[InstanceExport] 实例元数据: MC={} loader={}@{} optifine={:?}",
            meta.mc_version, meta.loader, meta.loader_version, meta.optifine_version
        );
        emit_progress(
            &app,
            task_id,
            0,
            overrides.len(),
            &format!(
                "版本 {} · {} {}",
                meta.mc_version,
                meta.loader,
                if meta.loader_version.is_empty() {
                    String::new()
                } else {
                    meta.loader_version.clone()
                }
            ),
        );
        let format = opts.format.to_ascii_lowercase();
        if format != "modrinth" && format != "curseforge" {
            return Err("不支持的整合包格式".to_string());
        }

        let client = modrinth_client().await;
        let mut modrinth_index_files: Vec<ModrinthIndexFileOut> = Vec::new();
        let mut curseforge_files: Vec<CurseForgeFileOut> = Vec::new();
        let mut skip_override: HashSet<String> = HashSet::new();

        if opts.include_mods {
            emit_progress(&app, task_id, 0, overrides.len(), "解析 Mod 索引…");
            for item in &overrides {
                if !item.rel.replace('\\', "/").starts_with("mods/") {
                    continue;
                }
                if cancel.load(Ordering::SeqCst) {
                    return Err("导出已取消".to_string());
                }
                let sha1 = file_sha1_hex(&item.abs).ok_or_else(|| {
                    format!("无法计算文件哈希: {}", item.rel)
                })?;
                if format == "modrinth" {
                    if let Some(entry) = modrinth_file_from_sha1(&client, &sha1, &item.rel).await {
                        modrinth_index_files.push(entry);
                        skip_override.insert(item.rel.clone());
                        continue;
                    }
                    if let Some(binding) = lookup_by_sha1(&sha1) {
                        if binding.source == "modrinth" {
                            if let Some(entry) =
                                modrinth_file_from_sha1(&client, &sha1, &item.rel).await
                            {
                                modrinth_index_files.push(entry);
                                skip_override.insert(item.rel.clone());
                            }
                        }
                    }
                } else if format == "curseforge" {
                    if let Some(cf) = curseforge_file_from_path(&item.abs).await {
                        curseforge_files.push(cf);
                        skip_override.insert(item.rel.clone());
                    }
                }
            }
        }

        let pack_name = if opts.pack_name.trim().is_empty() {
            instance_folder.to_string()
        } else {
            opts.pack_name.trim().to_string()
        };
        let pack_version = if opts.pack_version.trim().is_empty() {
            "1.0.0".to_string()
        } else {
            opts.pack_version.trim().to_string()
        };

        let index_json = if format == "modrinth" {
            let files_json: Vec<serde_json::Value> = modrinth_index_files
                .iter()
                .map(|f| {
                    serde_json::json!({
                        "path": f.path,
                        "hashes": f.hashes,
                        "env": { "client": "required", "server": "required" },
                        "downloads": f.downloads,
                        "fileSize": f.file_size,
                    })
                })
                .collect();
            let dependencies = build_modrinth_dependencies(&meta)?;
            let mut index = serde_json::json!({
                "formatVersion": 1,
                "game": "minecraft",
                "versionId": pack_version,
                "name": pack_name,
                "files": files_json,
                "dependencies": dependencies,
            });
            if let Some(summary) = opts.summary.as_ref().filter(|s| !s.trim().is_empty()) {
                index["summary"] = serde_json::Value::String(summary.trim().to_string());
            }
            index
        } else {
            let manifest_files: Vec<serde_json::Value> = curseforge_files
                .iter()
                .map(|f| {
                    serde_json::json!({
                        "projectID": f.project_id,
                        "fileID": f.file_id,
                        "required": true,
                    })
                })
                .collect();
            let mod_loaders = if meta.loader == "vanilla" {
                Vec::<serde_json::Value>::new()
            } else {
                let id = curseforge_loader_id(&meta.loader, &meta.loader_version)?;
                vec![serde_json::json!({
                    "id": id,
                    "primary": true,
                })]
            };
            serde_json::json!({
                "minecraft": {
                    "version": meta.mc_version,
                    "modLoaders": mod_loaders,
                },
                "manifestType": "minecraftModpack",
                "manifestVersion": 1,
                "name": pack_name,
                "version": pack_version,
                "author": "OpenXLauncher",
                "files": manifest_files,
                "overrides": "overrides",
            })
        };

        let output_mode = opts.output_mode.to_ascii_lowercase();
        let ext = if format == "curseforge" { "zip" } else { "mrpack" };

        let pack_output: PathBuf = if output_mode == "portable_folder" {
            let dir = PathBuf::from(opts.output_path.trim());
            if dir.as_os_str().is_empty() {
                return Err("请选择导出目录".to_string());
            }
            fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            dir.join(format!("bundled-pack.{}", ext))
        } else {
            let mut path = PathBuf::from(opts.output_path.trim());
            if path.as_os_str().is_empty() {
                return Err("请选择保存路径".to_string());
            }
            if path
                .extension()
                .and_then(|e| e.to_str())
                .map_or(true, |e| !e.eq_ignore_ascii_case(ext))
            {
                path.set_extension(ext);
            }
            path
        };

        if let Some(parent) = pack_output.parent() {
            fs::create_dir_all(parent).ok();
        }

        write_zip_pack(
            &pack_output,
            &format,
            &index_json,
            &overrides,
            &skip_override,
            cancel.as_ref(),
            &app,
            task_id,
        )?;

        if output_mode == "portable_folder" {
            let dir = pack_output.parent().unwrap();
            if opts.include_launcher {
                let exe = std::env::current_exe().map_err(|e| e.to_string())?;
                let target_name = exe
                    .file_name()
                    .map(|n| n.to_owned())
                    .unwrap_or_else(|| std::ffi::OsString::from("OpenXLauncher.exe"));
                let target_exe = dir.join(target_name);
                fs::copy(&exe, &target_exe).map_err(|e| format!("复制启动器失败: {}", e))?;
            }

            let sha256 = file_sha256_hex(&pack_output)?;
            let bundled_dir = dir.join("OpenX");
            fs::create_dir_all(&bundled_dir).map_err(|e| e.to_string())?;
            let meta = BundledModpackMeta {
                pack_file: pack_output
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| format!("bundled-pack.{}", ext)),
                format: format.clone(),
                pack_name: pack_name.clone(),
                sha256,
                installed: false,
                instance_name: None,
            };
            let meta_path = bundled_dir.join("bundled-modpack.json");
            fs::write(
                &meta_path,
                serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;

            return Ok(dir.to_string_lossy().to_string());
        }

        Ok(pack_output.to_string_lossy().to_string())
    }
    .await;

    active_export_tasks().lock().unwrap().remove(&task_id);

    match result {
        Ok(path) => emit_finished(&app, task_id, true, "导出完成", Some(path)),
        Err(e) => emit_finished(&app, task_id, false, &e, None),
    }
}

#[tauri::command]
pub async fn export_instance_modpack_cmd(
    app: AppHandle,
    options: InstanceExportOptions,
) -> Result<u64, String> {
    let task_id = EXPORT_TASK_COUNTER.fetch_add(1, Ordering::SeqCst);
    let cancel = Arc::new(AtomicBool::new(false));
    active_export_tasks()
        .lock()
        .unwrap()
        .insert(task_id, ExportActiveTask { cancel: cancel.clone() });

    let app_clone = app.clone();
    tokio::spawn(async move {
        run_export(app_clone, task_id, options, cancel).await;
    });

    Ok(task_id)
}

#[tauri::command]
pub fn cancel_instance_export_cmd(task_id: u64) -> Result<(), String> {
    let tasks = active_export_tasks().lock().unwrap();
    if let Some(task) = tasks.get(&task_id) {
        task.cancel.store(true, Ordering::SeqCst);
    }
    Ok(())
}

#[tauri::command]
pub fn estimate_instance_export_size_cmd(options: InstanceExportOptions) -> Result<u64, String> {
    let instance_folder = options.instance_folder.trim();
    let instance_dir = PathBuf::from(&options.minecraft_path)
        .join("versions")
        .join(instance_folder);
    if !instance_dir.is_dir() {
        return Err("实例目录不存在".to_string());
    }
    let files = collect_override_files(&instance_dir, &options)?;
    let total = files
        .iter()
        .filter_map(|f| fs::metadata(&f.abs).ok().map(|m| m.len()))
        .sum();
    Ok(total)
}

pub async fn maybe_install_bundled_modpack() -> Result<Option<String>, String> {
    let meta_path = crate::app_paths::portable_data_dir().join("bundled-modpack.json");
    if !meta_path.is_file() {
        return Ok(None);
    }
    let text = fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    let mut meta: BundledModpackMeta =
        serde_json::from_str(&text).map_err(|e| format!("解析 bundled-modpack.json 失败: {}", e))?;
    if meta.installed {
        return Ok(meta.instance_name);
    }

    let pack_path = crate::app_paths::launcher_exe_dir().join(&meta.pack_file);
    if !pack_path.is_file() {
        return Err(format!("找不到附带整合包: {}", pack_path.display()));
    }
    let sha256 = file_sha256_hex(&pack_path)?;
    if !sha256.eq_ignore_ascii_case(&meta.sha256) {
        return Err("附带整合包校验失败 (SHA256 不匹配)".to_string());
    }

    crate::app_paths::ensure_portable_dirs();
    let minecraft_path = crate::downloader::dwPatch::get_minecraft_dir()?;

    use crate::downloader::modpack_installer::install_modpack_from_zip;
    let (instance_name, _) = install_modpack_from_zip(&pack_path, &minecraft_path, None, None)
        .await
        .map_err(|e| format!("安装附带整合包失败: {}", e))?;
    meta.installed = true;
    meta.instance_name = Some(instance_name.clone());
    fs::write(
        &meta_path,
        serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    Ok(Some(instance_name))
}

#[tauri::command]
pub async fn maybe_install_bundled_modpack_cmd() -> Result<Option<String>, String> {
    maybe_install_bundled_modpack().await
}
