use base64::{engine::general_purpose, Engine as _};
use uuid::Uuid;

use super::paths::{read_peer_url, DEFAULT_PEER, FALLBACK_PEERS};

pub const HOST_VIP: &str = "10.126.126.1";
pub const INVITE_VERSION: &str = "v1";
const ROOM_NAME_MAX_LEN: usize = 64;
const HOSTNAME_MAX_LEN: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvitePayload {
    pub network_name: String,
    pub network_secret: String,
    pub host_ipv4: String,
    pub port: u16,
    pub peer: String,
}

/// 房间名：非空，字母数字/下划线/连字符，最长 64。
pub fn sanitize_room_name(label: &str) -> Result<String, String> {
    let trimmed = label.trim();
    if trimmed.is_empty() {
        return Err("房间名不能为空".to_string());
    }
    let sanitized: String = trimmed
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    if sanitized.is_empty() {
        return Err("房间名只能包含英文字母、数字、下划线或连字符".to_string());
    }
    if sanitized.len() > ROOM_NAME_MAX_LEN {
        return Err(format!("房间名最长 {} 个字符", ROOM_NAME_MAX_LEN));
    }
    Ok(sanitized)
}

/// EasyTier `--hostname`：与房间名类似，允许更宽松的玩家名清洗。
pub fn sanitize_hostname(label: &str) -> Result<String, String> {
    let trimmed = label.trim();
    if trimmed.is_empty() {
        return Err("主机名不能为空".to_string());
    }
    let sanitized: String = trimmed
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let sanitized = sanitized.trim_matches('_').to_string();
    if sanitized.is_empty() {
        return Err("主机名无效".to_string());
    }
    if sanitized.len() > HOSTNAME_MAX_LEN {
        Ok(sanitized[..HOSTNAME_MAX_LEN].to_string())
    } else {
        Ok(sanitized)
    }
}

pub fn parse_port(port: &str) -> Result<u16, String> {
    let trimmed = port.trim();
    if trimmed.is_empty() || !trimmed.chars().all(|c| c.is_ascii_digit()) {
        return Err("端口号必须为数字".to_string());
    }
    let value: u16 = trimmed
        .parse()
        .map_err(|_| "端口号必须在 1–65535 之间".to_string())?;
    if value == 0 {
        return Err("端口号必须在 1–65535 之间".to_string());
    }
    Ok(value)
}

pub fn generate_network_secret() -> String {
    Uuid::new_v4().to_string().replace('-', "")
}

pub fn encode_invite(payload: &InvitePayload) -> String {
    let plaintext = format!(
        "{},{},{},{},{},{}",
        INVITE_VERSION,
        payload.network_name,
        payload.network_secret,
        payload.host_ipv4,
        payload.port,
        payload.peer
    );
    general_purpose::STANDARD.encode(plaintext)
}

pub fn decode_invite(encoded: &str) -> Result<InvitePayload, String> {
    let decoded = general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|error| format!("Base64 解码失败: {}", error))?;
    let decoded_text = String::from_utf8(decoded)
        .map_err(|error| format!("解码后的字节不是有效的 UTF-8 字符串: {}", error))?;
    // peer 字段可能含冒号，因此只按前 5 个逗号切分：v1,name,secret,ip,port,peer...
    let parts: Vec<&str> = decoded_text.splitn(6, ',').collect();
    if parts.len() < 5 {
        return Err("邀请码格式不正确，应为 v1,房间名,密钥,主机IP,端口[,节点]".to_string());
    }
    if parts[0].trim() != INVITE_VERSION {
        return Err(format!(
            "不支持的邀请码版本: {}（当前仅支持 {}）",
            parts[0].trim(),
            INVITE_VERSION
        ));
    }
    let network_name = sanitize_room_name(parts[1])?;
    let network_secret = parts[2].trim().to_string();
    if network_secret.is_empty() {
        return Err("邀请码中的密钥为空".to_string());
    }
    let host_ipv4 = parts[3].trim().to_string();
    if host_ipv4.is_empty() {
        return Err("邀请码中的主机 IP 为空".to_string());
    }
    let port = parse_port(parts[4])?;
    let peer = parts
        .get(5)
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .unwrap_or_else(peer_url);
    Ok(InvitePayload {
        network_name,
        network_secret,
        host_ipv4,
        port,
        peer,
    })
}

pub fn build_host_invite(room_name: &str, port: &str, secret: &str) -> Result<InvitePayload, String> {
    let network_name = sanitize_room_name(room_name)?;
    let port = parse_port(port)?;
    let network_secret = secret.trim();
    if network_secret.is_empty() {
        return Err("网络密钥不能为空".to_string());
    }
    Ok(InvitePayload {
        network_name,
        network_secret: network_secret.to_string(),
        host_ipv4: HOST_VIP.to_string(),
        port,
        peer: peer_url(),
    })
}

pub fn peer_url() -> String {
    let peer = read_peer_url();
    let trimmed = peer.trim();
    if trimmed.is_empty() || is_retired_official_peer(trimmed) {
        DEFAULT_PEER.to_string()
    } else {
        trimmed.to_string()
    }
}

fn is_retired_official_peer(peer: &str) -> bool {
    let lower = peer.to_ascii_lowercase();
    lower.contains("public.easytier.top") || lower.contains("public.easytier.cn")
}

fn push_one_peer(args: &mut Vec<String>, seen: &mut std::collections::HashSet<String>, peer: &str) {
    let p = peer.trim();
    if p.is_empty() || is_retired_official_peer(p) {
        return;
    }
    if seen.insert(p.to_ascii_lowercase()) {
        args.push("-p".to_string());
        args.push(p.to_string());
    }
}

fn push_peer_flags(args: &mut Vec<String>, primary: &str) {
    let mut seen = std::collections::HashSet::new();
    push_one_peer(args, &mut seen, primary);
    for peer in FALLBACK_PEERS {
        push_one_peer(args, &mut seen, peer);
    }
    if seen.is_empty() {
        push_one_peer(args, &mut seen, DEFAULT_PEER);
    }
}

pub fn host_arguments(
    network_name: &str,
    network_secret: &str,
    hostname: &str,
    peer: &str,
) -> Vec<String> {
    let mut args = vec![
        "--network-name".to_string(),
        network_name.to_string(),
        "--network-secret".to_string(),
        network_secret.to_string(),
        "-i".to_string(),
        HOST_VIP.to_string(),
        "--hostname".to_string(),
        hostname.to_string(),
    ];
    push_peer_flags(&mut args, peer);
    args
}

pub fn join_arguments(
    network_name: &str,
    network_secret: &str,
    hostname: &str,
    peer: &str,
) -> Vec<String> {
    let mut args = vec![
        "--network-name".to_string(),
        network_name.to_string(),
        "--network-secret".to_string(),
        network_secret.to_string(),
        "-d".to_string(),
        "--hostname".to_string(),
        hostname.to_string(),
    ];
    push_peer_flags(&mut args, peer);
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn room_name_rejects_empty_and_oversized() {
        assert!(sanitize_room_name("").is_err());
        assert!(sanitize_room_name(&"a".repeat(65)).is_err());
        assert_eq!(sanitize_room_name("My_Room-1").unwrap(), "My_Room-1");
    }

    #[test]
    fn invite_roundtrip() {
        let payload = InvitePayload {
            network_name: "room_abc".into(),
            network_secret: "secrettoken".into(),
            host_ipv4: HOST_VIP.into(),
            port: 25565,
            peer: DEFAULT_PEER.into(),
        };
        let encoded = encode_invite(&payload);
        let decoded = decode_invite(&encoded).unwrap();
        assert_eq!(decoded, payload);
    }

    #[test]
    fn invite_decodes_legacy_without_peer() {
        let plaintext = format!(
            "v1,room_abc,secrettoken,{},25565",
            HOST_VIP
        );
        let encoded = general_purpose::STANDARD.encode(plaintext);
        let decoded = decode_invite(&encoded).unwrap();
        assert_eq!(decoded.network_name, "room_abc");
        assert!(!decoded.peer.is_empty());
    }
}
