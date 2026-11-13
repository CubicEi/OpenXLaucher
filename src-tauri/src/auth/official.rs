use regex::Regex;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlite::{Connection, State};
use std::fs;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tokio::time::sleep;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use tokio::time::Instant;

use crate::handler::auth_trace_log::{auth_trace, auth_trace_error, auth_trace_warn};

use super::AccountInfo;

const MS_FLOW_DEVICE: &str = "microsoft_device_login";
const MS_FLOW_SILENT: &str = "microsoft_silent_refresh";
const MS_FLOW_DEVICE_CODE: &str = "microsoft_device_code";

/// 微软登录取消标志：当用户关闭登录对话框时设置为 true（设备码轮询）
static MS_LOGIN_CANCELLED: AtomicBool = AtomicBool::new(false);
/// 微软认证取消代际：停止准备 / 取消登录时递增；静默刷新在各 await 间比对
static MS_AUTH_CANCEL_GEN: AtomicU64 = AtomicU64::new(0);

const CLIENT_ID: &str = "1662e9cb-e526-4bea-8237-11526075b7f3";

/// 设备代码信息，返回给前端展示
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceCodeInfo {
    pub user_code: String,
    pub verification_uri: String,
    pub device_code: String,
    pub interval: u64,
    pub expires_in: u64,
}

#[derive(Serialize, Deserialize, Debug)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
    message: String,
}

#[derive(Serialize, Deserialize, Debug)]
struct TokenResponse {
    token_type: String,
    access_token: String,
    refresh_token: String,
    expires_in: u64,
}

#[derive(Serialize, Deserialize, Debug)]
struct XboxLiveTokenResponse {
    #[serde(rename = "Token")]
    token: String,
    #[serde(rename = "DisplayClaims")]
    display_claims: DisplayClaims,
}

#[derive(Serialize, Deserialize, Debug)]
struct DisplayClaims {
    xui: Vec<Xui>,
}

#[derive(Serialize, Deserialize, Debug)]
struct Xui {
    uhs: String,
}

#[derive(Serialize, Deserialize, Debug)]
struct XSTSErrorResponse {
    #[serde(rename = "XErr")]
    x_err: Option<u64>,
    #[serde(rename = "Message")]
    message: Option<String>,
    #[serde(rename = "Redirect")]
    redirect: Option<String>,
}

#[derive(Serialize, Deserialize, Debug)]
struct MinecraftLoginResponse {
    username: String,
    access_token: String,
    token_type: String,
    expires_in: u64,
}

#[derive(Serialize, Deserialize, Debug)]
struct MinecraftProfileResponse {
    id: String,
    name: String,
    /// Minecraft Services profile 可能附带皮肤列表（含 variant）
    #[serde(default)]
    skins: Option<Vec<MCFullSkin>>,
}

/// 归一化皮肤模型为 classic | slim
fn normalize_skin_variant(raw: Option<&str>) -> Option<String> {
    match raw.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("slim") | Some("alex") => Some("slim".to_string()),
        Some("classic") | Some("default") | Some("steve") => Some("classic".to_string()),
        Some(_) => Some("classic".to_string()),
        None => None,
    }
}

/// 从 MS profile 的 ACTIVE 皮肤读取 variant
fn active_skin_variant_from_ms(skins: &Option<Vec<MCFullSkin>>) -> Option<String> {
    let skins = skins.as_ref()?;
    let active = skins
        .iter()
        .find(|s| s.state.eq_ignore_ascii_case("ACTIVE"))
        .or_else(|| skins.first())?;
    normalize_skin_variant(active.variant.as_deref())
        .or_else(|| Some("classic".to_string()))
}

/// 从 Yggdrasil profile JSON（textures base64）解析 SKIN metadata.model
pub fn skin_variant_from_profile_json(profile_json: &serde_json::Value) -> Option<String> {
    let properties = profile_json["properties"].as_array()?;
    let textures_property = properties
        .iter()
        .find(|p| p["name"].as_str() == Some("textures"))?;
    let textures_base64 = textures_property["value"].as_str()?;
    let decoded = BASE64.decode(textures_base64).ok()?;
    let textures_json: serde_json::Value = serde_json::from_slice(&decoded).ok()?;
    let skin = textures_json.get("textures")?.get("SKIN")?;
    if !skin.is_object() {
        return None;
    }
    match skin
        .get("metadata")
        .and_then(|m| m.get("model"))
        .and_then(|m| m.as_str())
    {
        Some("slim") => Some("slim".to_string()),
        _ => Some("classic".to_string()),
    }
}

/// 从 Yggdrasil sessionserver 拉取 profile 并解析皮肤模型（classic|slim）
pub fn fetch_yggdrasil_skin_variant(uuid: &str, sessionserver_base: &str) -> Option<String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .timeout(std::time::Duration::from_secs(10))
        .danger_accept_invalid_certs(true)
        .build()
        .ok()?;

    let base = sessionserver_base.trim_end_matches('/');
    let uuid_with_hyphens = format_uuid_with_hyphens(uuid);
    let uuid_without_hyphens = format_uuid_without_hyphens(uuid);

    let mut urls = Vec::new();
    for uid in &[&uuid_with_hyphens, &uuid_without_hyphens] {
        urls.push(format!("{}/session/minecraft/profile/{}", base, uid));
        urls.push(format!(
            "{}/sessionserver/session/minecraft/profile/{}",
            base, uid
        ));
    }

    for url in &urls {
        if let Ok(response) = client.get(url).send() {
            if !response.status().is_success() {
                continue;
            }
            if let Ok(json) = response.json::<serde_json::Value>() {
                if let Some(variant) = skin_variant_from_profile_json(&json) {
                    return Some(variant);
                }
            }
        }
    }
    None
}
fn is_transient_http_status(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 408 | 429 | 502 | 503 | 504)
}

fn is_retryable_auth_error(msg: &str) -> bool {
    if is_network_error_message(msg) {
        return true;
    }
    let upper = msg.to_ascii_uppercase();
    for code in ["HTTP 408", "HTTP 429", "HTTP 502", "HTTP 503", "HTTP 504"] {
        if upper.contains(code) {
            return true;
        }
    }
    false
}

/// 设备码登录：网络类错误只请求一次，立即失败。
const AUTH_RETRY_DEVICE_LOGIN: u32 = 1;
/// 静默刷新：暂态网络 / 408·429·5xx 最多 3 次，退避 1s → 2s → 4s。
const AUTH_RETRY_SILENT_REFRESH: u32 = 3;

/// 错误以 String 传递，避免 `Box<dyn Error>` 跨 await 破坏 Tauri command 的 Send。
async fn retry_on_transient<T, F, Fut>(
    label: &str,
    max_attempts: u32,
    mut op: F,
) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let max_attempts = max_attempts.max(1);
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        match op().await {
            Ok(v) => return Ok(v),
            Err(msg) => {
                if !is_retryable_auth_error(&msg) || attempt >= max_attempts {
                    return Err(msg);
                }
                let backoff_secs = 1u64 << (attempt - 1);
                eprintln!(
                    "[正版检测] {} 暂态失败，第{}/{}次，{}s后重试: {}",
                    label, attempt, max_attempts, backoff_secs, msg
                );
                sleep(Duration::from_secs(backoff_secs)).await;
            }
        }
    }
}

fn map_reqwest_err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn map_xsts_http_error(status: reqwest::StatusCode, text: &str) -> String {
    if let Ok(err_resp) = serde_json::from_str::<XSTSErrorResponse>(text) {
        match err_resp.x_err {
            Some(2148916233) => {
                "该 Microsoft 账户未关联 Xbox 账户，请先前往 xbox.com 注册".to_string()
            }
            Some(2148916235) => "您所在地区不支持 Xbox Live，无法使用正版登录".to_string(),
            Some(2148916236) | Some(2148916237) => "需要在 Xbox 官网完成成人验证".to_string(),
            Some(2148916238) => "未成年账户需要家长在 Microsoft Family 中审批".to_string(),
            Some(code) => format!("XSTS 错误码: {}", code),
            None => err_resp
                .message
                .unwrap_or_else(|| format!("HTTP {}: {}", status, text)),
        }
    } else if text.is_empty() {
        format!(
            "XSTS 服务器返回 HTTP {} 且响应体为空，可能是账户权限问题",
            status
        )
    } else {
        format!("HTTP {}: {}", status, text)
    }
}

async fn get_device_code(
    client: &Client,
    client_id: &str,
    max_attempts: u32,
) -> Result<DeviceCodeResponse, String> {
    let params = [
        ("client_id", client_id),
        ("scope", "XboxLive.signin offline_access"),
    ];
    retry_on_transient("设备码请求", max_attempts, || async {
        let response = client
            .post("https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode")
            .form(&params)
            .send()
            .await
            .map_err(map_reqwest_err)?;
        let status = response.status();
        if is_transient_http_status(status) {
            return Err(format!("HTTP {}", status.as_u16()));
        }
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(format!("HTTP {}: {}", status, text));
        }
        response
            .json::<DeviceCodeResponse>()
            .await
            .map_err(map_reqwest_err)
    })
    .await
}

async fn authenticate_with_xbox_live(
    client: &Client,
    access_token: &str,
    max_attempts: u32,
) -> Result<XboxLiveTokenResponse, String> {
    let body = serde_json::json!({
        "Properties": {
            "AuthMethod": "RPS",
            "SiteName": "user.auth.xboxlive.com",
            "RpsTicket": format!("d={}", access_token)
        },
        "RelyingParty": "http://auth.xboxlive.com",
        "TokenType": "JWT"
    });
    retry_on_transient("Xbox Live 认证", max_attempts, || async {
        let response = client
            .post("https://user.auth.xboxlive.com/user/authenticate")
            .json(&body)
            .send()
            .await
            .map_err(map_reqwest_err)?;
        let status = response.status();
        if is_transient_http_status(status) {
            return Err(format!("HTTP {}", status.as_u16()));
        }
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(format!("HTTP {}: {}", status, text));
        }
        response
            .json::<XboxLiveTokenResponse>()
            .await
            .map_err(map_reqwest_err)
    })
    .await
}

async fn get_xsts_token(
    client: &Client,
    xbox_token: &str,
    max_attempts: u32,
) -> Result<XboxLiveTokenResponse, String> {
    let body = serde_json::json!({
        "Properties": {
            "SandboxId": "RETAIL",
            "UserTokens": [xbox_token]
        },
        "RelyingParty": "rp://api.minecraftservices.com/",
        "TokenType": "JWT"
    });
    retry_on_transient("XSTS 认证", max_attempts, || async {
        let resp = client
            .post("https://xsts.auth.xboxlive.com/xsts/authorize")
            .json(&body)
            .send()
            .await
            .map_err(map_reqwest_err)?;
        let status = resp.status();
        let text = resp.text().await.map_err(map_reqwest_err)?;
        if is_transient_http_status(status) {
            return Err(format!("HTTP {}", status.as_u16()));
        }
        if !status.is_success() {
            return Err(map_xsts_http_error(status, &text));
        }
        serde_json::from_str::<XboxLiveTokenResponse>(&text)
            .map_err(|e| format!("解析 XSTS 响应失败: {} (响应: {})", e, text))
    })
    .await
}

async fn authenticate_with_minecraft(
    client: &Client,
    user_hash: &str,
    xsts_token: &str,
    max_attempts: u32,
) -> Result<MinecraftLoginResponse, String> {
    let body = serde_json::json!({
        "identityToken": format!("XBL3.0 x={};{}", user_hash, xsts_token)
    });
    retry_on_transient("Minecraft 认证", max_attempts, || async {
        let response = client
            .post("https://api.minecraftservices.com/authentication/login_with_xbox")
            .json(&body)
            .send()
            .await
            .map_err(map_reqwest_err)?;
        let status = response.status();
        if is_transient_http_status(status) {
            return Err(format!("HTTP {}", status.as_u16()));
        }
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(format!("HTTP {}: {}", status, text));
        }
        response
            .json::<MinecraftLoginResponse>()
            .await
            .map_err(map_reqwest_err)
    })
    .await
}

async fn check_mc_purchase(
    client: &Client,
    access_token: &str,
) -> Result<String, String> {
    let response = client
        .get("https://api.minecraftservices.com/entitlements/mcstore")
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(map_reqwest_err)?;
    if response.status().is_success() {
        let json: serde_json::Value = response.json().await.map_err(map_reqwest_err)?;
        let items = json.get("items").and_then(|v| v.as_array());
        if items.is_none() || items.unwrap().is_empty() {
            return Ok("您还没有购买mc，请购买后再登录游玩".to_string());
        }
    }
    Ok("您已购买Minecraft".to_string())
}

async fn get_minecraft_profile(
    client: &Client,
    access_token: &str,
    max_attempts: u32,
) -> Result<MinecraftProfileResponse, String> {
    retry_on_transient("获取 Minecraft 个人资料", max_attempts, || async {
        let response = client
            .get("https://api.minecraftservices.com/minecraft/profile")
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(map_reqwest_err)?;
        let status = response.status();
        if is_transient_http_status(status) {
            return Err(format!("HTTP {}", status.as_u16()));
        }
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(format!("HTTP {}: {}", status, text));
        }
        response
            .json::<MinecraftProfileResponse>()
            .await
            .map_err(map_reqwest_err)
    })
    .await
}

async fn refresh_access_token(
    client: &Client,
    client_id: &str,
    refresh_token: &str,
) -> Result<TokenResponse, String> {
    let params = [
        ("grant_type", "refresh_token"),
        ("client_id", client_id),
        ("refresh_token", refresh_token),
    ];
    retry_on_transient("Microsoft Token 刷新", AUTH_RETRY_SILENT_REFRESH, || async {
        let response = client
            .post("https://login.microsoftonline.com/consumers/oauth2/v2.0/token")
            .form(&params)
            .send()
            .await
            .map_err(map_reqwest_err)?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if is_transient_http_status(status) {
            return Err(format!("HTTP {}", status.as_u16()));
        }
        if !status.is_success() {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
                    let desc = v
                        .get("error_description")
                        .and_then(|d| d.as_str())
                        .unwrap_or("");
                    return Err(format!("OAuth {}: {}", err, desc));
                }
            }
            return Err(format!("HTTP {}: {}", status, text));
        }
        serde_json::from_str::<TokenResponse>(&text).map_err(map_reqwest_err)
    })
    .await
}

// 初始化数据库
fn setup_database() -> Result<Connection, Box<dyn std::error::Error>> {
    let connection = sqlite::open(super::db_path())?;
    connection.execute(
        "CREATE TABLE IF NOT EXISTS accounts (
            uuid TEXT PRIMARY KEY,
            username TEXT,
            refresh_token TEXT,
            access_token TEXT,
            time INTEGER,
            expires_at INTEGER
        )",
    )?;
    // 兼容旧库：补齐 expires_at 列
    let _ = connection.execute("ALTER TABLE accounts ADD COLUMN expires_at INTEGER");
    Ok(connection)
}

/// Minecraft access_token 默认有效期（后端未返回 expires_in 时）
const DEFAULT_MC_TOKEN_TTL_SECS: u64 = 12 * 60 * 60;
/// 到期前多少秒停止复用旧令牌（有效期 - 1 小时）
const CACHED_TOKEN_SKEW_SECS: u64 = 60 * 60;

// 将账户信息保存到数据库（含 access_token 绝对过期时间）
fn save_account_info(
    connection: &Connection,
    username: &str,
    uuid: &str,
    refresh_token: &str,
    access_token: &str,
    expires_in: Option<u64>,
) -> Result<(), Box<dyn std::error::Error>> {
    let current_time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs();
    let ttl = expires_in
        .filter(|v| *v > 0)
        .unwrap_or(DEFAULT_MC_TOKEN_TTL_SECS);
    let expires_at = current_time.saturating_add(ttl);
    let uuid_sql = uuid.replace('\'', "''");
    let username_sql = username.replace('\'', "''");
    let refresh_sql = refresh_token.replace('\'', "''");
    let access_sql = access_token.replace('\'', "''");
    connection.execute(format!(
        "INSERT OR REPLACE INTO accounts (uuid, username, refresh_token, access_token, time, expires_at) VALUES ('{}', '{}', '{}', '{}', {}, {})",
        uuid_sql, username_sql, refresh_sql, access_sql, current_time, expires_at
    ))?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedAccessToken {
    pub access_token: String,
    pub expires_at: u64,
    pub expires_in: u64,
}

/// 若数据库中的 access_token 距过期仍超过 1 小时，则直接返回，无需重新登录/静默刷新。
#[tauri::command(rename_all = "camelCase")]
pub fn ms_get_cached_access_token(uuid: String) -> Result<Option<CachedAccessToken>, String> {
    let uuid = uuid.trim().to_string();
    if uuid.is_empty() {
        return Ok(None);
    }
    let connection = setup_database().map_err(|e| format!("打开账户数据库失败: {}", e))?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    let uuid_sql = uuid.replace('\'', "''");
    let query = format!(
        "SELECT access_token, expires_at FROM accounts WHERE uuid = '{}'",
        uuid_sql
    );
    let mut stmt = connection.prepare(query).map_err(|e| e.to_string())?;
    if let State::Row = stmt.next().map_err(|e| e.to_string())? {
        let access_token: String = stmt.read::<String, _>(0).unwrap_or_default();
        let expires_at: i64 = stmt.read::<i64, _>(1).unwrap_or(0);
        if access_token.trim().is_empty() || expires_at <= 0 {
            return Ok(None);
        }
        let expires_at = expires_at as u64;
        if now + CACHED_TOKEN_SKEW_SECS >= expires_at {
            return Ok(None);
        }
        let expires_in = expires_at.saturating_sub(now);
        return Ok(Some(CachedAccessToken {
            access_token,
            expires_at,
            expires_in,
        }));
    }
    Ok(None)
}

async fn download_player_skin(
    client: &Client,
    uuid: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    // 皮肤存到配置目录下的 skins 子目录
    let profile_dir = format!("{}/skins", super::config_dir());
    fs::create_dir_all(&profile_dir)?;

    // Get player profile to check if skin exists
    let profile_response = client
        .get(&format!(
            "https://sessionserver.mojang.com/session/minecraft/profile/{}",
            uuid
        ))
        .send()
        .await?;

    if !profile_response.status().is_success() {
        return Err("Failed to fetch player profile".into());
    }

    let profile_json: serde_json::Value = profile_response.json().await?;
    let properties = profile_json["properties"]
        .as_array()
        .ok_or("No properties found in profile")?;

    // Find the textures property
    let textures_property = properties
        .iter()
        .find(|p| p["name"].as_str() == Some("textures"))
        .ok_or("No textures property found")?;

    // Decode the base64 textures value
    let textures_base64 = textures_property["value"]
        .as_str()
        .ok_or("Textures value is not a string")?;
    let decoded = BASE64.decode(textures_base64)?;
    let textures_json: serde_json::Value = serde_json::from_slice(&decoded)?;

    // Get the skin URL
    let skin_url = textures_json["textures"]["SKIN"]["url"]
        .as_str()
        .ok_or("No skin URL found in textures")?;

    // Download the skin image
    let skin_response = client.get(skin_url).send().await?;
    if !skin_response.status().is_success() {
        return Err("Failed to download skin".into());
    }

    // Save the skin to file
    let skin_bytes = skin_response.bytes().await?;
    let skin_path = format!("{}/{}.png", profile_dir, uuid);
    fs::write(skin_path, skin_bytes)?;

    Ok(())
}

/// 将 UUID 转换为标准格式（带连字符）
fn is_valid_uuid_char(c: char) -> bool {
    matches!(c, '0'..='9' | 'a'..='f' | 'A'..='F' | '-')
}

fn is_valid_uuid(uuid: &str) -> bool {
    if !uuid.chars().all(is_valid_uuid_char) {
        return false;
    }
    let clean: String = uuid.chars().filter(|c| *c != '-').collect();
    if clean.len() != 32 {
        return false;
    }
    clean.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f' | 'A'..='F'))
}

fn format_uuid_with_hyphens(uuid: &str) -> String {
    let clean: String = uuid
        .chars()
        .filter(|c| matches!(c, '0'..='9' | 'a'..='f' | 'A'..='F'))
        .collect();
    if clean.len() == 32 {
        format!(
            "{}-{}-{}-{}-{}",
            &clean[0..8],
            &clean[8..12],
            &clean[12..16],
            &clean[16..20],
            &clean[20..32]
        )
    } else {
        clean
    }
}

fn format_uuid_without_hyphens(uuid: &str) -> String {
    uuid.chars()
        .filter(|c| matches!(c, '0'..='9' | 'a'..='f' | 'A'..='F'))
        .collect()
}

fn build_safe_skin_path(skins_dir: &std::path::Path, filename: &str) -> Option<std::path::PathBuf> {
    let candidate = skins_dir.join(format!("{}.png", filename));

    let canonical_skins_dir = match skins_dir.canonicalize() {
        Ok(p) => p,
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(_) => return None,
    };

    let parent = candidate.parent()?;
    let canonical_parent = match parent.canonicalize() {
        Ok(p) => p,
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(_) => return None,
    };

    let canonical_candidate = canonical_parent.join(candidate.file_name()?);

    if canonical_candidate.starts_with(&canonical_skins_dir) {
        Some(canonical_candidate)
    } else {
        None
    }
}

/// 从本地数据库获取 tid_skin
fn get_tid_skin_from_database(uuid: &str) -> Option<i64> {
    let db_path = format!("{}/accounts.db", super::config_dir());
    match sqlite::open(&db_path) {
        Ok(conn) => {
            // 尝试带连字符和不带连字符的 UUID
            let uuid_with_hyphens = format_uuid_with_hyphens(uuid);
            let uuid_without_hyphens = format_uuid_without_hyphens(uuid);
            
            // 尝试查询 littleskin_user 表
            for current_uuid in &[uuid, &uuid_with_hyphens, &uuid_without_hyphens] {
                if let Ok(mut stmt) =
                    conn.prepare("SELECT tid_skin FROM littleskin_user WHERE uuid = ?")
                {
                    if let Ok(_) = stmt.bind((1, *current_uuid)) {
                        while let Ok(State::Row) = stmt.next() {
                            if let Ok(tid) = stmt.read::<i64, _>(0) {
                                if tid > 0 {
                                    return Some(tid);
                                }
                            }
                        }
                    }
                }
                
                // 尝试查询 littleskinuser 表（可能是旧表名）
                if let Ok(mut stmt) =
                    conn.prepare("SELECT tid_skin FROM littleskinuser WHERE uuid = ?")
                {
                    if let Ok(_) = stmt.bind((1, *current_uuid)) {
                        while let Ok(State::Row) = stmt.next() {
                            if let Ok(tid) = stmt.read::<i64, _>(0) {
                                if tid > 0 {
                                    return Some(tid);
                                }
                            }
                        }
                    }
                }
            }
            None
        }
        Err(e) => {
            eprintln!("[LittleSkin皮肤] 打开数据库失败: {}", e);
            None
        }
    }
}

/// 从 LittleSkin skinlib 页面 HTML 中提取纹理 URL
fn extract_texture_url_from_html(html: &str) -> Option<String> {
    // 匹配纹理图片的 URL 模式
    if let Ok(texture_re) = Regex::new(
        r#"<img[^>]+src=(['"])(https://textures\.littleskin\.cn/texture/.*?)\1[^>]+class=(['"])skin-preview\2"#,
    ) {
        if let Some(captures) = texture_re.captures(html) {
            return Some(captures[2].to_string());
        }
    }
    
    // 备用模式：查找所有 textures.littleskin.cn 的图片
    if let Ok(fallback_re) = Regex::new(r#"(https://textures\.littleskin\.cn/texture/[^"]+)"#) {
        if let Some(captures) = fallback_re.captures(html) {
            return Some(captures[1].to_string());
        }
    }
    
    None
}

/// 从 textures URL 中提取材质 tid（如 textures.littleskin.cn/texture/12345.png -> 12345）
fn extract_tid_from_texture_url(url: &str) -> Option<i64> {
    // 匹配 /texture/数字.png 或 /raw/数字 等模式
    if let Ok(re) = Regex::new(r#"/(?:texture|raw)/(\d+)(?:\.png)?"#) {
        if let Some(caps) = re.captures(url) {
            if let Some(tid_str) = caps.get(1) {
                return tid_str.as_str().parse::<i64>().ok();
            }
        }
    }
    None
}

/// 将提取到的 tid_skin 保存到数据库（用于后续快速获取皮肤）
fn save_tid_skin_to_database(uuid: &str, tid_skin: i64) {
    let db_path = format!("{}/accounts.db", super::config_dir());
    if let Ok(conn) = sqlite::open(&db_path) {
        let uuid_with_hyphens = format_uuid_with_hyphens(uuid);
        for current_uuid in &[uuid, &uuid_with_hyphens] {
            let query = "UPDATE littleskin_user SET tid_skin = ? WHERE uuid = ?;";
            if let Ok(mut stmt) = conn.prepare(query) {
                let _ = stmt.bind((1, tid_skin));
                let _ = stmt.bind((2, *current_uuid));
                let _ = stmt.next();
            }
        }
    }
}

/// 从给定的 profile JSON 中下载皮肤
fn download_skin_from_profile_json(
    client: &reqwest::blocking::Client,
    profile_json: &serde_json::Value,
    save_path: &str,
    uuid_for_tid_save: Option<&str>,
) -> Result<(), String> {
    let properties = match profile_json["properties"].as_array() {
        Some(p) => p,
        None => return Err("玩家信息中没有 properties".to_string()),
    };

    let textures_property = match properties
        .iter()
        .find(|p| p["name"].as_str() == Some("textures"))
    {
        Some(t) => t,
        None => return Err("没有找到 textures 属性（玩家可能未设置皮肤）".to_string()),
    };

    let textures_base64 = match textures_property["value"].as_str() {
        Some(v) => v,
        None => return Err("textures 值不是字符串".to_string()),
    };

    let decoded = BASE64
        .decode(textures_base64)
        .map_err(|e| format!("base64 解码失败: {}", e))?;

    let textures_json: serde_json::Value =
        serde_json::from_slice(&decoded).map_err(|e| format!("解析 textures JSON 失败: {}", e))?;

    let skin_url = match textures_json["textures"]["SKIN"]["url"].as_str() {
        Some(url) => url.to_string(),
        None => return Err("没有找到皮肤 URL（玩家可能使用默认皮肤）".to_string()),
    };

    // 如果有 UUID，尝试从 skin_url 提取 tid 并保存到数据库（供后续使用 raw API）
    if let Some(uuid) = uuid_for_tid_save {
        if let Some(tid) = extract_tid_from_texture_url(&skin_url) {
            eprintln!(
                "[LittleSkin皮肤] 从 textures URL 提取到 tid_skin: {}, 保存到数据库",
                tid
            );
            save_tid_skin_to_database(uuid, tid);
        }
    }

    // 优先尝试用 raw/<tid> 方式下载（如果能提取到 tid，参考 Blessing Skin 官方文档）
    if let Some(tid) = extract_tid_from_texture_url(&skin_url) {
        let raw_url = format!("https://littleskin.cn/raw/{}", tid);
        eprintln!(
            "[LittleSkin皮肤] textures URL 提取到 tid，优先使用 raw API: {}",
            raw_url
        );
        if let Ok(raw_resp) = client.get(&raw_url).send() {
            if raw_resp.status().is_success() {
                if let Ok(raw_bytes) = raw_resp.bytes() {
                    if raw_bytes.len() >= 8 && raw_bytes.starts_with(&[137, 80, 78, 71]) {
                        fs::write(save_path, raw_bytes)
                            .map_err(|e| format!("保存皮肤文件失败: {}", e))?;
                        return Ok(());
                    }
                }
            }
        }
        eprintln!("[LittleSkin皮肤] raw API 尝试失败，回退到 textures URL 下载");
    }

    let skin_response = client
        .get(&skin_url)
        .send()
        .map_err(|e| format!("下载皮肤失败: {}", e))?;

    if !skin_response.status().is_success() {
        return Err(format!("下载皮肤失败 (HTTP {})", skin_response.status()));
    }

    let skin_bytes = skin_response
        .bytes()
        .map_err(|e| format!("读取皮肤数据失败: {}", e))?;

    fs::write(save_path, skin_bytes).map_err(|e| format!("保存皮肤文件失败: {}", e))?;

    Ok(())
}

/// 通用皮肤下载函数（可用于 Microsoft、LittleSkin、第三方 Yggdrasil）
/// 从指定的 sessionserver URL 获取 textures 并下载皮肤 PNG 到 OpenX/config/skins/{uuid}.png
///
/// 兼容处理：
///   - 尝试带连字符的 UUID（xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx）
///   - 尝试无连字符的 UUID（32 字符）
///   - 如果 profile 返回的 id 字段与输入不同，优先使用返回的 id 保存
///   - 对于 LittleSkin，增加 sessionserver 路径变体（/sessionserver/session/minecraft/profile/...）
pub fn download_skin_blocking(
    uuid: &str,
    sessionserver_base: &str,
    save_tid_uuid: Option<&str>,
) -> Result<(), String> {
    let profile_dir = format!("{}/skins", super::config_dir());
    fs::create_dir_all(&profile_dir).map_err(|e| format!("创建皮肤目录失败: {}", e))?;

    let client = reqwest::blocking::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .danger_accept_invalid_certs(true) // 临时解决证书问题
        .build()
        .unwrap_or_else(|_| reqwest::blocking::Client::new());

    let base = sessionserver_base.trim_end_matches('/');
    let uuid_with_hyphens = format_uuid_with_hyphens(uuid);
    let uuid_without_hyphens = format_uuid_without_hyphens(uuid);

    // 尝试多个 URL：标准路径 + Blessing Skin 常见的 /sessionserver/ 前缀变体
    let mut urls = Vec::new();
    for uid in &[&uuid_with_hyphens, &uuid_without_hyphens] {
        urls.push(format!("{}/session/minecraft/profile/{}", base, uid));
        urls.push(format!(
            "{}/sessionserver/session/minecraft/profile/{}",
            base, uid
        ));
    }

    let mut last_error: Option<String> = None;
    let mut profile_json_result: Option<serde_json::Value> = None;

    for url in &urls {
        eprintln!("[通用皮肤下载] 尝试 URL: {}", url);
        match client.get(url).send() {
            Ok(response) => {
                if !response.status().is_success() {
                    last_error = Some(format!("获取玩家信息失败 (HTTP {})", response.status()));
                    continue;
                }
                match response.json::<serde_json::Value>() {
                    Ok(json) => {
                        profile_json_result = Some(json);
                        break;
                    }
                    Err(e) => {
                        last_error = Some(format!("解析玩家信息 JSON 失败: {}", e));
                    }
                }
            }
            Err(e) => {
                last_error = Some(format!("请求玩家信息失败: {}", e));
            }
        }
    }

    let profile_json = match profile_json_result {
        Some(j) => j,
        None => return Err(last_error.unwrap_or_else(|| "无法获取玩家信息".to_string())),
    };

    // 从返回的 profile 中获取 id，优先使用返回的 id 保存
    let saved_uuid = profile_json["id"]
        .as_str()
        .map(|id| format_uuid_with_hyphens(id))
        .unwrap_or_else(|| uuid_with_hyphens.clone());

    let skin_path = format!("{}/{}.png", profile_dir, saved_uuid);

    // 用于保存 tid 的 UUID（优先使用传入的 save_tid_uuid，否则用 saved_uuid）
    let tid_save_uuid = save_tid_uuid.unwrap_or(&saved_uuid);

    // 从 textures 下载皮肤
    match download_skin_from_profile_json(&client, &profile_json, &skin_path, Some(tid_save_uuid)) {
        Ok(()) => Ok(()),
        Err(e) => {
            // 如果失败，同时尝试使用输入的 uuid 保存（某些情况可能保存路径不一致）
            let alt_path = format!("{}/{}.png", profile_dir, uuid_with_hyphens);
            if alt_path != skin_path {
                if let Ok(()) = download_skin_from_profile_json(
                    &client,
                    &profile_json,
                    &alt_path,
                    Some(tid_save_uuid),
                ) {
                    return Ok(());
                }
            }
            Err(e)
        }
    }
}

/// 判断一个字符串是否是玩家名（不是 UUID，不是纯数字 TID）
/// 玩家名规则：长度 3-16，仅含字母、数字、下划线
fn is_minecraft_player_name(s: &str) -> bool {
    s.len() >= 3 && s.len() <= 16 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// 判断一个字符串是否是 TID（纯数字）
fn is_tid(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_digit())
}

/// 判断一个字符串是否是 UUID 格式（带或不带连字符）
fn is_uuid_format(s: &str) -> bool {
    let clean: String = s.chars().filter(|c| c.is_alphanumeric()).collect();
    clean.len() == 32
}

/// 构造带/不带连字符的 UUID 候选列表
fn uuid_candidates(uuid: &str) -> Vec<String> {
    let with_hyphens = format_uuid_with_hyphens(uuid);
    let without_hyphens = format_uuid_without_hyphens(uuid);
    let mut v = Vec::new();
    v.push(uuid.to_string());
    if uuid != with_hyphens {
        v.push(with_hyphens);
    }
    if uuid != without_hyphens {
        v.push(without_hyphens);
    }
    v.dedup();
    v
}

/// 通过 raw/<name_or_tid> 或 skin/<name>.png 等方式尝试下载皮肤（按图片方式处理）
fn try_download_direct(
    client: &reqwest::blocking::Client,
    url: &str,
    save_path: &str,
) -> Result<(), String> {
    let resp = client
        .get(url)
        .send()
        .map_err(|e| format!("请求失败: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().map_err(|e| format!("读取数据失败: {}", e))?;
    if bytes.len() < 8 || !bytes.starts_with(&[137, 80, 78, 71]) {
        return Err("响应不是有效的 PNG".to_string());
    }
    fs::write(save_path, bytes).map_err(|e| format!("保存文件失败: {}", e))?;
    Ok(())
}

/// 通过玩家名下载皮肤（参考 Blessing Skin 官方文档：raw/<玩家名> 是官方推荐的获取完整皮肤方式）
fn download_skin_by_player_name(
    client: &reqwest::blocking::Client,
    player_name: &str,
    save_path: &str,
) -> Result<(), String> {
    // 优先 raw API（官方推荐用于 3D 展示的完整皮肤）
    let raw_url = format!("https://littleskin.cn/raw/{}", player_name);
    eprintln!("[LittleSkin皮肤] 通过玩家名使用 raw API: {}", raw_url);
    match try_download_direct(client, &raw_url, save_path) {
        Ok(()) => return Ok(()),
        Err(e) => eprintln!("[LittleSkin皮肤] raw/{} 失败: {}", player_name, e),
    }
    // 回退: /skin/{name}.png
    let skin_url = format!("https://littleskin.cn/skin/{}.png", player_name);
    eprintln!("[LittleSkin皮肤] 回退使用 skin API: {}", skin_url);
    try_download_direct(client, &skin_url, save_path)
}

/// 通过 TID（材质ID）下载皮肤（参考 Blessing Skin 官方文档：raw/<tid>）
fn download_skin_by_tid(
    client: &reqwest::blocking::Client,
    tid: i64,
    save_path: &str,
) -> Result<(), String> {
    let raw_url = format!("https://littleskin.cn/raw/{}", tid);
    eprintln!("[LittleSkin皮肤] 通过 tid 使用 raw API: {}", raw_url);
    match try_download_direct(client, &raw_url, save_path) {
        Ok(()) => return Ok(()),
        Err(e) => eprintln!("[LittleSkin皮肤] raw/{} 失败: {}", tid, e),
    }
    // 回退: /texture/{tid}.png
    let texture_url = format!("https://littleskin.cn/texture/{}.png", tid);
    eprintln!("[LittleSkin皮肤] 回退使用 texture API: {}", texture_url);
    try_download_direct(client, &texture_url, save_path)
}

/// 专门的 LittleSkin 皮肤下载（因为它可能有特殊的 API 行为）
/// 支持传入可选的 player_name，当传入玩家名时优先通过玩家名方式获取（成功率更高）
pub fn download_littleskin_skin_internal(
    uuid: &str,
    player_name: Option<&str>,
) -> Result<(), String> {
    let littleskin_base = "https://littleskin.cn/api/yggdrasil";
    let cleaned_uuid = format_uuid_with_hyphens(uuid);
    let profile_dir = format!("{}/skins", super::config_dir());
    fs::create_dir_all(&profile_dir).map_err(|e| format!("创建皮肤目录失败: {}", e))?;
    let save_path = format!("{}/{}.png", profile_dir, cleaned_uuid);

    let client = reqwest::blocking::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .timeout(std::time::Duration::from_secs(15))
        .danger_accept_invalid_certs(true)
        .build()
        .unwrap_or_else(|_| reqwest::blocking::Client::new());

    // ---------------------------------------------------------------
    // 情况 A：如果传入的本身就是 TID 或 玩家名（不是 UUID）
    // ---------------------------------------------------------------
    if is_tid(uuid) {
        let tid: i64 = uuid.parse().unwrap();
        eprintln!("[LittleSkin皮肤] 传入值是 TID: {}", tid);
        return download_skin_by_tid(&client, tid, &save_path)
            .map_err(|e| format!("TID方式下载失败: {}", e));
    }
    if is_minecraft_player_name(uuid) {
        eprintln!("[LittleSkin皮肤] 传入值是玩家名: {}", uuid);
        return download_skin_by_player_name(&client, uuid, &save_path)
            .map_err(|e| format!("玩家名方式下载失败: {}", e));
    }

    // ---------------------------------------------------------------
    // 情况 B：传入的是 UUID
    // ---------------------------------------------------------------
    eprintln!(
        "[LittleSkin皮肤] 传入值是 UUID: {}, player_name={:?}",
        cleaned_uuid, player_name
    );

    // 步骤 1：从本地数据库获取 tid_skin（最高优先级）
    for u in &uuid_candidates(uuid) {
        if let Some(tid_skin) = get_tid_skin_from_database(u) {
            eprintln!("[LittleSkin皮肤] 从本地数据库获取到 tid_skin: {}", tid_skin);
            if download_skin_by_tid(&client, tid_skin, &save_path).is_ok() {
                return Ok(());
            }
            break;
        }
    }

    // 步骤 2：如果有玩家名，优先通过玩家名方式获取（成功率最高）
    if let Some(name) = player_name {
        if is_minecraft_player_name(name) {
            eprintln!("[LittleSkin皮肤] 使用传入的玩家名 {} 获取皮肤", name);
            if download_skin_by_player_name(&client, name, &save_path).is_ok() {
                return Ok(());
            }
        }
    }

    // 步骤 3：尝试 LittleSkin 的 sessionserver（标准 Yggdrasil 方式，可以从 textures URL 反提取 tid 保存）
    let mut sessionserver_ok = false;
    for u in &uuid_candidates(uuid) {
        match download_skin_blocking(u, littleskin_base, Some(&cleaned_uuid)) {
            Ok(()) => {
                eprintln!("[LittleSkin皮肤] 从 sessionserver 获取皮肤成功: {}", u);
                sessionserver_ok = true;
                break;
            }
            Err(e) => {
                eprintln!("[LittleSkin皮肤] sessionserver 方式失败 ({}): {}", u, e);
            }
        }
    }
    if sessionserver_ok {
        // 下载成功，检查文件是否在（因为 download_skin_blocking 可能用返回的 id 保存）
        for cand in &uuid_candidates(uuid) {
            let p = format!("{}/{}.png", profile_dir, cand);
            if std::path::Path::new(&p).exists() {
                if cand != &cleaned_uuid {
                    // 如果保存在不同路径，拷贝一份到 cleaned_uuid
                    let _ = fs::copy(&p, &save_path);
                }
                return Ok(());
            }
        }
    }

    // 步骤 4：Fallback：Crafatar 格式（非玩家名/非TID时才尝试，避免把UUID当玩家名）
    let uuid_no_hyphens = format_uuid_without_hyphens(uuid);
    let crafatar_urls = vec![
        format!(
            "https://littleskin.cn/cravatar/skins/{}.png",
            uuid_no_hyphens
        ),
        format!("https://littleskin.cn/cravatar/skins/{}.png", cleaned_uuid),
    ];
    for url in &crafatar_urls {
        eprintln!("[LittleSkin皮肤] 尝试 Crafatar: {}", url);
        if try_download_direct(&client, url, &save_path).is_ok() {
            eprintln!("[LittleSkin皮肤] Crafatar 方式成功");
            return Ok(());
        }
    }

    // 步骤 5：Fallback：如果 player_name 没传，尝试通过 API 用 UUID 反查玩家名，再通过玩家名获取
    // Blessing Skin /api/user ？ 实际很多 Blessing Skin 实例支持 /api/player?uuid=xxx 或 /player
    // 这里尝试用 /api/player/uuid 两种常见路径
    if player_name.is_none() {
        eprintln!("[LittleSkin皮肤] 尝试用 UUID 反查玩家信息");
        let player_api_urls = vec![
            format!("https://littleskin.cn/api/player/{}", uuid_no_hyphens),
            format!("https://littleskin.cn/api/player/{}", cleaned_uuid),
            format!("https://littleskin.cn/player/{}", uuid_no_hyphens),
            format!("https://littleskin.cn/player/{}", cleaned_uuid),
        ];
        for url in &player_api_urls {
            eprintln!("[LittleSkin皮肤] 尝试玩家信息 API: {}", url);
            if let Ok(resp) = client.get(url).send() {
                if resp.status().is_success() {
                    // 先尝试按 JSON 解析
                    if let Ok(json) = resp.json::<serde_json::Value>() {
                        // 常见字段: name / player_name / username
                        let extracted_name = json["name"]
                            .as_str()
                            .or_else(|| json["player_name"].as_str())
                            .or_else(|| json["username"].as_str())
                            .or_else(|| json["data"]["name"].as_str())
                            .or_else(|| json["player"]["name"].as_str());
                        if let Some(n) = extracted_name {
                            if is_minecraft_player_name(n) {
                                eprintln!("[LittleSkin皮肤] 反查到玩家名: {}, 尝试下载", n);
                                if download_skin_by_player_name(&client, n, &save_path).is_ok() {
                                    return Ok(());
                                }
                            }
                        }
                        // 尝试从 JSON 中直接取 tid_skin
                        let tid_extracted = json["tid_skin"]
                            .as_i64()
                            .or_else(|| json["skin_tid"].as_i64())
                            .or_else(|| json["data"]["tid_skin"].as_i64());
                        if let Some(tid) = tid_extracted {
                            eprintln!("[LittleSkin皮肤] 从 JSON 中提取到 tid_skin: {}", tid);
                            save_tid_skin_to_database(&cleaned_uuid, tid);
                            if download_skin_by_tid(&client, tid, &save_path).is_ok() {
                                return Ok(());
                            }
                        }
                        // 尝试 textures 字段
                        if let Some(skin_url) =
                            json.get("skin").and_then(|v| v.as_str()).or_else(|| {
                                json.get("textures")
                                    .and_then(|v| v.get("SKIN"))
                                    .and_then(|v| v.get("url"))
                                    .and_then(|v| v.as_str())
                            })
                        {
                            if let Some(tid) = extract_tid_from_texture_url(skin_url) {
                                eprintln!("[LittleSkin皮肤] 从 skin URL 提取 tid: {}", tid);
                                save_tid_skin_to_database(&cleaned_uuid, tid);
                                if download_skin_by_tid(&client, tid, &save_path).is_ok() {
                                    return Ok(());
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let msg = format!("无法从 LittleSkin 获取皮肤 (UUID: {})", cleaned_uuid);
    eprintln!("[LittleSkin皮肤] {}", msg);
    Err(msg)
}

/// 专门的 LittleSkin 皮肤下载（兼容旧接口，无 player_name 参数）
pub fn download_littleskin_skin(uuid: &str) -> Result<(), String> {
    download_littleskin_skin_internal(uuid, None)
}

/// 专门的 LittleSkin 皮肤下载（带 player_name 参数，推荐新代码使用）
pub fn download_littleskin_skin_with_name(uuid: &str, player_name: &str) -> Result<(), String> {
    download_littleskin_skin_internal(uuid, Some(player_name))
}

/// Tauri 命令：重新下载 LittleSkin 皮肤（用于前端皮肤显示失败时刷新）
#[tauri::command]
pub fn redownload_littleskin_skin(uuid: String) -> Result<(), String> {
    eprintln!("[LittleSkin皮肤] 前端请求重新下载皮肤: {}", uuid);
    download_littleskin_skin(&uuid)
}

/// 从第三方 Yggdrasil sessionserver 重新下载皮肤到本地缓存
#[tauri::command(rename_all = "camelCase")]
pub fn redownload_yggdrasil_skin(uuid: String, sessionserverBase: String) -> Result<(), String> {
    let base = sessionserverBase.trim();
    if base.is_empty() {
        return Err("认证服务器地址不能为空".to_string());
    }
    download_skin_blocking(&uuid, base, None)
}

/// Tauri 命令：读取本地皮肤 PNG 文件，返回 base64（供前端 3D 展示）
///
/// 兼容多种 UUID 格式：优先按传入的 UUID 查找，然后尝试带/不带连字符的格式
#[tauri::command]
pub fn get_skin_base64(uuid: String) -> Result<String, String> {
    if !is_valid_uuid(&uuid) {
        return Err("无效的 UUID 格式".to_string());
    }

    let skins_dir = std::path::PathBuf::from(super::config_dir()).join("skins");

    let uuid_with_hyphens = format_uuid_with_hyphens(&uuid);
    let uuid_without_hyphens = format_uuid_without_hyphens(&uuid);

    let mut candidates: Vec<String> = vec![uuid.clone()];
    if uuid != uuid_with_hyphens {
        candidates.push(uuid_with_hyphens);
    }
    if uuid != uuid_without_hyphens {
        candidates.push(uuid_without_hyphens);
    }

    let mut last_error: Option<String> = None;
    for candidate in &candidates {
        if !is_valid_uuid(candidate) {
            continue;
        }
        let Some(safe_path) = build_safe_skin_path(&skins_dir, candidate) else {
            continue;
        };
        eprintln!("[皮肤读取] 尝试路径: {}", safe_path.display());
        match std::fs::read(&safe_path) {
            Ok(bytes) => {
                let b64 = BASE64.encode(&bytes);
                eprintln!(
                    "[皮肤读取] 成功读取: {} ({} bytes)",
                    safe_path.display(),
                    bytes.len()
                );
                return Ok(format!("data:image/png;base64,{}", b64));
            }
            Err(e) => {
                last_error = Some(format!("读取皮肤文件失败: {}", e));
                eprintln!("[皮肤读取] 失败 {}: {}", safe_path.display(), e);
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "皮肤文件不存在".to_string()))
}

/// 删除本地磁盘上的玩家皮肤缓存文件（当账号从 official.rs 数据库中移除时调用，清理残留文件）
/// 会尝试多种 UUID 格式（带/不带连字符），返回成功删除的文件数量
#[tauri::command]
pub fn delete_cached_skin(uuid: String) -> Result<usize, String> {
    if !is_valid_uuid(&uuid) {
        return Err("无效的 UUID 格式".to_string());
    }

    let skins_dir = std::path::PathBuf::from(super::config_dir()).join("skins");

    let uuid_with_hyphens = format_uuid_with_hyphens(&uuid);
    let uuid_without_hyphens = format_uuid_without_hyphens(&uuid);

    let mut candidates: Vec<String> = vec![uuid.clone()];
    if uuid != uuid_with_hyphens {
        candidates.push(uuid_with_hyphens);
    }
    if uuid != uuid_without_hyphens {
        candidates.push(uuid_without_hyphens);
    }

    let mut deleted_count: usize = 0;
    for candidate in &candidates {
        if !is_valid_uuid(candidate) {
            continue;
        }
        let Some(safe_path) = build_safe_skin_path(&skins_dir, candidate) else {
            continue;
        };
        match std::fs::remove_file(&safe_path) {
            Ok(()) => {
                eprintln!(
                    "[正版检测-清理] 已删除残留皮肤文件: {}",
                    safe_path.display()
                );
                deleted_count += 1;
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                eprintln!(
                    "[正版检测-清理] 删除皮肤文件失败 {}: {}",
                    safe_path.display(),
                    e
                );
            }
        }
    }

    if deleted_count > 0 {
        eprintln!(
            "[正版检测-清理] UUID={} 的皮肤缓存清理完毕，共删除 {} 个文件",
            uuid, deleted_count
        );
    } else {
        eprintln!(
            "[正版检测-清理] UUID={} 没有找到残留的皮肤文件（可能从未下载过）",
            uuid
        );
    }
    Ok(deleted_count)
}
// ======================== Tauri Commands ========================

/// 构造带连接超时和读取超时的 HTTP 客户端，避免断网时无限卡死（皮肤/披风等非登录链）
fn build_http_client() -> Result<Client, String> {
    crate::http_client::client_builder_with_timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("无法创建 HTTP 客户端: {}", e))
}

/// 登录 / 静默刷新专用：更宽松超时，须与前端 `MS_LAUNCH_*_BUDGET_MS` 对齐
fn build_auth_http_client() -> Result<Client, String> {
    crate::http_client::client_builder_with_timeout(Duration::from_secs(45))
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("无法创建认证 HTTP 客户端: {}", e))
}

/// 判断是否为网络/连通性类错误（超时、DNS、连接被拒等）
fn is_network_error_message(msg: &str) -> bool {
    let lower = msg.to_lowercase();
    lower.contains("connect")
        || lower.contains("connection")
        || lower.contains("timed out")
        || lower.contains("timeout")
        || lower.contains("dns")
        || lower.contains("resolve")
        || lower.contains("network")
        || lower.contains("unreachable")
        || lower.contains("failed to lookup")
        || lower.contains("name or service not known")
        || lower.contains("no internet")
        || lower.contains("ssl")
        || lower.contains("tls")
        || lower.contains("certificate")
        || lower.contains("broken pipe")
        || lower.contains("reset by peer")
        || lower.contains("eof while")
        || msg.contains("网络连接失败")
        || msg.contains("网络连接异常")
}

/// 将 reqwest 网络错误转换为对用户友好的中文提示
fn friendly_net_err(e: impl std::fmt::Display) -> String {
    let msg = e.to_string();
    if is_network_error_message(&msg) {
        format!("网络连接失败，请检查您的网络后重试（{}）", msg)
    } else {
        msg
    }
}

/// 静默刷新失败：网络问题保留可读错误（前端不弹重新登录）；凭据失效等仍返回 REFRESH_FAILED
fn map_silent_refresh_err(context: &str, e: impl std::fmt::Display) -> String {
    let msg = e.to_string();
    if is_network_error_message(&msg) {
        eprintln!("[正版检测] 步骤3：✗ {}（网络）: {}", context, msg);
        friendly_net_err(msg)
    } else {
        eprintln!("[正版检测] 步骤3：✗ {}: {}", context, msg);
        "REFRESH_FAILED".to_string()
    }
}

/// 第一步：请求设备代码，前端展示 user_code 和 verification_uri
#[tauri::command]
pub async fn ms_request_device_code() -> Result<DeviceCodeInfo, String> {
    eprintln!("[正版检测] 步骤4：⟡ 进入强制重新登录流程！请求设备授权码...");
    auth_trace(
        MS_FLOW_DEVICE_CODE,
        "start",
        "开始请求微软设备码（网站登录入口）",
        None,
    );
    // 重置取消标志（新的一次登录流程开始）
    MS_LOGIN_CANCELLED.store(false, Ordering::SeqCst);
    let client = build_auth_http_client()?;
    let resp = get_device_code(&client, CLIENT_ID, AUTH_RETRY_DEVICE_LOGIN)
        .await
        .map_err(|e| {
            auth_trace_error(
                MS_FLOW_DEVICE_CODE,
                "device_code",
                "请求设备码失败",
                Some(json!({ "error": e.to_string() })),
            );
            friendly_net_err(e)
        })?;
    eprintln!(
        "[正版检测] 步骤4：✓ 设备码获取成功！user_code={}, verification_uri={}, 有效期={}秒",
        resp.user_code, resp.verification_uri, resp.expires_in
    );
    auth_trace(
        MS_FLOW_DEVICE_CODE,
        "device_code",
        "设备码已获取，请在浏览器完成微软网站登录",
        Some(json!({
            "userCode": resp.user_code,
            "verificationUri": resp.verification_uri,
            "expiresInSec": resp.expires_in,
            "pollIntervalSec": resp.interval,
        })),
    );
    // 自动打开浏览器让用户授权
    let _ = webbrowser::open(&resp.verification_uri);
    Ok(DeviceCodeInfo {
        user_code: resp.user_code,
        verification_uri: resp.verification_uri,
        device_code: resp.device_code,
        interval: resp.interval,
        expires_in: resp.expires_in,
    })
}

/// 第二步：轮询等待用户授权，完成后走完整认证链并返回 AccountInfo
#[tauri::command]
pub async fn ms_poll_and_login(device_code: String, interval: u64) -> Result<AccountInfo, String> {
    eprintln!("[正版检测] 步骤4：开始轮询微软登录授权（间隔={}秒，超时=300秒）", interval);
    auth_trace(
        MS_FLOW_DEVICE,
        "poll_start",
        "开始轮询：等待用户在网站确认授权",
        Some(json!({ "pollIntervalSec": interval.max(1) })),
    );
    let client = build_auth_http_client()?;
    let start_time = Instant::now();
    let timeout = Duration::from_secs(300); // 5 分钟超时
    let mut poll_count: u32 = 0;
    let mut poll_interval = interval.max(1);

    loop {
        // 检查用户是否已取消登录
        if MS_LOGIN_CANCELLED.load(Ordering::SeqCst) {
            eprintln!("[正版检测] 步骤4：✗ 用户取消了登录");
            auth_trace_warn(MS_FLOW_DEVICE, "cancelled", "用户取消微软登录", None);
            return Err("已取消登录".to_string());
        }

        if start_time.elapsed() >= timeout {
            eprintln!("[正版检测] 步骤4：✗ 登录超时（超过5分钟）");
            auth_trace_error(MS_FLOW_DEVICE, "timeout", "设备码登录超时", None);
            return Err("登录超时，请重试".to_string());
        }

        sleep(Duration::from_secs(poll_interval)).await;

        // sleep 之后再次检查取消状态
        if MS_LOGIN_CANCELLED.load(Ordering::SeqCst) {
            eprintln!("[正版检测] 步骤4：✗ 用户取消了登录");
            auth_trace_warn(MS_FLOW_DEVICE, "cancelled", "用户取消微软登录", None);
            return Err("已取消登录".to_string());
        }

        poll_count += 1;
        if poll_count % 10 == 1 {
            eprintln!(
                "[正版检测] 步骤4：轮询中... 第{}次请求（间隔={}秒）",
                poll_count, poll_interval
            );
        }

        // 单次轮询尝试（暂态网络 / 5xx 短重试）
        let params = [
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ("client_id", CLIENT_ID),
            ("device_code", device_code.as_str()),
        ];
        let poll_result = retry_on_transient("设备码 Token 轮询", AUTH_RETRY_DEVICE_LOGIN, || async {
            let response = client
                .post("https://login.microsoftonline.com/consumers/oauth2/v2.0/token")
                .form(&params)
                .send()
                .await
                .map_err(map_reqwest_err)?;
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            if is_transient_http_status(status) {
                return Err(format!("HTTP {}", status.as_u16()));
            }
            Ok((status, text))
        })
        .await;

        let (status, text) = match poll_result {
            Ok(v) => v,
            Err(msg) => {
                auth_trace_error(
                    MS_FLOW_DEVICE,
                    "oauth_poll",
                    "OAuth 轮询失败",
                    Some(json!({ "error": msg })),
                );
                return Err(friendly_net_err(msg));
            }
        };

        if !status.is_success() {
            let oauth_error = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| {
                    v.get("error")
                        .and_then(|e| e.as_str())
                        .map(|s| s.to_string())
                });
            match oauth_error.as_deref() {
                Some("authorization_pending") | None => {
                    // 尚未授权，或无法解析时按 pending 继续
                    continue;
                }
                Some("slow_down") => {
                    poll_interval = poll_interval.saturating_add(5);
                    eprintln!(
                        "[正版检测] 步骤4：收到 slow_down，轮询间隔调整为 {} 秒",
                        poll_interval
                    );
                    continue;
                }
                Some("expired_token") => {
                    auth_trace_error(MS_FLOW_DEVICE, "oauth_poll", "设备码已过期", None);
                    return Err("设备码已过期，请重新获取验证码".to_string());
                }
                Some("authorization_declined") => {
                    auth_trace_warn(MS_FLOW_DEVICE, "oauth_poll", "用户在网站拒绝了授权", None);
                    return Err("用户拒绝了微软授权".to_string());
                }
                Some(other) => {
                    let desc = serde_json::from_str::<serde_json::Value>(&text)
                        .ok()
                        .and_then(|v| {
                            v.get("error_description")
                                .and_then(|d| d.as_str())
                                .map(|s| s.to_string())
                        })
                        .unwrap_or_default();
                    return Err(format!("微软授权失败（{}）: {}", other, desc));
                }
            }
        }

        eprintln!("[正版检测] 步骤4：✓ 用户已授权！Microsoft Token 获取成功（第{}次轮询）", poll_count);
        auth_trace(
            MS_FLOW_DEVICE,
            "oauth_token",
            "已获取 Microsoft OAuth 令牌",
            Some(json!({ "pollCount": poll_count })),
        );

        let token: TokenResponse = serde_json::from_str(&text)
            .map_err(|e| format!("解析 Token 失败: {}", e))?;

        // Xbox Live 认证
        eprintln!("[正版检测] 步骤4：正在进行 Xbox Live 认证...");
        auth_trace(MS_FLOW_DEVICE, "xbox_live", "请求 Xbox Live 用户令牌", None);
        let xbox = authenticate_with_xbox_live(&client, &token.access_token, AUTH_RETRY_DEVICE_LOGIN)
            .await
            .map_err(|e| {
                let msg = e.to_string();
                auth_trace_error(
                    MS_FLOW_DEVICE,
                    "xbox_live",
                    "Xbox Live 认证失败",
                    Some(json!({ "error": msg })),
                );
                if is_network_error_message(&msg) || is_retryable_auth_error(&msg) {
                    friendly_net_err(msg)
                } else {
                    format!("Xbox Live 认证失败: {}", msg)
                }
            })?;
        eprintln!("[正版检测] 步骤4：✓ Xbox Live 认证成功");
        auth_trace(MS_FLOW_DEVICE, "xbox_live", "Xbox Live 认证成功", None);

        // XSTS Token
        eprintln!("[正版检测] 步骤4：正在获取 XSTS Token...");
        auth_trace(MS_FLOW_DEVICE, "xsts", "请求 XSTS 令牌（Minecraft 依赖方）", None);
        let xsts = get_xsts_token(&client, &xbox.token, AUTH_RETRY_DEVICE_LOGIN)
            .await
            .map_err(|e| {
                auth_trace_error(
                    MS_FLOW_DEVICE,
                    "xsts",
                    "获取 XSTS 失败",
                    Some(json!({ "error": e })),
                );
                format!("XSTS 认证失败: {}", e)
            })?;
        eprintln!("[正版检测] 步骤4：✓ XSTS Token 获取成功");
        auth_trace(MS_FLOW_DEVICE, "xsts", "XSTS 获取成功", None);

        // Minecraft 认证
        let uhs = xbox.display_claims.xui.first()
            .map(|x| x.uhs.clone())
            .ok_or_else(|| "Xbox Live 认证返回的 xui 为空".to_string())?;
        eprintln!("[正版检测] 步骤4：正在进行 Minecraft 服务端认证...");
        auth_trace(
            MS_FLOW_DEVICE,
            "minecraft_token",
            "请求 Minecraft 服务令牌（login_with_xbox）",
            None,
        );
        let mc_login = authenticate_with_minecraft(
            &client,
            &uhs,
            &xsts.token,
            AUTH_RETRY_DEVICE_LOGIN,
        )
        .await
        .map_err(|e| {
            auth_trace_error(
                MS_FLOW_DEVICE,
                "minecraft_token",
                "Minecraft 令牌请求失败",
                Some(json!({ "error": e })),
            );
            format!("Minecraft 认证失败: {}", e)
        })?;
        eprintln!("[正版检测] 步骤4：✓ Minecraft 认证成功");
        auth_trace(
            MS_FLOW_DEVICE,
            "minecraft_token",
            "Minecraft 访问令牌已获取",
            Some(json!({ "expiresInSec": mc_login.expires_in })),
        );

        // 检查是否拥有 Minecraft
        eprintln!("[正版检测] 步骤4：正在检查 Minecraft 购买状态...");
        auth_trace(MS_FLOW_DEVICE, "entitlements", "查询 Minecraft 购买资格", None);
        let purchase = check_mc_purchase(&client, &mc_login.access_token)
            .await
            .map_err(|e| {
                auth_trace_error(
                    MS_FLOW_DEVICE,
                    "entitlements",
                    "购买资格查询失败",
                    Some(json!({ "error": e })),
                );
                format!("检查购买状态失败: {}", e)
            })?;
        if purchase.contains("还没有购买") {
            eprintln!("[正版检测] 步骤4：✗ 该微软账号尚未购买 Minecraft");
            auth_trace_warn(MS_FLOW_DEVICE, "entitlements", "账号未拥有 Minecraft", None);
            return Err(purchase);
        }
        eprintln!("[正版检测] 步骤4：✓ 购买状态正常");
        auth_trace(MS_FLOW_DEVICE, "entitlements", "购买资格验证通过", None);

        // 获取 Minecraft 个人资料
        eprintln!("[正版检测] 步骤4：正在获取 Minecraft 个人资料...");
        auth_trace(MS_FLOW_DEVICE, "profile", "请求玩家资料（名称 / UUID）", None);
        let profile = get_minecraft_profile(&client, &mc_login.access_token, AUTH_RETRY_DEVICE_LOGIN)
            .await
            .map_err(|e| {
                auth_trace_error(
                    MS_FLOW_DEVICE,
                    "profile",
                    "获取玩家资料失败",
                    Some(json!({ "error": e })),
                );
                format!("获取 Minecraft 资料失败: {}", e)
            })?;
        eprintln!("[正版检测] 步骤4：✓ 获取个人资料成功！玩家名={}, UUID={}", profile.name, profile.id);
        auth_trace(
            MS_FLOW_DEVICE,
            "profile",
            "玩家资料获取成功",
            Some(json!({
                "playerName": profile.name,
                "uuid": profile.id,
            })),
        );

        // 构造返回值（先于数据库/皮肤操作，确保即使后续失败也能返回）
        let skin_variant = active_skin_variant_from_ms(&profile.skins);
        let account_info = AccountInfo {
            name: profile.name.clone(),
            uuid: profile.id.clone(),
            auth_type: "microsoft".to_string(),
            access_token: mc_login.access_token.clone(),
            skin_url: Some(profile.id.clone()),
            variant: skin_variant,
            expires_in: Some(mc_login.expires_in),
        };

        // 保存到数据库（非致命，通过 spawn_blocking 隔离 sqlite 线程安全问题）
        let db_name = profile.name.clone();
        let db_id = profile.id.clone();
        let db_refresh = token.refresh_token.clone();
        let db_access = mc_login.access_token.clone();
        let db_expires_in = Some(mc_login.expires_in);
        let db_result = tokio::task::spawn_blocking(move || -> Result<(), String> {
            let connection = setup_database().map_err(|e| e.to_string())?;
            save_account_info(
                &connection,
                &db_name,
                &db_id,
                &db_refresh,
                &db_access,
                db_expires_in,
            )
                .map_err(|e| e.to_string())?;
            Ok(())
        })
        .await;
        match db_result {
            Ok(Ok(())) => {
                eprintln!("[正版检测] 步骤4：✓ 账号信息已保存到数据库");
                auth_trace(MS_FLOW_DEVICE, "db_save", "账号凭据已写入本地数据库", None);
            }
            Ok(Err(e)) => {
                eprintln!("[MS登录] 数据库保存失败(非致命): {}", e);
                auth_trace_warn(
                    MS_FLOW_DEVICE,
                    "db_save",
                    "数据库保存失败（非致命）",
                    Some(json!({ "error": e })),
                );
            }
            Err(e) => {
                eprintln!("[MS登录] 数据库任务崩溃(非致命): {}", e);
                auth_trace_warn(
                    MS_FLOW_DEVICE,
                    "db_save",
                    "数据库任务异常（非致命）",
                    Some(json!({ "error": e.to_string() })),
                );
            }
        }

        // 下载皮肤（非致命）
        auth_trace(
            MS_FLOW_DEVICE,
            "skin_download",
            "开始下载玩家皮肤",
            Some(json!({ "uuid": profile.id })),
        );
        match download_player_skin(&client, &profile.id).await {
            Ok(()) => {
                eprintln!("[正版检测] 步骤4：✓ 玩家皮肤下载完成");
                auth_trace(MS_FLOW_DEVICE, "skin_download", "玩家皮肤下载完成", None);
            }
            Err(e) => {
                eprintln!("[MS登录] 皮肤下载失败(非致命): {}", e);
                auth_trace_warn(
                    MS_FLOW_DEVICE,
                    "skin_download",
                    "玩家皮肤下载失败（非致命）",
                    Some(json!({ "error": e.to_string() })),
                );
            }
        }

        eprintln!("[正版检测] 步骤4：✅ 强制重新登录流程完成！玩家={} 登录成功", profile.name);
        auth_trace(
            MS_FLOW_DEVICE,
            "complete",
            "微软设备码登录流程完成",
            Some(json!({ "playerName": profile.name })),
        );
        return Ok(account_info);
    }
}

/// 用户关闭登录对话框 / 停止启动准备时调用：中止设备码轮询与静默刷新
#[tauri::command]
pub fn ms_cancel_login() -> Result<(), String> {
    MS_LOGIN_CANCELLED.store(true, Ordering::SeqCst);
    MS_AUTH_CANCEL_GEN.fetch_add(1, Ordering::SeqCst);
    auth_trace_warn("microsoft", "cancel", "已请求取消微软登录/刷新", None);
    Ok(())
}

fn capture_ms_auth_cancel_gen() -> u64 {
    MS_AUTH_CANCEL_GEN.load(Ordering::SeqCst)
}

fn ensure_ms_auth_not_cancelled(cancel_gen: u64) -> Result<(), String> {
    if MS_AUTH_CANCEL_GEN.load(Ordering::SeqCst) != cancel_gen {
        eprintln!("[正版检测] ✗ 用户已取消微软认证流程");
        Err("MS_AUTH_CANCELLED".to_string())
    } else {
        Ok(())
    }
}

// ============== 皮肤/披风管理（基于 Minecraft Services API） ==============

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MCSkinInfo {
    pub id: String,
    pub state: String, // ACTIVE / INACTIVE
    pub url: String,
    pub variant: String, // classic / slim
    pub alias: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MCCapeInfo {
    pub id: String,
    pub state: String, // ACTIVE / INACTIVE
    pub url: String,
    pub alias: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MCSkinCapeProfile {
    pub skins: Vec<MCSkinInfo>,
    pub capes: Vec<MCCapeInfo>,
}

#[derive(Serialize, Deserialize, Debug)]
struct MCFullProfileResponse {
    id: String,
    name: String,
    skins: Option<Vec<MCFullSkin>>,
    capes: Option<Vec<MCFullCape>>,
}

#[derive(Serialize, Deserialize, Debug)]
struct MCFullSkin {
    id: String,
    state: String,
    url: String,
    variant: Option<String>,
    alias: Option<String>,
}

#[derive(Serialize, Deserialize, Debug)]
struct MCFullCape {
    id: String,
    state: String,
    url: String,
    alias: Option<String>,
}

/// 获取 Minecraft 完整资料（皮肤列表 + 披风列表）
#[tauri::command]
pub async fn ms_get_skins_and_capes(access_token: String) -> Result<MCSkinCapeProfile, String> {
    eprintln!("[正版检测] 步骤2：调用皮肤披风模块试探 access_token 有效性");
    if access_token.trim().is_empty() {
        eprintln!("[正版检测] 步骤2：✗ access_token 为空字符串！直接返回失败");
        return Err("账户 access_token 不存在，请重新登录".to_string());
    }
    // 打印 token 的前8位和后4位，方便调试但不泄露完整 token
    let token_len = access_token.len();
    let token_preview = if token_len >= 12 {
        format!(
            "{}...{} (长度={})",
            &access_token[0..8],
            &access_token[token_len - 4..],
            token_len
        )
    } else {
        format!("(长度={})", token_len)
    };
    eprintln!("[正版检测] 步骤2：正在请求 Minecraft Services API，token={}", token_preview);

    let client = build_http_client()?;
    let resp = client
        .get("https://api.minecraftservices.com/minecraft/profile")
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|e| {
            let err = friendly_net_err(e);
            eprintln!("[正版检测] 步骤2：✗ 网络请求失败 -> {}", err);
            err
        })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let err_msg = format!("获取皮肤资料失败 (HTTP {})", status);
        if status.as_u16() == 401 {
            eprintln!("[正版检测] 步骤2：✗ HTTP 401 Unauthorized -> access_token 已过期或无效，需要重新登录");
        } else {
            eprintln!("[正版检测] 步骤2：✗ HTTP {} -> {}", status, err_msg);
        }
        return Err(err_msg);
    }

    let profile: MCFullProfileResponse = resp
        .json()
        .await
        .map_err(|e| format!("解析皮肤资料失败: {}", e))?;

    let skins_count = profile.skins.as_ref().map(|s| s.len()).unwrap_or(0);
    let capes_count = profile.capes.as_ref().map(|c| c.len()).unwrap_or(0);
    eprintln!(
        "[正版检测] 步骤2：✓ 皮肤披风获取成功！玩家={}, 皮肤数={}, 披风数={} -> 账号正常，无需重新登录",
        profile.name, skins_count, capes_count
    );

    let skins: Vec<MCSkinInfo> = profile
        .skins
        .unwrap_or_default()
        .into_iter()
        .map(|s| MCSkinInfo {
            id: s.id,
            state: s.state,
            url: if s.url.starts_with("http://") {
                s.url.replacen("http://", "https://", 1)
            } else {
                s.url
            },
            variant: s.variant.unwrap_or_else(|| "classic".to_string()),
            alias: s.alias,
        })
        .collect();

    let capes: Vec<MCCapeInfo> = profile
        .capes
        .unwrap_or_default()
        .into_iter()
        .map(|c| MCCapeInfo {
            id: c.id,
            state: c.state,
            url: if c.url.starts_with("http://") {
                c.url.replacen("http://", "https://", 1)
            } else {
                c.url
            },
            alias: c.alias,
        })
        .collect();

    Ok(MCSkinCapeProfile { skins, capes })
}

/// 安全抓取指定 URL 的图片纹理（皮肤/披风）并返回 Base64 Data URL (data:image/png;base64,...)
/// 彻底解决 WebView2 跨域、CSP、防盗链及直连 Mojang CDN 失败导致的图片破损问题
#[tauri::command]
pub async fn fetch_texture_image_base64(url: String) -> Result<String, String> {
    use base64::Engine as _;
    let target_url = if url.starts_with("http://") {
        url.replacen("http://", "https://", 1)
    } else {
        url
    };

    let client = build_http_client()?;
    let resp = client
        .get(&target_url)
        .send()
        .await
        .map_err(|e| friendly_net_err(e))?;

    if !resp.status().is_success() {
        return Err(format!("抓取纹理图片失败 (HTTP {})", resp.status()));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取图片数据失败: {}", e))?;

    let base64_str = BASE64.encode(&bytes);
    Ok(format!("data:image/png;base64,{}", base64_str))
}

/// 上传新皮肤（PNG base64）并设置为当前皮肤
/// variant: "classic" 或 "slim"
#[tauri::command]
pub async fn ms_upload_skin(
    access_token: String,
    png_base64: String,
    variant: String,
) -> Result<String, String> {
    use base64::Engine as _;

    let client = build_http_client()?;

    // 解码 base64 -> 原始 PNG 字节
    let raw_png = BASE64
        .decode(png_base64.trim())
        .map_err(|e| format!("皮肤 base64 解码失败: {}", e))?;

    // ── 手动构造 multipart/form-data（不依赖 reqwest multipart feature）
    let boundary = "----OpenXLauncherSkinBoundaryXYZ123456";
    let mut body: Vec<u8> = Vec::new();

    // 第一部分：file (PNG 图片)
    body.extend_from_slice(format!("--{}\r\n", boundary).as_bytes());
    body.extend_from_slice(
        b"Content-Disposition: form-data; name=\"file\"; filename=\"skin.png\"\r\n",
    );
    body.extend_from_slice(b"Content-Type: image/png\r\n\r\n");
    body.extend_from_slice(&raw_png);
    body.extend_from_slice(b"\r\n");

    // 第二部分：variant
    body.extend_from_slice(format!("--{}\r\n", boundary).as_bytes());
    body.extend_from_slice(b"Content-Disposition: form-data; name=\"variant\"\r\n\r\n");
    body.extend_from_slice(variant.as_bytes());
    body.extend_from_slice(b"\r\n");

    // 结束标记
    body.extend_from_slice(format!("--{}--\r\n", boundary).as_bytes());

    let resp = client
        .post("https://api.minecraftservices.com/minecraft/profile/skins")
        .bearer_auth(&access_token)
        .header(
            reqwest::header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={}", boundary),
        )
        .body(body)
        .send()
        .await
        .map_err(|e| friendly_net_err(e))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("上传皮肤失败 (HTTP {}): {}", status, text));
    }

    // 上传成功后，从响应中解析并返回新皮肤 ID
    let profile: MCFullProfileResponse = resp
        .json()
        .await
        .map_err(|e| format!("解析上传响应失败: {}", e))?;

    // 找到新上传的皮肤（通常第一个 ACTIVE 就是新上传的）
    let new_skin_id = profile
        .skins
        .unwrap_or_default()
        .into_iter()
        .find(|s| s.state == "ACTIVE")
        .map(|s| s.id)
        .unwrap_or_else(|| "unknown".to_string());

    // 上传皮肤成功后，下载到本地（供 3D 展示）
    let uuid = profile.id.clone();
    let _ = download_skin_blocking(&uuid, "https://sessionserver.mojang.com", None);

    Ok(new_skin_id)
}

/// 激活指定皮肤（从已有皮肤列表中切换）
#[tauri::command]
pub async fn ms_activate_skin(
    access_token: String,
    skin_id: String,
    variant: String,
) -> Result<(), String> {
    let client = build_http_client()?;
    let body = serde_json::json!({ "variant": variant });
    let resp = client
        .put(&format!(
            "https://api.minecraftservices.com/minecraft/profile/skins/{}",
            skin_id
        ))
        .bearer_auth(&access_token)
        .json(&body)
        .send()
        .await
        .map_err(|e| friendly_net_err(e))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("切换皮肤失败 (HTTP {}): {}", status, text));
    }
    Ok(())
}

/// 删除指定皮肤
#[tauri::command]
pub async fn ms_delete_skin(access_token: String, skin_id: String) -> Result<(), String> {
    let client = build_http_client()?;
    let resp = client
        .delete(&format!(
            "https://api.minecraftservices.com/minecraft/profile/skins/{}",
            skin_id
        ))
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|e| friendly_net_err(e))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("删除皮肤失败 (HTTP {}): {}", status, text));
    }
    Ok(())
}

/// 设置激活披风（capeId 为空则取消激活）
#[tauri::command]
pub async fn ms_set_active_cape(access_token: String, cape_id: String) -> Result<(), String> {
    let client = build_http_client()?;

    let resp = if cape_id.is_empty() {
        // 取消激活披风
        client
            .delete("https://api.minecraftservices.com/minecraft/profile/capes/active")
            .bearer_auth(&access_token)
            .send()
            .await
            .map_err(|e| friendly_net_err(e))?
    } else {
        // 设置激活披风
        let body = serde_json::json!({ "capeId": cape_id });
        client
            .put("https://api.minecraftservices.com/minecraft/profile/capes/active")
            .bearer_auth(&access_token)
            .json(&body)
            .send()
            .await
            .map_err(|e| friendly_net_err(e))?
    };

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("设置披风失败 (HTTP {}): {}", status, text));
    }
    Ok(())
}

/// 尝试通过数据库中的 refresh_token 静默刷新微软账号
/// 成功：返回更新后的 AccountInfo（包含新的 access_token、name、uuid、skin_url）
/// 失败：返回错误（例如 "NO_REFRESH_TOKEN"、"REFRESH_FAILED" 等），表示必须重新走设备码授权流程
#[tauri::command]
pub async fn ms_silent_refresh_account(uuid: String) -> Result<AccountInfo, String> {
    eprintln!("[正版检测] 步骤3：尝试用 refresh_token 静默刷新账号 UUID={}", uuid);
    auth_trace(
        MS_FLOW_SILENT,
        "start",
        "开始静默刷新 Microsoft 账号",
        Some(json!({ "uuid": uuid })),
    );
    // 用代际比对取消：不在此处清 bool，避免与 ms_cancel_login 竞态把刚置的取消冲掉
    let cancel_gen = capture_ms_auth_cancel_gen();

    // ── 第一步：从数据库中取出 refresh_token（同步块内完成，避免非 Send 的 SQLite Statement/Connection 跨 await）──
    let (db_uuid, db_refresh_token): (String, String) = {
        let connection = setup_database().map_err(|e| format!("打开账户数据库失败: {}", e))?;
        let query = format!(
            "SELECT uuid, username, refresh_token, access_token, time FROM accounts WHERE uuid = '{}'",
            uuid.replace('\'', "''")
        );
        let mut stmt = connection.prepare(query).map_err(|e| e.to_string())?;

        if let State::Row = stmt.next().map_err(|e| e.to_string())? {
            let u: String = stmt.read::<String, _>(0).map_err(|e| e.to_string())?;
            let n: String = stmt.read::<String, _>(1).map_err(|e| e.to_string())?;
            let rt: String = stmt.read::<String, _>(2).map_err(|e| e.to_string())?;
            if rt.trim().is_empty() {
                eprintln!("[正版检测] 步骤3：✗ 数据库中 refresh_token 为空，无法静默刷新");
                auth_trace_error(MS_FLOW_SILENT, "db_load", "refresh_token 为空", None);
                return Err("NO_REFRESH_TOKEN".to_string());
            }
            eprintln!("[正版检测] 步骤3：从数据库读取到玩家名={}, refresh_token 存在 (长度={})", n, rt.len());
            auth_trace(
                MS_FLOW_SILENT,
                "db_load",
                "已从本地数据库读取 refresh_token",
                Some(json!({ "playerName": n, "refreshTokenLen": rt.len() })),
            );
            (u, rt)
        } else {
            eprintln!("[正版检测] 步骤3：✗ 数据库中没有该 UUID 的账号记录，无法静默刷新");
            auth_trace_error(MS_FLOW_SILENT, "db_load", "数据库无此账号", Some(json!({ "uuid": uuid })));
            return Err("NO_REFRESH_TOKEN".to_string());
        }
        // stmt、connection 在这里离开作用域被 drop，不会保留到 await 之后
    };

    ensure_ms_auth_not_cancelled(cancel_gen)?;

    // ── 第二步：HTTP / await 部分（作用域中不再保留任何 db 相关对象）──
    let client = build_auth_http_client().map_err(|e| e.to_string())?;

    eprintln!("[正版检测] 步骤3：正在请求 Microsoft Token 刷新接口...");
    auth_trace(MS_FLOW_SILENT, "oauth_refresh", "请求 Microsoft OAuth 刷新令牌", None);
    // 2) 调用 Microsoft token endpoint 刷新 access_token
    let refreshed = refresh_access_token(&client, CLIENT_ID, &db_refresh_token)
        .await
        .map_err(|e| map_silent_refresh_err("Microsoft Token 刷新失败", e))?;
    ensure_ms_auth_not_cancelled(cancel_gen)?;
    eprintln!("[正版检测] 步骤3：✓ Microsoft Token 刷新成功，新 access_token 长度={}", refreshed.access_token.len());
    auth_trace(
        MS_FLOW_SILENT,
        "oauth_refresh",
        "OAuth 刷新成功",
        Some(json!({ "accessTokenLen": refreshed.access_token.len() })),
    );

    eprintln!("[正版检测] 步骤3：正在走 Xbox Live / XSTS / Minecraft 完整认证链...");
    auth_trace(MS_FLOW_SILENT, "xbox_live", "请求 Xbox Live 用户令牌", None);
    // 3) 走一遍 Xbox Live / XSTS / Minecraft 登录链条，拿到 Minecraft access_token
    let xbox_token = authenticate_with_xbox_live(&client, &refreshed.access_token, AUTH_RETRY_SILENT_REFRESH)
        .await
        .map_err(|e| map_silent_refresh_err("Xbox Live 认证失败", e))?;
    ensure_ms_auth_not_cancelled(cancel_gen)?;
    eprintln!("[正版检测] 步骤3：✓ Xbox Live 认证成功");
    auth_trace(MS_FLOW_SILENT, "xbox_live", "Xbox Live 认证成功", None);

    auth_trace(MS_FLOW_SILENT, "xsts", "请求 XSTS 令牌", None);
    let xsts_token = get_xsts_token(&client, &xbox_token.token, AUTH_RETRY_SILENT_REFRESH)
        .await
        .map_err(|e| map_silent_refresh_err("XSTS 认证失败", e))?;
    ensure_ms_auth_not_cancelled(cancel_gen)?;
    eprintln!("[正版检测] 步骤3：✓ XSTS 认证成功");
    auth_trace(MS_FLOW_SILENT, "xsts", "XSTS 获取成功", None);

    auth_trace(
        MS_FLOW_SILENT,
        "minecraft_token",
        "请求 Minecraft 服务令牌",
        None,
    );
    let mc_login = authenticate_with_minecraft(
        &client,
        &xsts_token.display_claims.xui[0].uhs,
        &xsts_token.token,
        AUTH_RETRY_SILENT_REFRESH,
    )
    .await
    .map_err(|e| map_silent_refresh_err("Minecraft 认证失败", e))?;
    ensure_ms_auth_not_cancelled(cancel_gen)?;
    eprintln!("[正版检测] 步骤3：✓ Minecraft 认证成功，新 Minecraft access_token 长度={}", mc_login.access_token.len());
    auth_trace(MS_FLOW_SILENT, "minecraft_token", "Minecraft 访问令牌已获取", None);

    // 4) 取得玩家资料（玩家名、皮肤等）
    auth_trace(MS_FLOW_SILENT, "profile", "请求玩家资料", None);
    let mc_profile = get_minecraft_profile(&client, &mc_login.access_token, AUTH_RETRY_SILENT_REFRESH)
        .await
        .map_err(|e| map_silent_refresh_err("获取 Minecraft 个人资料失败", e))?;
    ensure_ms_auth_not_cancelled(cancel_gen)?;
    eprintln!("[正版检测] 步骤3：✓ 获取个人资料成功，玩家名={}", mc_profile.name);
    auth_trace(
        MS_FLOW_SILENT,
        "profile",
        "玩家资料获取成功",
        Some(json!({ "playerName": mc_profile.name })),
    );

    // 5) 把新 token 存回数据库（再次单独开连接，同步块，不跨 await）
    {
        let connection = setup_database().map_err(|e| format!("打开账户数据库失败: {}", e))?;
        save_account_info(
            &connection,
            &mc_profile.name,
            &db_uuid,
            &refreshed.refresh_token,
            &mc_login.access_token,
            Some(mc_login.expires_in),
        )
        .map_err(|e| format!("保存账号信息失败: {}", e))?;
        eprintln!("[正版检测] 步骤3：✓ 新凭据已保存到数据库");
        auth_trace(MS_FLOW_SILENT, "db_save", "新凭据已写入数据库", None);
    }

    ensure_ms_auth_not_cancelled(cancel_gen)?;

    // 6) 同步下载皮肤（如果需要）
    auth_trace(
        MS_FLOW_SILENT,
        "skin_download",
        "开始下载玩家皮肤",
        Some(json!({ "uuid": db_uuid })),
    );
    match download_player_skin(&client, &db_uuid).await {
        Ok(()) => auth_trace(MS_FLOW_SILENT, "skin_download", "玩家皮肤下载完成", None),
        Err(e) => auth_trace_warn(
            MS_FLOW_SILENT,
            "skin_download",
            "玩家皮肤下载失败（非致命）",
            Some(json!({ "error": e.to_string() })),
        ),
    }
    ensure_ms_auth_not_cancelled(cancel_gen)?;
    eprintln!("[正版检测] 步骤3：✅ 静默刷新账号成功！一切正常");
    auth_trace(MS_FLOW_SILENT, "complete", "静默刷新完成", None);

    let skin_variant = active_skin_variant_from_ms(&mc_profile.skins);
    Ok(AccountInfo {
        name: mc_profile.name,
        uuid: db_uuid.clone(),
        auth_type: "microsoft".to_string(),
        access_token: mc_login.access_token,
        skin_url: Some(db_uuid),
        variant: skin_variant,
        expires_in: Some(mc_login.expires_in),
    })
}

/// 检查数据库中是否存在某个 uuid 的微软账号（有 refresh_token 记录）
/// 用于启动时判断是否需要"试探正版账号是否正常登录"
#[tauri::command]
pub async fn ms_has_account_in_db(uuid: String) -> Result<bool, String> {
    eprintln!("[正版检测] 步骤1：检查数据库中是否存在账号 UUID={}", uuid);
    // 整个函数同步完成（没有 await），SQLite 非 Send 对象不会跨 await，Send 安全
    let connection = setup_database().map_err(|e| format!("打开账户数据库失败: {}", e))?;
    let query = format!(
        "SELECT COUNT(*) AS cnt FROM accounts WHERE uuid = '{}'",
        uuid.replace('\'', "''")
    );
    let mut stmt = connection.prepare(query).map_err(|e| e.to_string())?;
    if let State::Row = stmt.next().map_err(|e| e.to_string())? {
        let cnt: i64 = stmt.read::<i64, _>(0).unwrap_or(0);
        let found = cnt > 0;
        if found {
            eprintln!("[正版检测] 步骤1：✓ 数据库中存在该账号记录 (count={})", cnt);
        } else {
            eprintln!("[正版检测] 步骤1：✗ 数据库中不存在该账号，跳过后续检测");
        }
        Ok(found)
    } else {
        eprintln!("[正版检测] 步骤1：✗ 数据库查询失败，账号不存在");
        Ok(false)
    }
}