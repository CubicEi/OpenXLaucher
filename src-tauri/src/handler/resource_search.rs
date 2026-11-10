//! Aggregated English / cross-platform resource search and link-site catalog.

use crate::handler::mod_links::{search_curseforge_projects, search_modrinth_projects};
use crate::http_client::{get_with_retry, shared_client, RetryConfig};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

const RESOURCE_SOURCES_JSON: &str = include_str!("../../resources/resource_sources.json");

#[derive(Debug, Clone, Deserialize)]
struct ResourceSourceRow {
    id: String,
    name_zh: String,
    name_en: String,
    url: String,
    resource_kinds: Vec<String>,
    mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnglishSearchHit {
    pub title: String,
    pub slug: String,
    pub description: Option<String>,
    pub icon_url: Option<String>,
    pub source: String,
    pub project_type: String,
    pub downloads: Option<u64>,
    pub categories: Vec<String>,
    pub mc_versions: Vec<String>,
    pub updated: Option<String>,
    pub author: Option<String>,
    pub external_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schematic_uuid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schematic_file_type: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCount {
    pub ok: bool,
    pub count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnglishSearchResponse {
    pub results: Vec<EnglishSearchHit>,
    pub sources: EnglishSearchSources,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnglishSearchSources {
    pub modrinth: SourceCount,
    pub curseforge: SourceCount,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modpackindex: Option<SourceCount>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcschematic: Option<SourceCount>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceLinkSite {
    pub id: String,
    pub name_zh: String,
    pub name_en: String,
    pub url: String,
}

fn parse_sources_catalog() -> Result<Vec<ResourceSourceRow>, String> {
    #[derive(Deserialize)]
    struct Raw {
        id: String,
        #[serde(rename = "nameZh")]
        name_zh: String,
        #[serde(rename = "nameEn")]
        name_en: String,
        url: String,
        #[serde(rename = "resourceKinds")]
        resource_kinds: Vec<String>,
        mode: String,
    }
    let raw: Vec<Raw> =
        serde_json::from_str(RESOURCE_SOURCES_JSON).map_err(|e| format!("解析资源站目录失败: {}", e))?;
    Ok(raw
        .into_iter()
        .map(|r| ResourceSourceRow {
            id: r.id,
            name_zh: r.name_zh,
            name_en: r.name_en,
            url: r.url,
            resource_kinds: r.resource_kinds,
            mode: r.mode,
        })
        .collect())
}

fn modrinth_type_for_category(category: &str) -> Option<String> {
    match category {
        "mod" => Some("mod".to_string()),
        "modpack" => Some("modpack".to_string()),
        "resourcepack" => Some("resourcepack".to_string()),
        "shaders" => Some("shader".to_string()),
        "datapack" => Some("datapack".to_string()),
        "worlds" => Some("world".to_string()),
        "schematic" => None,
        _ => None,
    }
}

fn result_project_type(category: &str) -> &str {
    match category {
        "modpack" => "modpack",
        "resourcepack" => "resourcepack",
        "shaders" => "shaderpack",
        "datapack" => "datapack",
        "worlds" => "world",
        "schematic" => "schematic",
        _ => "mod",
    }
}

fn cf_path(class_id: Option<i64>, slug: &str) -> String {
    match class_id {
        Some(6) => format!("https://www.curseforge.com/minecraft/mc-mods/{slug}"),
        Some(4471) | Some(4473) => format!("https://www.curseforge.com/minecraft/modpacks/{slug}"),
        Some(12) => format!("https://www.curseforge.com/minecraft/texture-packs/{slug}"),
        Some(6552) => format!("https://www.curseforge.com/minecraft/shaders/{slug}"),
        Some(6945) | Some(6949) => format!("https://www.curseforge.com/minecraft/data-packs/{slug}"),
        Some(17) => format!("https://www.curseforge.com/minecraft/worlds/{slug}"),
        _ => format!("https://www.curseforge.com/minecraft/mc-mods/{slug}"),
    }
}

async fn search_modpack_index(query: &str, browse: bool, limit: u32) -> Result<Vec<EnglishSearchHit>, String> {
    let client = shared_client().await;
    let limit = limit.clamp(1, 50);
    let mut url = format!(
        "https://www.modpackindex.com/api/v1/modpacks?limit={}",
        limit
    );
    if browse {
        url.push_str("&sort=-download_count");
    } else {
        url.push_str(&format!("&q={}", urlencoding::encode(query)));
    }
    let response = get_with_retry(
        &client,
        &url,
        Some(RetryConfig {
            max_retries: 2,
            initial_delay_ms: 400,
            max_delay_ms: 2000,
        }),
    )
    .await
    .map_err(|e| format!("Modpack Index 请求失败: {}", e))?;
    if !response.status().is_success() {
        return Err(format!("Modpack Index HTTP {}", response.status()));
    }
    let json: Value = response
        .json()
        .await
        .map_err(|e| format!("Modpack Index JSON: {}", e))?;
    let items = json
        .get("data")
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for item in items {
        let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        let slug = item
            .get("slug")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let summary = item
            .get("summary")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let downloads = item.get("download_count").and_then(|v| v.as_u64());
        let thumb = item
            .get("thumbnail_url")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let page_url = item
            .get("page_url")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let updated = item
            .get("last_updated")
            .or_else(|| item.get("last_modified"))
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let mut detail_slug = slug.clone();
        let mut external = page_url.clone();
        if let Some(mr) = item.get("modrinth_info") {
            if let Some(s) = mr.get("slug").and_then(|v| v.as_str()) {
                detail_slug = s.to_string();
                external = mr.get("url").and_then(|v| v.as_str()).map(str::to_string);
            }
        } else if let Some(url) = item.get("url").and_then(|v| v.as_str()) {
            external = Some(url.to_string());
        }
        let mc_versions: Vec<String> = item
            .get("minecraft_versions")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.get("name").and_then(|n| n.as_str()))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        out.push(EnglishSearchHit {
            title: name,
            slug: detail_slug,
            description: summary,
            icon_url: thumb,
            source: "modpackindex".to_string(),
            project_type: "modpack".to_string(),
            downloads,
            categories: vec![],
            mc_versions,
            updated,
            author: None,
            external_url: external.or(page_url),
            schematic_uuid: None,
            schematic_file_type: None,
        });
    }
    Ok(out)
}

/// Skip Bedrock-primary schematic formats (e.g. mcstructure).
fn mcschematic_java_type(file_type: i64) -> bool {
    matches!(file_type, 0 | 1 | 2 | 3)
}

async fn search_mcschematic(query: &str, browse: bool, limit: u32) -> Result<Vec<EnglishSearchHit>, String> {
    let client = shared_client().await;
    let page_size = 15usize;
    let limit = limit.clamp(1, 50) as usize;
    let heat = if browse || query.is_empty() { "true" } else { "false" };
    let filter = if query.is_empty() { "" } else { query };
    let url = format!(
        "https://www.mcschematic.top/api/schematics?begin=0&filter={}&heatSort={}&type=0&t={}",
        urlencoding::encode(filter),
        heat,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let response = get_with_retry(
        &client,
        &url,
        Some(RetryConfig {
            max_retries: 2,
            initial_delay_ms: 400,
            max_delay_ms: 2000,
        }),
    )
    .await
    .map_err(|e| format!("mcschematic 请求失败: {}", e))?;
    if !response.status().is_success() {
        return Err(format!("mcschematic HTTP {}", response.status()));
    }
    let items: Vec<Value> = response
        .json()
        .await
        .map_err(|e| format!("mcschematic JSON: {}", e))?;
    let mut out = Vec::new();
    for item in items.into_iter().take(limit.min(page_size)) {
        let file_type = item.get("type").and_then(|v| v.as_i64()).unwrap_or(-1);
        if !mcschematic_java_type(file_type) {
            continue;
        }
        let uuid = item
            .get("uuid")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if uuid.is_empty() {
            continue;
        }
        let name = item
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or(&uuid)
            .to_string();
        let desc = item
            .get("description")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let heat = item.get("heat").and_then(|v| v.as_u64());
        let author = item
            .get("nickName")
            .or_else(|| item.get("author"))
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let updated = item
            .get("updateTime")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let avatar = item
            .get("avatarUrl")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        out.push(EnglishSearchHit {
            title: name,
            slug: uuid.clone(),
            description: desc,
            icon_url: avatar,
            source: "mcschematic".to_string(),
            project_type: "schematic".to_string(),
            downloads: heat,
            categories: vec![],
            mc_versions: vec![],
            updated,
            author,
            external_url: Some(format!("https://www.mcschematic.top/schematic/{}", uuid)),
            schematic_uuid: Some(uuid),
            schematic_file_type: Some(file_type as u32),
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn list_resource_link_sites(category: String) -> Result<String, String> {
    let cat = category.trim().to_ascii_lowercase();
    let catalog = parse_sources_catalog()?;
    let sites: Vec<ResourceLinkSite> = catalog
        .into_iter()
        .filter(|row| row.mode == "link_only" && row.resource_kinds.iter().any(|k| k == &cat))
        .map(|row| ResourceLinkSite {
            id: row.id,
            name_zh: row.name_zh,
            name_en: row.name_en,
            url: row.url,
        })
        .collect();
    serde_json::to_string(&sites).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn search_english_resources(
    query: String,
    category: String,
    limit: Option<u32>,
) -> Result<String, String> {
    let query = query.trim().to_string();
    let browse = query.is_empty();
    let category = category.trim().to_ascii_lowercase();
    let limit = limit.unwrap_or(25);

    let mut results: Vec<EnglishSearchHit> = Vec::new();
    let mut seen = HashSet::<String>::new();

    let mut modrinth_count = 0u32;
    let mut cf_count = 0u32;
    let mut mpi_count = 0u32;
    let mut mcs_count = 0u32;
    let mut modrinth_ok = false;
    let mut cf_ok = false;
    let mut mpi_ok = false;
    let mut mcs_ok = false;

    if category == "schematic" {
        match search_mcschematic(&query, browse, limit).await {
            Ok(hits) => {
                mcs_ok = true;
                mcs_count = hits.len() as u32;
                for hit in hits {
                    let key = format!("mcschematic:{}", hit.slug);
                    if seen.insert(key) {
                        results.push(hit);
                    }
                }
            }
            Err(e) => {
                eprintln!("[resource_search] mcschematic: {}", e);
            }
        }
    } else {
        let browse_cf_worlds = browse && category == "worlds";

        if let Some(mr_type) = modrinth_type_for_category(&category) {
            if !browse_cf_worlds {
            match search_modrinth_projects(query.clone(), Some(mr_type), Some(limit)).await {
                Ok(text) => {
                    modrinth_ok = true;
                    if let Ok(json) = serde_json::from_str::<Value>(&text) {
                        if let Some(hits) = json.get("hits").and_then(|h| h.as_array()) {
                            modrinth_count = hits.len() as u32;
                            for hit in hits {
                                let slug = hit
                                    .get("slug")
                                    .or_else(|| hit.get("project_id"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                if slug.is_empty() || !seen.insert(format!("mr:{slug}")) {
                                    continue;
                                }
                                let pt = hit
                                    .get("project_type")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or(result_project_type(&category));
                                results.push(EnglishSearchHit {
                                    title: hit
                                        .get("title")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or(&slug)
                                        .to_string(),
                                    slug: slug.clone(),
                                    description: hit
                                        .get("description")
                                        .and_then(|v| v.as_str())
                                        .map(str::to_string),
                                    icon_url: hit
                                        .get("icon_url")
                                        .and_then(|v| v.as_str())
                                        .map(str::to_string),
                                    source: "modrinth".to_string(),
                                    project_type: pt.to_string(),
                                    downloads: hit.get("downloads").and_then(|v| v.as_u64()),
                                    categories: hit
                                        .get("categories")
                                        .and_then(|v| v.as_array())
                                        .map(|a| {
                                            a.iter()
                                                .filter_map(|x| x.as_str().map(str::to_string))
                                                .collect()
                                        })
                                        .unwrap_or_default(),
                                    mc_versions: hit
                                        .get("game_versions")
                                        .or_else(|| hit.get("versions"))
                                        .and_then(|v| v.as_array())
                                        .map(|a| {
                                            a.iter()
                                                .filter_map(|x| x.as_str().map(str::to_string))
                                                .collect()
                                        })
                                        .unwrap_or_default(),
                                    updated: hit
                                        .get("date_modified")
                                        .or_else(|| hit.get("date_updated"))
                                        .and_then(|v| v.as_str())
                                        .map(str::to_string),
                                    author: hit
                                        .get("author")
                                        .and_then(|v| v.as_str())
                                        .map(str::to_string),
                                    external_url: Some(format!(
                                        "https://modrinth.com/{}/{}",
                                        pt, slug
                                    )),
                                    schematic_uuid: None,
                                    schematic_file_type: None,
                                });
                            }
                        }
                    }
                }
                Err(e) => eprintln!("[resource_search] modrinth: {}", e),
            }
            }
        }

        if !browse || browse_cf_worlds {
            match search_curseforge_projects(query.clone(), category.clone(), Some(50)).await {
                Ok(text) => {
                    cf_ok = true;
                    if let Ok(json) = serde_json::from_str::<Value>(&text) {
                        let items = json.get("data").and_then(|d| d.as_array()).cloned().unwrap_or_default();
                        cf_count = items.len() as u32;
                        let pt = result_project_type(&category);
                        for item in items {
                            let slug = item
                                .get("slug")
                                .and_then(|v| v.as_str().map(str::to_string))
                                .or_else(|| {
                                    item.get("id")
                                        .and_then(|v| v.as_i64())
                                        .map(|id| id.to_string())
                                })
                                .unwrap_or_default();
                            if slug.is_empty() {
                                continue;
                            }
                            if seen.contains(&format!("mr:{slug}")) {
                                if let Some(existing) =
                                    results.iter_mut().find(|r| r.slug == slug && r.source == "modrinth")
                                {
                                    existing.source = "both".to_string();
                                }
                                continue;
                            }
                            if !seen.insert(format!("cf:{slug}")) {
                                continue;
                            }
                            let class_id = item.get("classId").and_then(|v| v.as_i64());
                            let slug_for_url = slug.clone();
                            results.push(EnglishSearchHit {
                                title: item
                                    .get("name")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or(&slug)
                                    .to_string(),
                                slug,
                                description: item
                                    .get("summary")
                                    .and_then(|v| v.as_str())
                                    .map(str::to_string),
                                icon_url: item
                                    .get("logo")
                                    .and_then(|l| {
                                        l.get("thumbnailUrl")
                                            .or_else(|| l.get("url"))
                                            .and_then(|v| v.as_str())
                                    })
                                    .map(str::to_string),
                                source: "curseforge".to_string(),
                                project_type: pt.to_string(),
                                downloads: item.get("downloadCount").and_then(|v| v.as_u64()),
                                categories: vec![],
                                mc_versions: item
                                    .get("latestFilesIndexes")
                                    .and_then(|v| v.as_array())
                                    .map(|arr| {
                                        arr.iter()
                                            .filter_map(|f| f.get("gameVersion").and_then(|v| v.as_str()))
                                            .map(str::to_string)
                                            .collect()
                                    })
                                    .unwrap_or_default(),
                                updated: item
                                    .get("dateModified")
                                    .or_else(|| item.get("dateReleased"))
                                    .and_then(|v| v.as_str())
                                    .map(str::to_string),
                                author: item
                                    .get("authors")
                                    .and_then(|v| v.as_array())
                                    .map(|a| {
                                        a.iter()
                                            .filter_map(|x| x.get("name").and_then(|n| n.as_str()))
                                            .collect::<Vec<_>>()
                                            .join(", ")
                                    }),
                                external_url: {
                                    let mut links: Vec<String> = vec![];
                                    if let Some(site) = item.get("links").and_then(|l| l.get("websiteUrl")).and_then(|v| v.as_str()) {
                                        links.push(site.to_string());
                                    }
                                    Some(links.first().cloned().unwrap_or_else(|| cf_path(class_id, &slug_for_url)))
                                },
                                schematic_uuid: None,
                                schematic_file_type: None,
                            });
                        }
                    }
                }
                Err(e) => eprintln!("[resource_search] curseforge: {}", e),
            }
        }

        if category == "modpack" {
            match search_modpack_index(&query, browse, limit).await {
                Ok(hits) => {
                    mpi_ok = true;
                    mpi_count = hits.len() as u32;
                    for hit in hits {
                        let key = format!("mpi:{}", hit.slug);
                        if seen.insert(key) {
                            results.push(hit);
                        }
                    }
                }
                Err(e) => eprintln!("[resource_search] modpackindex: {}", e),
            }
        }
    }

    results.sort_by(|a, b| b.downloads.unwrap_or(0).cmp(&a.downloads.unwrap_or(0)));

    let resp = EnglishSearchResponse {
        results,
        sources: EnglishSearchSources {
            modrinth: SourceCount {
                ok: modrinth_ok,
                count: modrinth_count,
                error: if modrinth_ok { None } else { Some("No data".into()) },
            },
            curseforge: SourceCount {
                ok: if browse && category == "worlds" {
                    cf_ok
                } else if browse && category != "schematic" {
                    true
                } else {
                    cf_ok
                },
                count: if browse && category == "worlds" {
                    cf_count
                } else if browse {
                    0
                } else {
                    cf_count
                },
                error: None,
            },
            modpackindex: if category == "modpack" {
                Some(SourceCount {
                    ok: mpi_ok,
                    count: mpi_count,
                    error: if mpi_ok { None } else { Some("No data".into()) },
                })
            } else {
                None
            },
            mcschematic: if category == "schematic" {
                Some(SourceCount {
                    ok: mcs_ok,
                    count: mcs_count,
                    error: if mcs_ok { None } else { Some("No data".into()) },
                })
            } else {
                None
            },
        },
    };

    serde_json::to_string(&resp).map_err(|e| e.to_string())
}

fn mcschematic_file_ext(file_type: u32) -> Option<&'static str> {
    match file_type {
        0 => Some("nbt"),
        1 => Some("litematic"),
        2 => Some("json"),
        3 => Some("schem"),
        _ => None,
    }
}

/// Download a Java schematic from mcschematic.top into `game_dir/schematics/`.
#[tauri::command]
pub async fn download_mcschematic_file(
    uuid: String,
    schematic_file_type: u32,
    game_dir: String,
) -> Result<String, String> {
    let uuid = uuid.trim();
    if uuid.is_empty() {
        return Err("uuid 不能为空".to_string());
    }
    let ext = mcschematic_file_ext(schematic_file_type)
        .ok_or_else(|| "不支持的原理图格式（已跳过基岩版）".to_string())?;
    let game_dir = game_dir.trim();
    if game_dir.is_empty() {
        return Err("游戏目录不能为空".to_string());
    }
    let dest_dir = std::path::PathBuf::from(game_dir).join("schematics");
    std::fs::create_dir_all(&dest_dir).map_err(|e| format!("创建 schematics 目录失败: {}", e))?;

    let url = format!(
        "https://www.mcschematic.top/api/schematicFile?uuid={}",
        urlencoding::encode(uuid)
    );
    let client = shared_client().await;
    let response = get_with_retry(
        &client,
        &url,
        Some(RetryConfig {
            max_retries: 2,
            initial_delay_ms: 500,
            max_delay_ms: 3000,
        }),
    )
    .await
    .map_err(|e| format!("下载失败: {}", e))?;
    if !response.status().is_success() {
        return Err(format!("下载 HTTP {}", response.status()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取文件失败: {}", e))?;
    let file_name = format!("{uuid}.{ext}");
    let path = dest_dir.join(&file_name);
    std::fs::write(&path, &bytes).map_err(|e| format!("写入失败: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}
