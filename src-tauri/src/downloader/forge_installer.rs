use crate::downloader::concurrent_download;
use crate::downloader::mod_loader_installer_shared as shared;
use crate::http_client::shared_client;
use anyhow::{bail, Context, Result};
use regex::Regex;
use serde::Deserialize;
use std::path::PathBuf;
#[derive(Debug, Deserialize, Clone)]
struct ForgeBmclEntry {
    #[serde(default)]
    version: String,
    #[serde(default)]
    build: Option<String>,
    #[serde(default)]
    mcversion: Option<String>,
}
async fn fetch_bmcl_forge_versions(mc_version: &str) -> Option<Vec<String>> {
    let client = shared_client().await;
    let url = format!(
        "https://bmclapi2.bangbang93.com/forge/{}/versions",
        mc_version
    );
    let text = client.get(&url).send().await.ok()?.text().await.ok()?;
    if let Ok(list) = serde_json::from_str::<Vec<ForgeBmclEntry>>(&text) {
        if !list.is_empty() {
            let mut versions: Vec<String> = list
                .into_iter()
                .filter(|e| {
                    e.mcversion
                        .as_ref()
                        .map(|v| v == mc_version)
                        .unwrap_or_else(|| e.version.contains(mc_version))
                })
                .map(|e| {
                    let forge_ver = e.build.unwrap_or(e.version);
                    format!("{}-{}", mc_version, forge_ver)
                })
                .collect();
            versions.sort_by(|a, b| b.cmp(a));
            versions.dedup();
            return Some(versions);
        }
    }
    None
}
async fn fetch_webpage_forge_versions(mc_version: &str) -> Result<Vec<String>> {
    let client = shared_client().await;
    let mut candidates: Vec<String> = Vec::new();
    candidates.push(format!(
        "https://files.minecraftforge.net/net/minecraftforge/forge/index_{}.html",
        mc_version
    ));
    let parts: Vec<&str> = mc_version.split('.').collect();
    if parts.len() > 2 {
        let short_version = format!("{}.{}", parts[0], parts[1]);
        candidates.push(format!(
            "https://files.minecraftforge.net/net/minecraftforge/forge/index_{}.html",
            short_version
        ));
    }
    let mut html: Option<String> = None;
    for url in &candidates {
        match client.get(url).send().await {
            Ok(resp) => {
                if resp.status().is_success() {
                    let text = resp
                        .text()
                        .await
                        .with_context(|| format!("读取 Forge 页面内容失败: {}", url))?;
                    if !text.is_empty() {
                        html = Some(text);
                        break;
                    }
                }
            }
            Err(_) => continue,
        }
    }
    let html = match html {
        Some(h) => h,
        None => bail!("无法获取 Forge 页面（尝试了 {:?}）", candidates),
    };
    let mut versions: Vec<String> = Vec::new();
    let re_installer = Regex::new(&format!(
        r"forge-({}-\d+(?:\.\d+)+)-installer\.jar",
        regex::escape(mc_version)
    ))
    .context("构造 installer 正则失败")?;
    for cap in re_installer.captures_iter(&html) {
        if let Some(v) = cap.get(1) {
            versions.push(v.as_str().to_string());
        }
    }
    if versions.is_empty() {
        let re_installer_loose = Regex::new(&format!(
            r"forge-({})-(\d+(?:\.\d+)+)-installer\.jar",
            regex::escape(mc_version)
        ))
        .context("构造宽松 installer 正则失败")?;
        for cap in re_installer_loose.captures_iter(&html) {
            if let (Some(mc_v), Some(forge_v)) = (cap.get(1), cap.get(2)) {
                versions.push(format!("{}-{}", mc_v.as_str(), forge_v.as_str()));
            }
        }
    }
    let re_td_version =
        Regex::new(r#"<td[^>]*class="[^"]*download-version[^"]*"[^>]*>\s*(\d+(?:\.\d+)+)"#)
            .context("构造 td-version 正则失败")?;
    for cap in re_td_version.captures_iter(&html) {
        if let Some(v) = cap.get(1) {
            versions.push(format!("{}-{}", mc_version, v.as_str()));
        }
    }
    versions.sort_by(|a, b| b.cmp(a));
    versions.dedup();
    if versions.is_empty() {
        bail!("从 Forge 页面解析版本列表失败（未找到 installer 链接）");
    }
    Ok(versions)
}
async fn fetch_maven_metadata_forge_versions(mc_version: &str) -> Result<Vec<String>> {
    let client = shared_client().await;
    let url = "https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml";
    let text = client
        .get(url)
        .send()
        .await
        .context("Failed to request Forge maven-metadata.xml")?
        .text()
        .await
        .context("Failed to read maven-metadata.xml content")?;
    let re_version = Regex::new(r"<version>(\d+(?:\.\d+)+)-(\d+(?:\.\d+)+)</version>")
        .context("构造 maven version 正则失败")?;
    let mut versions: Vec<String> = Vec::new();
    for cap in re_version.captures_iter(&text) {
        if let (Some(mc_v), Some(forge_v)) = (cap.get(1), cap.get(2)) {
            if mc_v.as_str() == mc_version {
                versions.push(format!("{}-{}", mc_v.as_str(), forge_v.as_str()));
            }
        }
    }
    if versions.is_empty() {
        bail!(
            "从 maven-metadata.xml 未找到 Minecraft {} 的 Forge 版本",
            mc_version
        );
    }
    versions.sort_by(|a, b| b.cmp(a));
    versions.dedup();
    Ok(versions)
}
pub async fn get_forge_versions(mc_version: &str) -> Result<Vec<String>> {
    let mc_version = mc_version.to_string();
    if let Some(v) = fetch_bmcl_forge_versions(&mc_version).await {
        println!("[Forge] BMCLAPI: {} 个版本", v.len());
        return Ok(v);
    }
    match fetch_maven_metadata_forge_versions(&mc_version).await {
        Ok(v) => {
            println!("[Forge] Maven: {} 个版本", v.len());
            return Ok(v);
        }
        Err(e_maven) => {
            eprintln!("[Forge] Maven 失败: {}", e_maven);
        }
    }
    let v = fetch_webpage_forge_versions(&mc_version).await?;
    println!("[Forge] 官网 HTML: {} 个版本", v.len());
    Ok(v)
}
async fn download_installer(
    mc_version: &str,
    forge_version: &str,
    mc_dir: &PathBuf,
    progress_tx: Option<tokio::sync::mpsc::Sender<f64>>,
) -> Result<PathBuf> {
    let cache_dir = mc_dir.join("cache").join("forge_installer");
    std::fs::create_dir_all(&cache_dir).ok();
    let forge_only = forge_version
        .strip_prefix(&format!("{}-", mc_version))
        .unwrap_or(forge_version)
        .to_string();
    fn mc_is_modern(mc: &str) -> bool {
        let parts: Vec<&str> = mc.split('.').collect();
        if parts.len() < 2 {
            return false;
        }
        if let (Ok(major), Ok(minor)) = (parts[0].parse::<u32>(), parts[1].parse::<u32>()) {
            (major, minor) >= (1, 13)
        } else {
            false
        }
    }
    let is_modern = mc_is_modern(mc_version);
    let mut bmcl_versions: Vec<String> = Vec::new();
    if let Some(list) = fetch_bmcl_forge_versions(mc_version).await {
        println!("[Forge] BMCLAPI 返回 {} 个版本", list.len());
        bmcl_versions = list;
    }
    let mut matched_from_api: Vec<String> = Vec::new();
    let mc_suffix = format!("-{}", mc_version);
    for v in &bmcl_versions {
        if v.contains(&forge_only) {
            let should_keep = if is_modern {
                v.strip_prefix(mc_version)
                    .map(|rest| rest.trim_start_matches('-'))
                    .map(|rest| !rest.ends_with(&mc_suffix))
                    .unwrap_or(false)
            } else {
                true
            };
            if should_keep {
                matched_from_api.push(v.clone());
            }
        }
    }
    let fmt_mc_forge = format!("{}-{}", mc_version, forge_only);           
    let fmt_mc_forge_mc = format!("{}-{}-{}", mc_version, forge_only, mc_version); 
    let fmt_mc_forge_cap_mc = format!("{}-Forge{}-{}", mc_version, forge_only, mc_version);
    let fmt_forge_mc = format!("{}-{}", forge_only, mc_version);
    let fmt_forge_only = forge_only.clone();
    let mut version_candidates: Vec<String> = Vec::new();
    for m in &matched_from_api {
        if !version_candidates.contains(m) {
            version_candidates.push(m.clone());
        }
    }
    if is_modern {
        let guesses = vec![fmt_mc_forge.clone()];
        for g in guesses {
            if !version_candidates.contains(&g) {
                version_candidates.push(g);
            }
        }
    } else {
        let guesses = vec![
            fmt_mc_forge_mc.clone(),       
            fmt_mc_forge.clone(),          
            fmt_mc_forge_cap_mc.clone(),   
            fmt_forge_mc.clone(),          
            fmt_forge_only.clone(),        
        ];
        for g in guesses {
            if !version_candidates.contains(&g) {
                version_candidates.push(g);
            }
        }
    }
    println!(
        "[Forge] 候选版本列表 ({}): {:?}",
        version_candidates.len(),
        version_candidates
    );
    for v in &version_candidates {
        let file_name = format!("forge-{}-installer.jar", v);
        let target_path = cache_dir.join(&file_name);
        if target_path.exists() {
            println!("[Forge] 缓存命中: {}", file_name);
            if let Some(tx) = progress_tx.as_ref() {
                let _ = tx.try_send(crate::downloader::install_progress::LIB_DOWNLOAD_START);
            }
            return Ok(target_path);
        }
    }
    let mut candidate_urls: Vec<(String, String)> = Vec::new();
    for v in &version_candidates {
        let file_name = format!("forge-{}-installer.jar", v);
        candidate_urls.push((
            file_name.clone(),
            format!(
                "https://files.minecraftforge.net/maven/net/minecraftforge/forge/{}/forge-{}-installer.jar",
                v, v
            ),
        ));
        candidate_urls.push((
            file_name.clone(),
            format!(
                "https://maven.minecraftforge.net/net/minecraftforge/forge/{}/forge-{}-installer.jar",
                v, v
            ),
        ));
    }
    let simple_name = format!("forge-{}-installer.jar", forge_version);
    candidate_urls.push((
        simple_name.clone(),
        format!(
            "https://files.minecraftforge.net/maven/net/minecraftforge/forge/{}-{}/forge-{}-{}-installer.jar",
            mc_version, forge_only, mc_version, forge_only
        ),
    ));
    candidate_urls.push((
        simple_name.clone(),
        format!(
            "https://files.forgecdn.net/files/{}/{}/forge-{}-installer.jar",
            mc_version.replace(".", ""),
            forge_only,
            forge_version
        ),
    ));
    candidate_urls.push((
        simple_name.clone(),
        format!(
            "https://maven.minecraftforge.net/net/minecraftforge/forge/{}/forge-{}-installer.jar",
            forge_version, forge_version
        ),
    ));
    println!("[Forge] Attempting {} download URLs", candidate_urls.len());
    for (i, (_, url)) in candidate_urls.iter().enumerate() {
        println!("[Forge]   [{}/{}] {}", i + 1, candidate_urls.len(), url);
    }
    let mut last_error: Option<String> = None;
    for (file_name, url) in &candidate_urls {
        let target_path = cache_dir.join(&file_name);
        println!("[Forge] 正在下载: {}", url);
        let task = concurrent_download::DownloadTask {
            file_name: file_name.clone(),
            target_dir: cache_dir.clone(),
            urls: vec![url.clone()],
            sha1: None,
        };
        let byte_tx = progress_tx.as_ref().map(|outer| {
            let outer = outer.clone();
            let (inner, mut rx) = tokio::sync::mpsc::channel::<(u64, u64)>(64);
            tokio::spawn(async move {
                while let Some((done, total)) = rx.recv().await {
                    let p = crate::downloader::install_progress::map_jar_bytes_to_installer_percent(
                        done, total,
                    );
                    let _ = outer.try_send(p);
                }
            });
            inner
        });
        match concurrent_download::download_file(&task, byte_tx, None).await {
            concurrent_download::SingleDownloadResult::Success { path, .. } => {
                if path.exists() {
                    return Ok(path);
                }
            }
            concurrent_download::SingleDownloadResult::Failed { error, .. } => {
                println!("[Forge]   <- {}", error);
                last_error = Some(error);
            }
        }
    }
    println!(
        "[Forge] All download URLs failed, last error: {:?}",
        last_error
    );
    println!("[Forge] Tip: You can manually open the above links in a browser to test");
    println!(
        "[Forge]      Or place forge-*-installer.jar in the following directory to skip download:"
    );
    println!("[Forge]      {}", cache_dir.display());
    bail!(
        "下载 Forge Installer JAR 失败: {} (候选版本: {:?}, 最后错误: {})",
        simple_name,
        version_candidates,
        last_error.unwrap_or_else(|| "未知".to_string())
    )
}
pub async fn install_forge(
    mc_version: &str,
    forge_version: &str,
    mc_dir: &str,
    java_path: &str,
    progress_tx: Option<tokio::sync::mpsc::Sender<f64>>,
    byte_batch_tx: Option<tokio::sync::mpsc::Sender<(u64, u64)>>,
    wait_for_original: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
) -> Result<String> {
    let mc_path = PathBuf::from(mc_dir);
    let normalized_version = if forge_version.contains('-') {
        forge_version.to_string()
    } else {
        format!("{}-{}", mc_version, forge_version)
    };
    println!(
        "[Forge] 版本号归一化: {} -> {}",
        forge_version, normalized_version
    );
    if let Some(tx) = progress_tx.as_ref() {
        let _ = tx.try_send(0.0);
    }
    let installer_jar =
        download_installer(mc_version, &normalized_version, &mc_path, progress_tx.clone()).await?;
    let java_executable = if java_path.is_empty() {
        let auto = shared::pick_java_executable(mc_version);
        println!("[Forge] 自动探测 Java: {} (java_path 为空)", auto);
        auto
    } else {
        java_path.to_string()
    };
    let cfg = shared::LoaderInstallerConfig {
        installer_jar_path: installer_jar,
        java_executable_path: PathBuf::from(java_executable),
        mc_version: mc_version.to_string(),
        mc_version_id: mc_version.to_string(),
        library_mirrors: vec![
            "https://bmclapi2.bangbang93.com/maven/".to_string(),
            "https://files.minecraftforge.net/maven/".to_string(),
            "https://libraries.minecraft.net/".to_string(),
            "https://maven.aliyun.com/repository/public/".to_string(),
            "https://repo.spongepowered.org/maven/".to_string(),
            "https://maven.fabricmc.net/".to_string(),
            "https://repo1.maven.org/maven2/".to_string(),
        ],
    };
    shared::install(&cfg, &mc_path, progress_tx, byte_batch_tx, wait_for_original).await
}