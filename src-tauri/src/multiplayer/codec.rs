use base64::{engine::general_purpose, Engine as _};

const OPENP2P_TOKEN: &str = "11661058147873189554";
const OPENP2P_NODE_MIN_LEN: usize = 8;
const OPENP2P_NODE_MAX_LEN: usize = 31;

/// OpenP2P 要求 `-node` 为 8–31 字符，过短会注册失败，加入方常见报错为 peer offline。
pub fn sanitize_openp2p_node(label: &str) -> Result<String, String> {
    let trimmed = label.trim();
    let sanitized: String = trimmed
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    if sanitized.is_empty() {
        return Err("节点名只能包含英文字母、数字、下划线或连字符".to_string());
    }
    let node = if sanitized.len() < OPENP2P_NODE_MIN_LEN {
        format!(
            "{}{}",
            sanitized,
            "_".repeat(OPENP2P_NODE_MIN_LEN - sanitized.len())
        )
    } else if sanitized.len() > OPENP2P_NODE_MAX_LEN {
        sanitized[..OPENP2P_NODE_MAX_LEN].to_string()
    } else {
        sanitized
    };
    Ok(node)
}

pub(super) fn encode_room_info(room_name: &str, port: &str) -> String {
    general_purpose::STANDARD.encode(format!("{},{}", room_name, port))
}

pub(super) fn host_arguments(room_name: &str) -> Vec<String> {
    ["-d", "-node", room_name, "-token", OPENP2P_TOKEN]
        .into_iter()
        .map(str::to_owned)
        .collect()
}

pub(super) fn join_arguments(
    encoded_value: &str,
    player_name: &str,
) -> Result<Vec<String>, String> {
    let decoded = general_purpose::STANDARD
        .decode(encoded_value)
        .map_err(|error| format!("Base64 解码失败: {}", error))?;
    let decoded_text = String::from_utf8(decoded)
        .map_err(|error| format!("解码后的字节不是有效的 UTF-8 字符串: {}", error))?;
    let parts: Vec<&str> = decoded_text.split(',').collect();
    if parts.len() != 2 {
        return Err("解码后的字符串格式不正确，应为: 房间名,端口号".to_string());
    }
    let peer_node = parts[0].trim();
    if peer_node.len() < OPENP2P_NODE_MIN_LEN || peer_node.len() > OPENP2P_NODE_MAX_LEN {
        return Err(format!(
            "房间编码中的节点名长度无效（需 {}–{} 字符），请让房主重新创建房间并分享新编码",
            OPENP2P_NODE_MIN_LEN, OPENP2P_NODE_MAX_LEN
        ));
    }
    let local_node = sanitize_openp2p_node(&format!("j_{}", player_name.trim()))?;

    Ok([
        "-d",
        "-node",
        &local_node,
        "-token",
        OPENP2P_TOKEN,
        "-appname",
        "OpenXLauncher",
        "-peernode",
        peer_node,
        "-dstip",
        "127.0.0.1",
        "-dstport",
        parts[1],
        "-srcport",
        parts[1],
        "-protocol",
        "tcp",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect())
}

#[cfg(test)]
mod tests {
    use super::sanitize_openp2p_node;

    #[test]
    fn pads_short_node_names_to_eight_chars() {
        assert_eq!(sanitize_openp2p_node("myroom").unwrap(), "myroom__");
    }

    #[test]
    fn join_node_from_short_player_name() {
        let node = sanitize_openp2p_node("j_Steve").unwrap();
        assert!(node.len() >= 8);
        assert!(node.len() <= 31);
    }
}
