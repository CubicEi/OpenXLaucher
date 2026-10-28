use crate::downloader::concurrent_download::{self, DownloadTask};
use crate::downloader::install_progress;
use crate::downloader::shared_utils::{self, Library, MetaResponse};
use crate::http_client::shared_client;
use anyhow::{anyhow, Result};
use serde_json;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use tokio::sync::mpsc;

/// 获取 Fabric Loader 版本列表
pub async fn get_fabric_loader_versions(mc_version: &str, use_mirror: bool) -> Result<Vec<String>> {
    let url = if use_mirror {
        "https://bmclapi2.bangbang93.com/fabric-meta/v2/versions"
    } else {
        "https://meta.fabricmc.net/v2/versions"
    };
    let client = shared_client().await;
    let resp = client.get(url).send().await?;
    if !resp.status().is_success() {
        return Err(anyhow!("请求失败, HTTP 状态码: {}", resp.status()));
    }
    let meta: MetaResponse = resp.json().await?;
    shared_utils::parse_meta_versions(meta, mc_version)
}

/// 获取 Fabric API 版本列表
pub async fn get_fabric_api_versions(mc_version: &str) -> Result<Vec<String>> {
    let url = "https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/maven-metadata.xml";
    let client = shared_client().await;
    let resp = client.get(url).send().await?;
    if !resp.status().is_success() {
        return Err(anyhow!("请求失败, HTTP 状态码: {}", resp.status()));
    }
    let xml_text = resp.text().await?;
    
    // 使用共享的 XML 解析工具
    let all_versions = shared_utils::parse_maven_metadata(&xml_text)?;
    // 过滤出匹配当前 MC 版本的 API 版本
    let filtered: Vec<String> = all_versions
        .into_iter()
        .filter(|v| v.contains(mc_version))
        .collect();
    
    Ok(filtered)
}

/// 安装 Fabric Loader
pub async fn install_fabric_loader(
    mc_version: &str,
    loader_version: &str,
    mc_folder_path: &str,
    use_mirror: bool,
    progress_tx: Option<mpsc::Sender<f64>>,
    byte_batch_tx: Option<mpsc::Sender<(u64, u64)>>,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<String> {
    use std::sync::atomic::Ordering;
    if cancel.as_ref().is_some_and(|c| c.load(Ordering::SeqCst)) {
        return Err(anyhow!("已取消"));
    }
    if let Some(tx) = progress_tx.as_ref() {
        let _ = tx.try_send(0.0);
    }
    let meta_url = if use_mirror {
        "https://bmclapi2.bangbang93.com/fabric-meta/v2/versions/loader"
    } else {
        "https://meta.fabricmc.net/v2/versions/loader"
    };
    let url = format!(
        "{}/{}/{}/profile/json",
        meta_url, mc_version, loader_version
    );
    let client = shared_client().await;
    let resp = client.get(&url).send().await?;
    if !resp.status().is_success() {
        return Err(anyhow!("请求失败, HTTP 状态码: {}", resp.status()));
    }
    let profile_json_text = resp.text().await?;
    let version_id = format!("{}-{}-fabric", mc_version, loader_version);
    let versions_dir = PathBuf::from(mc_folder_path)
        .join("versions")
        .join(&version_id);
    fs::create_dir_all(&versions_dir)?;
    let profile_json_path = versions_dir.join(format!("{}.json", version_id));
    fs::write(&profile_json_path, &profile_json_text)?;

    #[derive(Debug, serde::Deserialize)]
    struct ProfileJson {
        #[serde(default)]
        libraries: Vec<Library>,
    }
    let profile: ProfileJson = serde_json::from_str(&profile_json_text)?;

    // 使用共享的 concurrent_download 批量下载库文件
    let maven_base_url = if use_mirror {
        "https://bmclapi2.bangbang93.com/maven"
    } else {
        "https://maven.fabricmc.net"
    };
    download_libraries(
        &profile.libraries,
        maven_base_url,
        mc_folder_path,
        progress_tx.clone(),
        byte_batch_tx,
        cancel,
    )
    .await?;
    install_progress::emit_install_phase_start(&progress_tx);
    
    // 确保 options.txt 存在并设置语言为中文
    let options_path = versions_dir.join("options.txt");
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
    
    install_progress::emit_install_phase_done(&progress_tx);
    println!("Fabric Loader 安装完成，版本 ID: {}", version_id);
    Ok(version_id)
}

/// 安装 Fabric API
pub async fn install_fabric_api(
    mc_version: &str,
    fabric_api_version: &str,
    mc_folder_path: &str,
    progress_tx: Option<mpsc::Sender<f64>>,
) -> Result<()> {
    if let Some(tx) = progress_tx.as_ref() {
        let _ = tx.try_send(0.0);
    }
    let fabric_api_url = format!(
        "https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/{}/fabric-api-{}.jar",
        fabric_api_version, fabric_api_version
    );
    let mods_dir = PathBuf::from(mc_folder_path)
        .join("versions")
        .join(mc_version)
        .join("mods");
    fs::create_dir_all(&mods_dir)?;
    let jar_name = format!("fabric-api-{}.jar", fabric_api_version);

    // 使用共享的 concurrent_download 下载单个文件
    let task = DownloadTask {
        file_name: jar_name,
        target_dir: mods_dir,
        urls: vec![fabric_api_url],
        sha1: None,
    };
    let dl_tx = progress_tx
        .as_ref()
        .map(|outer| install_progress::attach_download_progress_scaler(outer.clone()));
    let result = concurrent_download::download_all(vec![task], dl_tx, None).await;
    if !result.failures.is_empty() {
        let f = &result.failures[0];
        return Err(anyhow!("下载 Fabric API 失败: {}", f.error));
    }
    install_progress::emit_install_phase_start(&progress_tx);
    install_progress::emit_install_phase_done(&progress_tx);
    println!("Fabric API 安装完成，版本: {}", fabric_api_version);
    Ok(())
}

/// 使用共享的 concurrent_download 批量下载库文件
async fn download_libraries(
    libraries: &[Library],
    default_url: &str,
    mc_folder_path: &str,
    progress_tx: Option<mpsc::Sender<f64>>,
    byte_batch_tx: Option<mpsc::Sender<(u64, u64)>>,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<()> {
    let mut tasks = Vec::new();
    for lib in libraries {
        let base_url = lib
            .url
            .as_deref()
            .unwrap_or(default_url)
            .trim_end_matches('/');
        let name = lib.name.clone();
        let (sub_path, jar_name) = shared_utils::parse_library_path_for_fs(&name)?;
        let library_dir = PathBuf::from(mc_folder_path)
            .join("libraries")
            .join(&sub_path);
        let url_sub_path = shared_utils::parse_library_path_for_url(&name)?;
        let download_url = format!("{}/{}", base_url, url_sub_path);

        tasks.push(DownloadTask {
            file_name: jar_name,
            target_dir: library_dir,
            urls: vec![download_url],
            sha1: lib
                .downloads
                .as_ref()
                .and_then(|d| d.artifact.as_ref())
                .map(|a| a.sha1.clone()),
        });
    }

    if tasks.is_empty() {
        return Ok(());
    }

    println!("准备下载 {} 个库文件...", tasks.len());

    let byte_tracker = byte_batch_tx.map(install_progress::ByteBatchTracker::new);
    let dl_tx = progress_tx
        .as_ref()
        .map(|outer| install_progress::attach_download_progress_scaler(outer.clone()));
    let result =
        concurrent_download::download_all_with_bytes(tasks, dl_tx, byte_tracker, cancel.clone()).await;
    if crate::downloader::modular_download::is_download_cancelled(&cancel) {
        return Err(anyhow!("已取消"));
    }
    if !result.failures.is_empty() {
        eprintln!("\n以下文件下载失败:");
        for f in &result.failures {
            eprintln!("  - {}: {}", f.file_name, f.error);
        }
        return Err(anyhow!("部分文件下载失败"));
    }

    Ok(())
}