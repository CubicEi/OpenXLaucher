use chrono::{DateTime, Utc};
use serde::Deserialize;

use super::config::{
    get_update_endpoint, github_repo_slug, is_trusted_release_asset_url, is_trusted_download_url,
};
use super::identity::{
    IDENTITY_ASSET_NAME, ReleaseIdentity, WINDOWS_PORTABLE_EXE, parse_release_identity_json,
};

pub const GITHUB_API_ORIGIN: &str = "https://api.github.com";
pub const NETWORK_UNREACHABLE: &str = "网络不可达：无法连接 GitHub";
/// 与前端 `UPDATE_CHECK_TIMEOUT_MARKER` 一致，用于识别检查超时
pub const UPDATE_CHECK_TIMEOUT_MARKER: &str = "UPDATE_CHECK_TIMEOUT";
pub const UPDATE_CHECK_TIMEOUT_SECS: u64 = 10;

pub fn update_check_timeout_message() -> String {
    format!(
        "{}: 连接 GitHub 超过 {} 秒无响应",
        UPDATE_CHECK_TIMEOUT_MARKER,
        UPDATE_CHECK_TIMEOUT_SECS
    )
}

#[derive(Debug, Clone, Deserialize)]
struct ApiAsset {
    name: String,
    browser_download_url: String,
    size: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
struct ApiRelease {
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<ApiAsset>,
}

#[derive(Debug, Clone)]
pub struct LatestReleaseBundle {
    pub tag_name: String,
    pub changelog: String,
    pub identity: ReleaseIdentity,
    pub windows_exe_url: String,
    pub windows_exe_size: Option<u64>,
}

pub async fn ping_github(client: &reqwest::Client) -> Result<(), String> {
    let response = client
        .head(GITHUB_API_ORIGIN)
        .header("User-Agent", user_agent())
        .send()
        .await
        .map_err(|_| NETWORK_UNREACHABLE.to_string())?;

    if response.status().is_success() || response.status().as_u16() == 404 {
        Ok(())
    } else {
        Err(NETWORK_UNREACHABLE.to_string())
    }
}

pub async fn fetch_latest_release_bundle(
    client: &reqwest::Client,
) -> Result<LatestReleaseBundle, String> {
    ping_github(client).await?;

    let response = client
        .get(get_update_endpoint())
        .header("User-Agent", user_agent())
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|_| NETWORK_UNREACHABLE.to_string())?;

    if !response.status().is_success() {
        return Err(format!(
            "GitHub Releases API 返回 HTTP {}",
            response.status()
        ));
    }

    let releases: Vec<ApiRelease> = response
        .json()
        .await
        .map_err(|e| format!("解析 Releases 列表失败: {}", e))?;

    let release = pick_latest_release(&releases)?;

    let identity_asset = release
        .assets
        .iter()
        .find(|a| a.name == IDENTITY_ASSET_NAME)
        .ok_or_else(|| format!("最新 Release 缺少 {}", IDENTITY_ASSET_NAME))?;

    if !is_trusted_release_asset_url(&identity_asset.browser_download_url) {
        return Err(format!(
            "identity 附件 URL 不在受信任仓库路径内: {}",
            identity_asset.browser_download_url
        ));
    }

    let identity_text = client
        .get(&identity_asset.browser_download_url)
        .header("User-Agent", user_agent())
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("下载 identity 失败: {}", e))?
        .error_for_status()
        .map_err(|e| format!("下载 identity HTTP 错误: {}", e))?
        .text()
        .await
        .map_err(|e| format!("读取 identity 失败: {}", e))?;

    let identity = parse_release_identity_json(&identity_text)?;

    let exe_asset = release
        .assets
        .iter()
        .find(|a| a.name.eq_ignore_ascii_case(WINDOWS_PORTABLE_EXE))
        .ok_or_else(|| format!("最新 Release 缺少 {}", WINDOWS_PORTABLE_EXE))?;

    if !is_trusted_release_asset_url(&exe_asset.browser_download_url) {
        return Err(format!(
            "exe 附件 URL 不在受信任仓库路径内: {}",
            exe_asset.browser_download_url
        ));
    }

    if identity.sha256.len() == 64 {
        // identity 为主；Release 内 exe 仅提供下载地址
    }

    Ok(LatestReleaseBundle {
        tag_name: release.tag_name.clone(),
        changelog: release.body.clone().unwrap_or_default(),
        identity,
        windows_exe_url: exe_asset.browser_download_url.clone(),
        windows_exe_size: exe_asset.size,
    })
}

fn pick_latest_release(releases: &[ApiRelease]) -> Result<&ApiRelease, String> {
    let mut candidates: Vec<&ApiRelease> = releases.iter().filter(|r| !r.draft).collect();
    if candidates.is_empty() {
        return Err("没有可用的 GitHub Release".to_string());
    }

    candidates.sort_by(|left, right| {
        let left_ts = parse_published_at(left.published_at.as_deref());
        let right_ts = parse_published_at(right.published_at.as_deref());
        right_ts.cmp(&left_ts)
    });

    Ok(candidates[0])
}

fn parse_published_at(value: Option<&str>) -> i64 {
    value
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&Utc).timestamp())
        .unwrap_or(0)
}

fn user_agent() -> String {
    format!(
        "OpenXLauncher updater (+https://github.com/{})",
        github_repo_slug()
    )
}

pub fn redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if is_trusted_download_url(attempt.url().as_str()) {
            attempt.follow()
        } else {
            attempt.stop()
        }
    })
}
