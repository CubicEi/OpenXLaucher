use chrono::{DateTime, Utc};
use serde::Deserialize;

use super::config::{
    get_current_os, get_update_endpoint, github_repo_slug, is_trusted_download_url,
    is_trusted_release_asset_url,
};
use super::identity::{
    identity_asset_name_for_os, parse_release_identity_json, update_package_asset_name_for_os,
    ReleaseIdentity,
};

pub const GITHUB_API_ORIGIN: &str = "https://api.github.com";
pub const NETWORK_UNREACHABLE: &str = "网络不可达：无法连接 GitHub";
/// 与前端 `UPDATE_CHECK_TIMEOUT_MARKER` 一致，用于识别检查超时
pub const UPDATE_CHECK_TIMEOUT_MARKER: &str = "UPDATE_CHECK_TIMEOUT";
pub const UPDATE_CHECK_TIMEOUT_SECS: u64 = 10;

pub fn update_check_timeout_message() -> String {
    format!(
        "{}: 连接 GitHub 超过 {} 秒无响应",
        UPDATE_CHECK_TIMEOUT_MARKER, UPDATE_CHECK_TIMEOUT_SECS
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
    pub download_url: String,
    pub file_size: Option<u64>,
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
    let current_os = get_current_os();
    let identity_name = identity_asset_name_for_os(&current_os);

    let identity_asset = release
        .assets
        .iter()
        .find(|a| a.name == identity_name)
        .ok_or_else(|| format!("最新 Release 缺少 {}", identity_name))?;

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

    let package_name = update_package_asset_name_for_os(&current_os, &identity.version);
    let package_asset = release
        .assets
        .iter()
        .find(|a| a.name.eq_ignore_ascii_case(&package_name))
        .ok_or_else(|| format!("最新 Release 缺少 {}", package_name))?;

    if !is_trusted_release_asset_url(&package_asset.browser_download_url) {
        return Err(format!(
            "更新包附件 URL 不在受信任仓库路径内: {}",
            package_asset.browser_download_url
        ));
    }

    Ok(LatestReleaseBundle {
        tag_name: release.tag_name.clone(),
        changelog: release.body.clone().unwrap_or_default(),
        identity,
        download_url: package_asset.browser_download_url.clone(),
        file_size: package_asset.size,
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

#[cfg(test)]
mod tests {
    use super::super::identity::{
        identity_asset_name_for_os, update_package_asset_name_for_os,
    };

    #[test]
    fn macos_identity_and_dmg_names() {
        assert_eq!(
            identity_asset_name_for_os("macos-aarch64"),
            "OpenXLauncher.identity.macos-aarch64.json"
        );
        assert_eq!(
            identity_asset_name_for_os("macos-x86_64"),
            "OpenXLauncher.identity.macos-x86_64.json"
        );
        assert_eq!(
            update_package_asset_name_for_os("macos-aarch64", "1.0.0-pre.4"),
            "OpenXLauncher_1.0.0-pre.4_macos-aarch64.dmg"
        );
        assert_eq!(
            update_package_asset_name_for_os("macos-x86_64", "1.0.0"),
            "OpenXLauncher_1.0.0_macos-x86_64.dmg"
        );
    }

    #[test]
    fn windows_keeps_legacy_names() {
        assert_eq!(
            identity_asset_name_for_os("windows-x86_64"),
            "OpenXLauncher.identity.json"
        );
        assert_eq!(
            update_package_asset_name_for_os("windows-x86_64", "1.0.0"),
            "OpenXLauncher.exe"
        );
    }
}
