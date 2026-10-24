//! Resolve cache `resourceKind` for downloads from file extension + browse context.

use crate::handler::cache_paths::CacheResourceKind;

fn file_extension_lower(file_name: &str) -> Option<String> {
    let name = file_name.trim();
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let dot = base.rfind('.')?;
    if dot + 1 >= base.len() {
        return None;
    }
    Some(base[dot + 1..].to_ascii_lowercase())
}

fn browse_category_to_kind(category: &str) -> Option<&'static str> {
    match category.trim().to_ascii_lowercase().as_str() {
        "mod" | "mods" => Some("mod"),
        "resourcepack" | "resourcepacks" => Some("resourcepack"),
        "shaders" | "shader" | "shaderpack" | "shaderpacks" => Some("shaderpack"),
        "datapack" | "datapacks" | "data pack" | "data-pack" => Some("datapack"),
        "modpack" | "modpacks" => Some("modpack"),
        "world" | "worlds" => Some("world"),
        _ => None,
    }
}

fn api_project_type_to_kind(project_type: &str) -> Option<&'static str> {
    let pt = project_type.trim().to_ascii_lowercase();
    if pt.is_empty() || pt == "mod" || pt == "minecraft" {
        return None;
    }
    if pt.contains("resourcepack") || pt.contains("resource pack") || pt.contains("texture") {
        return Some("resourcepack");
    }
    if pt.contains("shader") {
        return Some("shaderpack");
    }
    if pt.contains("datapack") || pt.contains("data pack") || pt.contains("data-pack") {
        return Some("datapack");
    }
    if pt.contains("modpack") || pt.contains("mod pack") {
        return Some("modpack");
    }
    if pt.contains("world") || pt.contains("map") {
        return Some("world");
    }
    None
}

/// Pick download cache kind from filename, UI browse category, and API project metadata.
pub fn resolve_resource_kind_for_download(
    file_name: &str,
    hint_kind: Option<&str>,
    browse_category: Option<&str>,
    api_project_type: Option<&str>,
) -> String {
    let ext = file_extension_lower(file_name);
    if matches!(ext.as_deref(), Some("jar") | Some("litemod")) {
        return "mod".to_string();
    }

    if let Some(cat) = browse_category.and_then(browse_category_to_kind) {
        if cat != "mod" {
            return cat.to_string();
        }
    }

    if let Some(force) = hint_kind.and_then(browse_category_to_kind) {
        if force != "mod" {
            return force.to_string();
        }
    }

    if let Some(api) = api_project_type.and_then(api_project_type_to_kind) {
        return api.to_string();
    }

    if let Some(h) = hint_kind.and_then(browse_category_to_kind) {
        return h.to_string();
    }

    // Non-jar archives default to datapack only when API/hint said mod (zip on mod page stays mod
    // is wrong — zip never goes to mod cache).
    if matches!(ext.as_deref(), Some("zip") | Some("rar") | Some("7z")) {
        return "resourcepack".to_string();
    }

    "mod".to_string()
}

pub fn cache_kind_to_wire(kind: CacheResourceKind) -> &'static str {
    match kind {
        CacheResourceKind::Mod => "mod",
        CacheResourceKind::ResourcePack => "resourcepack",
        CacheResourceKind::DataPack => "datapack",
        CacheResourceKind::World => "world",
        CacheResourceKind::ShaderPack => "shaderpack",
        CacheResourceKind::Modpack => "modpack",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jar_datapack_metadata_goes_mod() {
        assert_eq!(
            resolve_resource_kind_for_download(
                "pack.jar",
                Some("datapack"),
                Some("datapack"),
                Some("datapack"),
            ),
            "mod"
        );
    }

    #[test]
    fn zip_datapack_category_not_mod() {
        assert_eq!(
            resolve_resource_kind_for_download(
                "pack.zip",
                Some("mod"),
                Some("datapack"),
                Some("mod"),
            ),
            "datapack"
        );
    }

    #[test]
    fn zip_resourcepack_category_over_modpack_api() {
        assert_eq!(
            resolve_resource_kind_for_download(
                "textures.zip",
                Some("modpack"),
                Some("resourcepack"),
                Some("modpack"),
            ),
            "resourcepack"
        );
    }
}
