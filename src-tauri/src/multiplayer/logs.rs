use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static LOG_BUFFER: Mutex<Vec<u8>> = Mutex::new(Vec::new());
static SESSION_LOG_OFFSET: Mutex<u64> = Mutex::new(0);

pub(super) fn session_log_path(working_dir: &Path) -> PathBuf {
    working_dir.join("log").join("easytier-session.log")
}

pub(super) fn append(text: &[u8]) {
    if let Ok(mut buffer) = LOG_BUFFER.lock() {
        buffer.extend_from_slice(text);
        // 防止无限增长：保留最近约 512 KiB
        const MAX: usize = 512 * 1024;
        if buffer.len() > MAX {
            let drain = buffer.len() - MAX;
            buffer.drain(0..drain);
        }
    }
}

pub(super) fn append_text(text: &str) {
    append(text.as_bytes());
}

pub(super) fn clear_buffer() {
    if let Ok(mut buffer) = LOG_BUFFER.lock() {
        buffer.clear();
    }
    if let Ok(mut offset) = SESSION_LOG_OFFSET.lock() {
        *offset = 0;
    }
}

pub(super) fn reset_session_log(working_dir: &Path) {
    let path = session_log_path(working_dir);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&path, b"");
    if let Ok(mut offset) = SESSION_LOG_OFFSET.lock() {
        *offset = 0;
    }
}

fn read_session_log_increment(working_dir: &Path) -> Vec<u8> {
    let path = session_log_path(working_dir);
    if !path.is_file() {
        return Vec::new();
    }
    let Ok(mut file) = File::open(&path) else {
        return Vec::new();
    };
    let Ok(mut offset) = SESSION_LOG_OFFSET.lock() else {
        return Vec::new();
    };
    let Ok(meta) = file.metadata() else {
        return Vec::new();
    };
    let len = meta.len();
    if len < *offset {
        *offset = 0;
    }
    if file.seek(SeekFrom::Start(*offset)).is_err() {
        return Vec::new();
    }
    let mut buf = Vec::new();
    if file.read_to_end(&mut buf).is_err() {
        return Vec::new();
    }
    *offset = len;
    buf
}

pub(super) fn poll() -> String {
    let mut content = if let Ok(mut buffer) = LOG_BUFFER.lock() {
        std::mem::take(&mut *buffer)
    } else {
        Vec::new()
    };
    if let Ok(dir) = super::paths::tool_dir() {
        content.extend(read_session_log_increment(&dir));
    }
    String::from_utf8_lossy(&content).to_string()
}
