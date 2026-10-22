//! Local SQLite registry mapping mod jar SHA1 → Modrinth / CurseForge project (launcher downloads).

use sqlite::{Connection, State};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone)]
pub struct RegistryBinding {
    pub source: String,
    pub project_slug: String,
    pub project_id: Option<String>,
}

fn db_path() -> PathBuf {
    crate::app_paths::portable_mod_file_registry_path()
}

fn connection_store() -> &'static Mutex<Option<Connection>> {
    static STORE: OnceLock<Mutex<Option<Connection>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(None))
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn normalize_sha1(sha1: &str) -> String {
    sha1.trim().to_ascii_lowercase()
}

fn normalize_source(source: &str) -> Result<String, String> {
    let s = source.trim().to_ascii_lowercase();
    match s.as_str() {
        "modrinth" | "curseforge" => Ok(s),
        _ => Err(format!("不支持的模组平台来源: {}", source)),
    }
}

pub fn ensure_registry_db() -> Result<(), String> {
    let path = db_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建注册库目录失败: {}", e))?;
    }

    let lock = connection_store();
    let mut guard = lock.lock().map_err(|_| "注册库连接锁已损坏".to_string())?;
    if guard.is_some() {
        return Ok(());
    }

    let conn = sqlite::open(&path).map_err(|e| format!("打开 mod 注册库失败: {}", e))?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS mod_file_bindings (
            sha1 TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            project_slug TEXT NOT NULL,
            project_id TEXT,
            file_name TEXT NOT NULL,
            downloaded_at INTEGER NOT NULL
        )",
    )
    .map_err(|e| format!("初始化 mod 注册库表失败: {}", e))?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_mod_file_bindings_slug ON mod_file_bindings(project_slug)",
    )
    .map_err(|e| format!("创建 project_slug 索引失败: {}", e))?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_mod_file_bindings_source ON mod_file_bindings(source)",
    )
    .map_err(|e| format!("创建 source 索引失败: {}", e))?;

    *guard = Some(conn);
    Ok(())
}

fn with_connection<F, T>(f: F) -> Result<T, String>
where
    F: FnOnce(&Connection) -> Result<T, String>,
{
    ensure_registry_db()?;
    let lock = connection_store();
    let guard = lock.lock().map_err(|_| "注册库连接锁已损坏".to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "注册库未初始化".to_string())?;
    f(conn)
}

/// Insert or replace a jar hash → project binding.
pub fn upsert_binding(
    sha1: &str,
    source: &str,
    project_slug: &str,
    project_id: Option<&str>,
    file_name: &str,
) -> Result<(), String> {
    let sha1 = normalize_sha1(sha1);
    if sha1.len() != 40 || !sha1.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("SHA1 格式无效".to_string());
    }
    let source = normalize_source(source)?;
    let slug = project_slug.trim();
    if slug.is_empty() {
        return Err("project_slug 不能为空".to_string());
    }
    let file_name = file_name.trim();
    if file_name.is_empty() {
        return Err("file_name 不能为空".to_string());
    }
    let project_id = project_id.map(|s| s.trim()).filter(|s| !s.is_empty());

    with_connection(|conn| {
        let mut stmt = conn
            .prepare(
                "INSERT OR REPLACE INTO mod_file_bindings
                (sha1, source, project_slug, project_id, file_name, downloaded_at)
                VALUES (?, ?, ?, ?, ?, ?)",
            )
            .map_err(|e| format!("准备写入注册库失败: {}", e))?;
        stmt.bind((1, sha1.as_str()))
            .map_err(|e| format!("绑定 sha1 失败: {}", e))?;
        stmt.bind((2, source.as_str()))
            .map_err(|e| format!("绑定 source 失败: {}", e))?;
        stmt.bind((3, slug))
            .map_err(|e| format!("绑定 project_slug 失败: {}", e))?;
        let project_id_value = project_id.unwrap_or("");
        stmt.bind((4, project_id_value))
            .map_err(|e| format!("绑定 project_id 失败: {}", e))?;
        stmt.bind((5, file_name))
            .map_err(|e| format!("绑定 file_name 失败: {}", e))?;
        stmt.bind((6, now_unix()))
            .map_err(|e| format!("绑定 downloaded_at 失败: {}", e))?;
        stmt.next().map_err(|e| format!("写入注册库失败: {}", e))?;
        Ok(())
    })
}

pub fn lookup_by_sha1(sha1: &str) -> Option<RegistryBinding> {
    let sha1 = normalize_sha1(sha1);
    with_connection(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT source, project_slug, project_id FROM mod_file_bindings WHERE sha1 = ? LIMIT 1",
            )
            .map_err(|e| format!("准备查询注册库失败: {}", e))?;
        stmt.bind((1, sha1.as_str()))
            .map_err(|e| format!("绑定 sha1 失败: {}", e))?;
        if stmt.next().map_err(|e| format!("查询注册库失败: {}", e))? == State::Row {
            let source = stmt.read::<String, _>(0).map_err(|e| e.to_string())?;
            let project_slug = stmt.read::<String, _>(1).map_err(|e| e.to_string())?;
            let project_id = stmt
                .read::<String, _>(2)
                .ok()
                .filter(|s| !s.trim().is_empty());
            return Ok(Some(RegistryBinding {
                source,
                project_slug,
                project_id,
            }));
        }
        Ok(None)
    })
    .ok()
    .flatten()
}

/// Compute SHA1 of `path` and upsert registry row.
pub fn register_file_at_path(
    path: &Path,
    sha1_hex: &str,
    source: &str,
    project_slug: &str,
    project_id: Option<&str>,
) -> Result<(), String> {
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "unknown.jar".to_string());
    upsert_binding(sha1_hex, source, project_slug, project_id, &file_name)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn open_temp_db() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("registry.db");
        (dir, path)
    }

    fn init_at(path: &Path) -> Connection {
        let conn = sqlite::open(path).expect("open");
        conn.execute(
            "CREATE TABLE mod_file_bindings (
                sha1 TEXT PRIMARY KEY,
                source TEXT NOT NULL,
                project_slug TEXT NOT NULL,
                project_id TEXT,
                file_name TEXT NOT NULL,
                downloaded_at INTEGER NOT NULL
            )",
        )
        .expect("schema");
        conn
    }

    #[test]
    fn upsert_and_lookup_round_trip() {
        let (_dir, path) = open_temp_db();
        let conn = init_at(&path);
        let sha1 = "a".repeat(40);
        {
            let mut stmt = conn
                .prepare(
                    "INSERT INTO mod_file_bindings (sha1, source, project_slug, project_id, file_name, downloaded_at)
                     VALUES (?, ?, ?, ?, ?, ?)",
                )
                .unwrap();
            stmt.bind((1, sha1.as_str())).unwrap();
            stmt.bind((2, "modrinth")).unwrap();
            stmt.bind((3, "sodium")).unwrap();
            stmt.bind((4, "AABB")).unwrap();
            stmt.bind((5, "sodium.jar")).unwrap();
            stmt.bind((6, 1_i64)).unwrap();
            stmt.next().unwrap();
        }

        let mut stmt = conn
            .prepare(
                "SELECT source, project_slug, project_id FROM mod_file_bindings WHERE sha1 = ?",
            )
            .unwrap();
        stmt.bind((1, sha1.as_str())).unwrap();
        assert_eq!(stmt.next().unwrap(), State::Row);
        assert_eq!(stmt.read::<String, _>(0).unwrap(), "modrinth");
        assert_eq!(stmt.read::<String, _>(1).unwrap(), "sodium");
        assert_eq!(stmt.read::<String, _>(2).unwrap(), "AABB");
    }

    #[test]
    fn normalize_sha1_lowercases() {
        assert_eq!(normalize_sha1("ABCD"), "abcd");
    }

    #[test]
    fn normalize_source_rejects_unknown() {
        assert!(normalize_source("mcmod").is_err());
        assert_eq!(normalize_source("Modrinth").unwrap(), "modrinth");
    }

}
