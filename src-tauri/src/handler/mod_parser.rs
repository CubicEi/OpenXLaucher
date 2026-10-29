use serde::{Deserialize, Serialize};
use serde_json::{self, Value as JsonValue};
use std::collections::HashMap;
use std::fs;
use std::io::{BufReader, Read, Seek};
use std::path::{Path, PathBuf};
use zip::ZipArchive;
use base64::{engine::general_purpose::STANDARD, Engine};
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModDependency {
    pub mod_id: String,
    pub version_range: Option<String>,
    pub mandatory: bool,
    pub ordering: Option<String>,
    pub side: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModInfo {
    pub file_name: String,
    pub mod_id: String,
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub authors: Vec<String>,
    pub license: Option<String>,
    pub icon: Option<String>,
    pub source: Option<String>,
    pub homepage: Option<String>,
    pub issues: Option<String>,
    pub minecraft_version: Option<String>,
    pub mod_loader: Option<String>,
    pub dependencies: Vec<ModDependency>,
    pub optional_dependencies: Vec<ModDependency>,
    pub incompatible_dependencies: Vec<ModDependency>,
}
fn is_platform_dep(mod_id: &str) -> bool {
    matches!(
        mod_id.to_ascii_lowercase().as_str(),
        "minecraft"
            | "forge"
            | "neoforge"
            | "fabricloader"
            | "fabric"
            | "fabric-api"
            | "quilt_loader"
            | "java"
            | "liteloader"
    )
}
fn simplify_version_range(ver: &str) -> String {
    let trimmed = ver.trim();
    if trimmed.is_empty() || trimmed == "*" {
        return trimmed.to_string();
    }
    if let Some(inner) = trimmed.strip_prefix('[').and_then(|s| s.strip_suffix(')')) {
        if inner.ends_with(',') {
            let start = inner.trim_end_matches(',').trim();
            if !start.is_empty() {
                return format!(">={}", start);
            }
        }
    }
    if let Some(inner) = trimmed.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
        if !inner.contains(',') {
            let exact = inner.trim();
            if !exact.is_empty() {
                return exact.to_string();
            }
        }
    }
    if trimmed.starts_with('[') && (trimmed.ends_with(']') || trimmed.ends_with(')')) {
        let inner = &trimmed[1..trimmed.len() - 1];
        let parts: Vec<&str> = inner.split(',').collect();
        if parts.len() == 2 {
            let start = parts[0].trim();
            let end = parts[1].trim();
            if !start.is_empty() && !end.is_empty() {
                return format!("{}-{}", start, end);
            }
        }
    }
    if let Some(inner) = trimmed.strip_prefix("(,").and_then(|s| s.strip_suffix(']')) {
        let end = inner.trim();
        if !end.is_empty() {
            return format!("<={}", end);
        }
    }
    if let Some(inner) = trimmed.strip_prefix("(,").and_then(|s| s.strip_suffix(')')) {
        let end = inner.trim();
        if !end.is_empty() {
            return format!("<{}", end);
        }
    }
    if let Some(inner) = trimmed.strip_prefix('(').and_then(|s| s.strip_suffix(')')) {
        if inner.ends_with(',') {
            let start = inner.trim_end_matches(',').trim();
            if !start.is_empty() {
                return format!(">{}", start);
            }
        }
    }
    trimmed.to_string()
}
fn read_jar_entry(
    archive: &mut ZipArchive<&mut BufReader<fs::File>>,
    name: &str,
) -> Option<String> {
    let mut entry = archive.by_name(name).ok()?;
    let mut content = String::new();
    entry.read_to_string(&mut content).ok()?;
    Some(content)
}

fn mime_for_icon_path(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else {
        "image/png"
    }
}

fn read_jar_entry_bytes(archive: &mut ZipArchive<impl Read + Seek>, entry_path: &str) -> Option<Vec<u8>> {
    let trimmed = entry_path.trim().trim_start_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(mut entry) = archive.by_name(trimmed) {
        let mut buf = Vec::new();
        if entry.read_to_end(&mut buf).is_ok() && !buf.is_empty() {
            return Some(buf);
        }
    }
    for i in 0..archive.len() {
        let Ok(mut entry) = archive.by_index(i) else {
            continue;
        };
        let name = entry.name().replace('\\', "/");
        if name == trimmed || name.ends_with(&format!("/{trimmed}")) {
            let mut buf = Vec::new();
            if entry.read_to_end(&mut buf).is_ok() && !buf.is_empty() {
                return Some(buf);
            }
        }
    }
    None
}

/// Read mod logo bytes from jar metadata (`logoFile` / fabric `icon`) and return a data URL.
pub fn mod_icon_data_url_from_jar(path: &Path) -> Option<String> {
    let info = parse_mod_file(path).ok()?;
    let icon_rel = info.icon.filter(|s| !s.trim().is_empty())?;
    let file = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut archive = ZipArchive::new(&mut reader).ok()?;
    let bytes = read_jar_entry_bytes(&mut archive, &icon_rel)?;
    let mime = mime_for_icon_path(&icon_rel);
    Some(format!("data:{};base64,{}", mime, STANDARD.encode(bytes)))
}

/// Resource pack icon: `pack.png` inside a zip (or folder).
pub fn pack_png_data_url_from_path(path: &Path) -> Option<String> {
    if path.is_dir() {
        let png = path.join("pack.png");
        if png.is_file() {
            let bytes = fs::read(&png).ok()?;
            if bytes.is_empty() {
                return None;
            }
            return Some(format!(
                "data:image/png;base64,{}",
                STANDARD.encode(bytes)
            ));
        }
        return None;
    }
    if !path.is_file() {
        return None;
    }
    let file = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut archive = ZipArchive::new(&mut reader).ok()?;
    let bytes = read_jar_entry_bytes(&mut archive, "pack.png")?;
    Some(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(bytes)
    ))
}

fn stringify_mcmeta_description(value: &JsonValue) -> Option<String> {
    match value {
        JsonValue::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        }
        JsonValue::Object(map) => {
            if let Some(JsonValue::String(s)) = map.get("text") {
                let t = s.trim();
                if !t.is_empty() {
                    return Some(t.to_string());
                }
            }
            if let Some(JsonValue::String(s)) = map.get("translate") {
                let t = s.trim();
                if !t.is_empty() {
                    return Some(t.to_string());
                }
            }
            None
        }
        JsonValue::Array(items) => {
            let joined = items
                .iter()
                .filter_map(stringify_mcmeta_description)
                .collect::<Vec<_>>()
                .join("");
            let t = joined.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        }
        _ => None,
    }
}

/// Description from `pack.mcmeta` inside a zip or folder.
pub fn pack_mcmeta_description_from_path(path: &Path) -> Option<String> {
    let raw = if path.is_dir() {
        let meta = path.join("pack.mcmeta");
        fs::read_to_string(meta).ok()?
    } else if path.is_file() {
        let file = fs::File::open(path).ok()?;
        let mut reader = BufReader::new(file);
        let mut archive = ZipArchive::new(&mut reader).ok()?;
        read_jar_entry(&mut archive, "pack.mcmeta")?
    } else {
        return None;
    };
    let json: JsonValue = serde_json::from_str(&raw).ok()?;
    let desc = json.get("pack")?.get("description")?;
    stringify_mcmeta_description(desc)
}

pub fn parse_mod_file(path: &Path) -> Result<ModInfo, String> {
    let file = fs::File::open(path).map_err(|e| format!("打开文件失败: {}", e))?;
    let mut reader = BufReader::new(file);
    let mut archive = ZipArchive::new(&mut reader).map_err(|e| format!("解析 ZIP 失败: {}", e))?;
    let file_name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string());
    let mut mods_toml: Option<(String, String)> = None;
    let mut fabric_json: Option<String> = None;
    let mut mcmod_info: Option<String> = None;
    for i in 0..archive.len() {
        let entry = match archive.by_index(i) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let entry_name = entry.name().to_string();
        let lower = entry_name.to_ascii_lowercase();
        if lower == "meta-inf/mods.toml"
            || lower == "meta-inf/neoforge.mods.toml"
            || lower == "meta-inf/forge.mods.toml"
        {
            let tag = if lower == "meta-inf/neoforge.mods.toml" {
                "NeoForge (neoforge.mods.toml)"
            } else if lower == "meta-inf/forge.mods.toml" {
                "Forge (forge.mods.toml)"
            } else {
                "Forge (mods.toml)"
            };
            drop(entry);
            if let Some(content) = read_jar_entry(&mut archive, &entry_name) {
                mods_toml = Some((tag.to_string(), content));
            }
        } else if lower == "fabric.mod.json" {
            drop(entry);
            fabric_json = read_jar_entry(&mut archive, &entry_name);
        } else if lower == "mcmod.info" {
            drop(entry);
            mcmod_info = read_jar_entry(&mut archive, &entry_name);
        }
    }
    let info = if let Some((_, content)) = mods_toml {
        parse_mods_toml(&content, &file_name)
    } else if let Some(content) = fabric_json {
        parse_fabric_mod_json(&content, &file_name)
    } else if let Some(content) = mcmod_info {
        parse_mcmod_info(&content, &file_name)
    } else {
        let display_name = file_name.trim_end_matches(".jar").to_string();
        Ok(ModInfo {
            file_name: file_name.clone(),
            mod_id: display_name
                .to_lowercase()
                .replace(|c: char| !c.is_alphanumeric(), "_"),
            name: display_name,
            version: "unknown".to_string(),
            description: None,
            authors: Vec::new(),
            license: None,
            icon: None,
            source: None,
            homepage: None,
            issues: None,
            minecraft_version: None,
            mod_loader: None,
            dependencies: Vec::new(),
            optional_dependencies: Vec::new(),
            incompatible_dependencies: Vec::new(),
        })
    }?;
    Ok(info)
}
fn parse_mods_toml(content: &str, file_name: &str) -> Result<ModInfo, String> {
    let parsed = parse_toml(content);
    let mods = parsed
        .get("mods")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "mods.toml: 找不到 [[mods]]".to_string())?;
    let mod_entry = mods
        .first()
        .and_then(|v| v.as_object())
        .ok_or_else(|| "mods.toml: [[mods]] 无有效条目".to_string())?;
    let mod_id = mod_entry
        .get("modId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| file_name.to_lowercase().replace(".jar", ""));
    let name = mod_entry
        .get("displayName")
        .or_else(|| mod_entry.get("name"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| mod_id.clone());
    let version = mod_entry
        .get("version")
        .and_then(|v| v.as_str())
        .map(|s| {
            if s.starts_with("${") && s.ends_with("}") {
                file_name.trim_end_matches(".jar").to_string()
            } else {
                simplify_version_range(s)
            }
        })
        .unwrap_or_else(|| "unknown".to_string());
    let description = mod_entry
        .get("description")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let mut authors: Vec<String> = Vec::new();
    if let Some(author_str) = mod_entry
        .get("authors")
        .or_else(|| mod_entry.get("author"))
        .and_then(|v| v.as_str())
    {
        for part in author_str.split(|c: char| c == ',' || c == ';') {
            let trimmed = part.trim();
            if !trimmed.is_empty() {
                authors.push(trimmed.to_string());
            }
        }
    }
    let license = parsed
        .get("license")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            mod_entry
                .get("license")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty())
        });
    let icon = mod_entry
        .get("logoFile")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());
    let homepage = mod_entry
        .get("displayURL")
        .or_else(|| mod_entry.get("homepageURL"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());
    let issues = mod_entry
        .get("issueTrackerURL")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());
    let mod_loader = parsed.get("modLoader").and_then(|v| v.as_str()).map(|s| {
        let loader_name = if s == "javafml" { "Forge/NeoForge" } else { s };
        match parsed.get("loaderVersion").and_then(|v| v.as_str()) {
            Some(lv) => format!("{} ({})", loader_name, simplify_version_range(lv)),
            None => loader_name.to_string(),
        }
    });
    let dep_key = format!("dependencies.{}", mod_id);
    let mut dependencies: Vec<ModDependency> = Vec::new();
    let mut optional_dependencies: Vec<ModDependency> = Vec::new();
    let mut incompatible_dependencies: Vec<ModDependency> = Vec::new();
    let mut push_dep = |dep: (String, ModDependency)| {
        let (kind, d) = dep;
        match kind.as_str() {
            "required" => dependencies.push(d),
            "incompatible" => incompatible_dependencies.push(d),
            _ => optional_dependencies.push(d),
        }
    };
    let mut found_deps = false;
    if let Some(dep_arr) = parsed.get(&dep_key).and_then(|v| v.as_array()) {
        found_deps = true;
        for dep in dep_arr {
            if let Some(dep_obj) = dep.as_object() {
                if let Some(d) = parse_toml_dep(dep_obj) {
                    push_dep(d);
                }
            }
        }
    }
    if !found_deps {
        for (key, value) in parsed.iter() {
            if key.starts_with("dependencies.") && key != &dep_key {
                if let Some(arr) = value.as_array() {
                    for dep in arr {
                        if let Some(dep_obj) = dep.as_object() {
                            if let Some(d) = parse_toml_dep(dep_obj) {
                                push_dep(d);
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(ModInfo {
        file_name: file_name.to_string(),
        mod_id,
        name,
        version,
        description,
        authors,
        license,
        icon,
        source: None,
        homepage,
        issues,
        minecraft_version: None,
        mod_loader,
        dependencies,
        optional_dependencies,
        incompatible_dependencies,
    })
}
fn parse_toml_dep(obj: &serde_json::Map<String, JsonValue>) -> Option<(String, ModDependency)> {
    let dep_mod_id = obj
        .get("modId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_default();
    if dep_mod_id.is_empty() || is_platform_dep(&dep_mod_id) {
        return None;
    }
    let (kind, mandatory) = if let Some(type_str) = obj.get("type").and_then(|v| v.as_str()) {
        match type_str {
            "required" => ("required".to_string(), true),
            "optional" => ("optional".to_string(), false),
            "incompatible" => ("incompatible".to_string(), false),
            _ => ("optional".to_string(), false),
        }
    } else {
        let m = obj
            .get("mandatory")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let k = if m {
            "required".to_string()
        } else {
            "optional".to_string()
        };
        (k, m)
    };
    let version_range = obj
        .get("versionRange")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty() && s != "*")
        .map(|s| simplify_version_range(&s));
    let ordering = obj
        .get("ordering")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let side = obj
        .get("side")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Some((
        kind,
        ModDependency {
            mod_id: dep_mod_id,
            version_range,
            mandatory,
            ordering,
            side,
        },
    ))
}
/// Fabric jars often ship `fabric.mod.json` with raw newlines inside string values (invalid strict JSON).
fn parse_fabric_mod_json_value(content: &str) -> Result<JsonValue, String> {
    match serde_json::from_str(content) {
        Ok(value) => Ok(value),
        Err(first_err) => {
            let sanitized = escape_control_chars_in_json_strings(content);
            serde_json::from_str(&sanitized).map_err(|_| {
                format!("解析 JSON 失败: {}", first_err)
            })
        }
    }
}

fn escape_control_chars_in_json_strings(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 64);
    let mut in_string = false;
    let mut escape = false;
    for ch in input.chars() {
        if escape {
            out.push(ch);
            escape = false;
            continue;
        }
        if in_string {
            if ch == '\\' {
                escape = true;
                out.push(ch);
            } else if ch == '"' {
                in_string = false;
                out.push(ch);
            } else if ch == '\n' {
                out.push_str("\\n");
            } else if ch == '\r' {
                out.push_str("\\r");
            } else if ch == '\t' {
                out.push_str("\\t");
            } else if ch.is_control() {
                use std::fmt::Write;
                let _ = write!(out, "\\u{:04x}", ch as u32);
            } else {
                out.push(ch);
            }
        } else if ch == '"' {
            in_string = true;
            out.push(ch);
        } else {
            out.push(ch);
        }
    }
    out
}

fn parse_fabric_mod_json(content: &str, file_name: &str) -> Result<ModInfo, String> {
    let json: JsonValue = parse_fabric_mod_json_value(content)?;
    let mod_id = json
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| file_name.to_lowercase().replace(".jar", ""));
    let name = json
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| mod_id.clone());
    let version = json
        .get("version")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let description = json
        .get("description")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let mut authors: Vec<String> = Vec::new();
    if let Some(author_str) = json.get("authors").and_then(|v| v.as_str()) {
        authors.push(author_str.to_string());
    } else if let Some(arr) = json.get("authors").and_then(|v| v.as_array()) {
        for a in arr {
            if let Some(s) = a.as_str() {
                authors.push(s.to_string());
            } else if let Some(obj) = a.as_object() {
                if let Some(s) = obj.get("name").and_then(|v| v.as_str()) {
                    authors.push(s.to_string());
                }
            }
        }
    }
    let license = json
        .get("license")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());
    let icon = json
        .get("icon")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());
    let contact = json.get("contact").and_then(|v| v.as_object());
    let homepage = json
        .get("homepage")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            contact
                .and_then(|c| c.get("homepage"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty())
        });
    let source = json
        .get("sources")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            contact
                .and_then(|c| c.get("sources"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty())
        });
    let issues = contact
        .and_then(|c| c.get("issues"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());
    let mod_loader = json
        .get("environment")
        .and_then(|v| v.as_str())
        .map(|s| {
            let env = match s {
                "client" => "客户端",
                "server" => "服务端",
                _ => "任意",
            };
            format!("Fabric ({})", env)
        })
        .or_else(|| Some("Fabric".to_string()));
    let mut dependencies: Vec<ModDependency> = Vec::new();
    let mut optional_dependencies: Vec<ModDependency> = Vec::new();
    if let Some(dep_obj) = json.get("depends").and_then(|v| v.as_object()) {
        for (dep_mod_id, version_val) in dep_obj {
            if is_platform_dep(dep_mod_id) {
                continue;
            }
            let version_range = version_val
                .as_str()
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty() && s != "*")
                .map(|s| simplify_version_range(&s));
            dependencies.push(ModDependency {
                mod_id: dep_mod_id.clone(),
                version_range,
                mandatory: true,
                ordering: None,
                side: None,
            });
        }
    }
    if let Some(rec_obj) = json.get("recommends").and_then(|v| v.as_object()) {
        for (dep_mod_id, version_val) in rec_obj {
            if is_platform_dep(dep_mod_id) {
                continue;
            }
            let version_range = version_val
                .as_str()
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty() && s != "*")
                .map(|s| simplify_version_range(&s));
            optional_dependencies.push(ModDependency {
                mod_id: dep_mod_id.clone(),
                version_range,
                mandatory: false,
                ordering: None,
                side: None,
            });
        }
    }
    if let Some(rec_obj) = json.get("suggests").and_then(|v| v.as_object()) {
        for (dep_mod_id, version_val) in rec_obj {
            if is_platform_dep(dep_mod_id) {
                continue;
            }
            let version_range = version_val
                .as_str()
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty() && s != "*")
                .map(|s| simplify_version_range(&s));
            optional_dependencies.push(ModDependency {
                mod_id: dep_mod_id.clone(),
                version_range,
                mandatory: false,
                ordering: None,
                side: None,
            });
        }
    }
    Ok(ModInfo {
        file_name: file_name.to_string(),
        mod_id,
        name,
        version,
        description,
        authors,
        license,
        icon,
        source,
        homepage,
        issues,
        minecraft_version: None,
        mod_loader,
        dependencies,
        optional_dependencies,
        incompatible_dependencies: Vec::new(),
    })
}
fn parse_mcmod_info(content: &str, file_name: &str) -> Result<ModInfo, String> {
    let json: JsonValue =
        serde_json::from_str(content).map_err(|e| format!("解析 JSON 失败: {}", e))?;
    let mods = json
        .as_array()
        .or_else(|| json.get("modList").and_then(|v| v.as_array()))
        .ok_or_else(|| "mcmod.info 格式不正确".to_string())?;
    let mod_entry = mods
        .first()
        .and_then(|v| v.as_object())
        .ok_or_else(|| "mcmod.info 无有效条目".to_string())?;
    let mod_id = mod_entry
        .get("modid")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| file_name.to_lowercase().replace(".jar", ""));
    let name = mod_entry
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| mod_id.clone());
    let version = mod_entry
        .get("version")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let description = mod_entry
        .get("description")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let mut authors: Vec<String> = Vec::new();
    if let Some(arr) = mod_entry.get("authorList").and_then(|v| v.as_array()) {
        for a in arr {
            if let Some(s) = a.as_str() {
                authors.push(s.to_string());
            }
        }
    } else if let Some(arr) = mod_entry.get("authors").and_then(|v| v.as_array()) {
        for a in arr {
            if let Some(s) = a.as_str() {
                authors.push(s.to_string());
            }
        }
    } else if let Some(s) = mod_entry.get("authors").and_then(|v| v.as_str()) {
        authors.push(s.to_string());
    } else if let Some(s) = mod_entry.get("author").and_then(|v| v.as_str()) {
        authors.push(s.to_string());
    }
    let mc_version = mod_entry
        .get("mcversion")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());
    let url = mod_entry
        .get("url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());
    let icon = mod_entry
        .get("logoFile")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());
    Ok(ModInfo {
        file_name: file_name.to_string(),
        mod_id,
        name,
        version,
        description,
        authors,
        license: None,
        icon,
        source: None,
        homepage: url,
        issues: None,
        minecraft_version: mc_version,
        mod_loader: Some("Forge (旧版)".to_string()),
        dependencies: Vec::new(),
        optional_dependencies: Vec::new(),
        incompatible_dependencies: Vec::new(),
    })
}
fn parse_toml(content: &str) -> HashMap<String, JsonValue> {
    let mut result: HashMap<String, JsonValue> = HashMap::new();
    let mut arrays: HashMap<String, Vec<JsonValue>> = HashMap::new();
    let mut current_table: String = String::new();
    let mut current_array: String = String::new();
    let mut current_obj: Option<HashMap<String, JsonValue>> = None;
    let mut multiline_buffer: Option<(String, String)> = None;
    let mut multiline_end_marker: Option<String> = None;
    for line in content.lines() {
        if let Some((key, ref mut buf)) = multiline_buffer.as_mut() {
            let line_trimmed = line.trim();
            if let Some(end_marker) = &multiline_end_marker {
                if line_trimmed.ends_with(end_marker) {
                    let end_idx = line_trimmed.len() - end_marker.len();
                    let remaining = &line_trimmed[..end_idx];
                    if !buf.is_empty() && !buf.ends_with('\n') {
                        buf.push('\n');
                    }
                    buf.push_str(remaining);
                    let final_value = buf.trim().to_string();
                    let value_obj = JsonValue::String(final_value);
                    let key_owned = key.clone();
                    if !current_array.is_empty() && current_obj.is_some() {
                        current_obj.as_mut().unwrap().insert(key_owned, value_obj);
                    } else if !current_table.is_empty() {
                        let entry = result
                            .entry(current_table.clone())
                            .or_insert_with(|| JsonValue::Object(serde_json::Map::new()));
                        if let Some(obj) = entry.as_object_mut() {
                            obj.insert(key_owned, value_obj);
                        }
                    } else {
                        result.insert(key_owned, value_obj);
                    }
                    multiline_buffer = None;
                    multiline_end_marker = None;
                    continue;
                }
            }
            if !buf.is_empty() {
                buf.push('\n');
            }
            buf.push_str(line);
            continue;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if trimmed.starts_with("[[") && trimmed.ends_with("]]") {
            if let Some(obj) = current_obj.take() {
                arrays
                    .entry(current_array.clone())
                    .or_insert_with(Vec::new)
                    .push(JsonValue::Object(serde_json::Map::from_iter(
                        obj.into_iter().collect::<Vec<_>>(),
                    )));
            }
            current_array = trimmed[2..trimmed.len() - 2].to_string();
            current_table = String::new();
            current_obj = Some(HashMap::new());
            continue;
        }
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            if let Some(obj) = current_obj.take() {
                arrays
                    .entry(current_array.clone())
                    .or_insert_with(Vec::new)
                    .push(JsonValue::Object(serde_json::Map::from_iter(
                        obj.into_iter().collect::<Vec<_>>(),
                    )));
            }
            current_table = trimmed[1..trimmed.len() - 1].to_string();
            current_array = String::new();
            current_obj = None;
            continue;
        }
        if let Some(eq_pos) = trimmed.find('=') {
            let key = trimmed[..eq_pos].trim().to_string();
            let raw_value = trimmed[eq_pos + 1..].trim();
            if raw_value.starts_with("\"\"\"") {
                let rest = &raw_value[3..];
                if rest.ends_with("\"\"\"") && rest.len() >= 3 {
                    let inner = &rest[..rest.len() - 3];
                    let value = JsonValue::String(inner.trim().to_string());
                    insert_toml_value(
                        &mut result,
                        &mut current_table,
                        &mut current_array,
                        &mut current_obj,
                        key,
                        value,
                    );
                } else {
                    multiline_buffer = Some((key, rest.to_string()));
                    multiline_end_marker = Some("\"\"\"".to_string());
                }
                continue;
            }
            if raw_value.starts_with("'''") {
                let rest = &raw_value[3..];
                if rest.ends_with("'''") && rest.len() >= 3 {
                    let inner = &rest[..rest.len() - 3];
                    let value = JsonValue::String(inner.trim().to_string());
                    insert_toml_value(
                        &mut result,
                        &mut current_table,
                        &mut current_array,
                        &mut current_obj,
                        key,
                        value,
                    );
                } else {
                    multiline_buffer = Some((key, rest.to_string()));
                    multiline_end_marker = Some("'''".to_string());
                }
                continue;
            }
            let value = parse_toml_value(raw_value);
            insert_toml_value(
                &mut result,
                &mut current_table,
                &mut current_array,
                &mut current_obj,
                key,
                value,
            );
        }
    }
    if let Some((key, buf)) = multiline_buffer.take() {
        let value = JsonValue::String(buf.trim().to_string());
        if !current_array.is_empty() && current_obj.is_some() {
            current_obj.as_mut().unwrap().insert(key, value);
        } else if !current_table.is_empty() {
            let entry = result
                .entry(current_table.clone())
                .or_insert_with(|| JsonValue::Object(serde_json::Map::new()));
            if let Some(obj) = entry.as_object_mut() {
                obj.insert(key, value);
            }
        } else {
            result.insert(key, value);
        }
    }
    if let Some(obj) = current_obj.take() {
        arrays
            .entry(current_array.clone())
            .or_insert_with(Vec::new)
            .push(JsonValue::Object(serde_json::Map::from_iter(
                obj.into_iter().collect::<Vec<_>>(),
            )));
    }
    for (k, v) in arrays {
        result.insert(k, JsonValue::Array(v));
    }
    result
}
fn insert_toml_value(
    result: &mut HashMap<String, JsonValue>,
    current_table: &mut String,
    current_array: &mut String,
    current_obj: &mut Option<HashMap<String, JsonValue>>,
    key: String,
    value: JsonValue,
) {
    if !current_array.is_empty() && current_obj.is_some() {
        current_obj.as_mut().unwrap().insert(key, value);
    } else if !current_table.is_empty() {
        let entry = result
            .entry(current_table.clone())
            .or_insert_with(|| JsonValue::Object(serde_json::Map::new()));
        if let Some(obj) = entry.as_object_mut() {
            obj.insert(key, value);
        }
    } else {
        result.insert(key, value);
    }
}
fn parse_toml_value(raw: &str) -> JsonValue {
    let s = raw.trim();
    if s.starts_with('"') && s.ends_with('"') && s.len() >= 2 {
        return JsonValue::String(s[1..s.len() - 1].to_string());
    }
    if s.starts_with('\'') && s.ends_with('\'') && s.len() >= 2 {
        return JsonValue::String(s[1..s.len() - 1].to_string());
    }
    if s == "true" {
        return JsonValue::Bool(true);
    }
    if s == "false" {
        return JsonValue::Bool(false);
    }
    if let Ok(num) = s.parse::<i64>() {
        return JsonValue::Number(serde_json::Number::from(num));
    }
    if let Ok(num) = s.parse::<f64>() {
        if let Some(n) = serde_json::Number::from_f64(num) {
            return JsonValue::Number(n);
        }
    }
    JsonValue::String(s.to_string())
}
pub fn parse_mods_batch(paths: Vec<String>) -> Vec<(String, Option<ModInfo>)> {
    use rayon::prelude::*;
    let results: Vec<(String, Option<ModInfo>)> = paths
        .par_iter()
        .map(|path_str| {
            let path_buf: PathBuf = PathBuf::from(path_str);
            let result = parse_mod_file(&path_buf);
            match result {
                Ok(info) => (path_str.clone(), Some(info)),
                Err(_) => (path_str.clone(), None),
            }
        })
        .collect();
    results
}
pub fn parse_mods_in_directory(dir_path: &str) -> Vec<ModInfo> {
    let mut jar_files: Vec<String> = Vec::new();
    if let Ok(entries) = fs::read_dir(dir_path) {
        for entry in entries.flatten() {
            if let Ok(file_type) = entry.file_type() {
                if file_type.is_file() {
                    let path = entry.path();
                    if path
                        .extension()
                        .and_then(|e| e.to_str())
                        .map(|e| e.to_lowercase() == "jar")
                        .unwrap_or(false)
                    {
                        if let Some(path_str) = path.to_str() {
                            jar_files.push(path_str.to_string());
                        }
                    }
                }
            }
        }
    }
    let results = parse_mods_batch(jar_files);
    results.into_iter().filter_map(|(_, info)| info).collect()
}
#[tauri::command]
pub fn parse_mod(path: String) -> Result<ModInfo, String> {
    parse_mod_file(Path::new(&path))
}
#[tauri::command]
pub fn parse_mods(files: Vec<String>) -> Vec<(String, Option<ModInfo>)> {
    parse_mods_batch(files)
}
#[tauri::command]
pub fn parse_mods_in_dir(dir_path: String) -> Vec<ModInfo> {
    parse_mods_in_directory(&dir_path)
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IncompatibleModEntry {
    pub mod_id: String,
    pub version_range: Option<String>,
    pub source_mod: String,
}
#[tauri::command]
pub fn save_incompatible_mods(game_folder: String, infos: Vec<ModInfo>) -> Result<String, String> {
    let mut entries: Vec<IncompatibleModEntry> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for info in infos {
        for dep in info.incompatible_dependencies {
            if !seen.contains(&dep.mod_id) {
                seen.insert(dep.mod_id.clone());
                entries.push(IncompatibleModEntry {
                    mod_id: dep.mod_id,
                    version_range: dep.version_range,
                    source_mod: info.mod_id.clone(),
                });
            }
        }
    }
    let json_str =
        serde_json::to_string_pretty(&entries).map_err(|e| format!("序列化失败: {}", e))?;
    let file_path = PathBuf::from(format!(
        "versions{}{}{}incompatible_mods.json",
        std::path::MAIN_SEPARATOR,
        game_folder,
        std::path::MAIN_SEPARATOR
    ));
    if let Some(parent) = file_path.parent() {
        if !parent.exists() {
            if let Err(e) = fs::create_dir_all(parent) {
                return Err(format!("创建目录失败: {}", e));
            }
        }
    }
    fs::write(&file_path, json_str).map_err(|e| format!("写入文件失败: {}", e))?;
    Ok(format!(
        "已保存 {} 个不兼容模组到 {}",
        entries.len(),
        file_path.display()
    ))
}
