//! # harness-sessions
//!
//! T16 会话持久化：用 SQLite 存储历史会话，支持搜索 / 重命名 / 恢复。
//!
//! 数据模型：
//! - `sessions`：会话元数据（id / title / provider / model / cwd / 时间戳）。
//! - `messages`：会话内消息 `(session_id, seq, role, text, created_at)`，按 seq 有序，
//!   便于按序恢复对话与按内容搜索。
//!
//! `rusqlite` 以 `bundled` 特性把 SQLite 编译进来，避免依赖目标机系统库，离线可构建，
//! 契合 Windows 安装包（T17）的脱网要求。
//!
//! ## 安全提示
//!
//! 历史会话仅存于应用私有数据目录（由调用方指定路径），不写入仓库/命令行；消息按原样
//! 落库，供本地搜索与恢复，不上传三方。

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

/// 一条会话消息。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionMsg {
    pub seq: i64,
    pub role: String,
    pub text: String,
}

/// 会话元数据。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionMeta {
    pub id: String,
    pub title: String,
    pub provider: String,
    pub model: String,
    pub cwd: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 会话详情（元数据 + 完整消息）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionDetail {
    pub meta: SessionMeta,
    pub messages: Vec<SessionMsg>,
}

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("db: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("serialize: {0}")]
    Json(#[from] serde_json::Error),
    #[error("not found: {0}")]
    NotFound(String),
}

pub type Result<T> = std::result::Result<T, SessionError>;

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// SQLite 会话存储。
pub struct SessionStore {
    conn: Connection,
}

impl SessionStore {
    /// 打开（不存在则创建）`db_path` 并建表。
    pub fn open(db_path: impl AsRef<Path>) -> Result<Self> {
        if let Some(parent) = db_path.as_ref().parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(db_path)?;
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS sessions (
                id         TEXT PRIMARY KEY,
                title      TEXT NOT NULL DEFAULT '',
                provider   TEXT NOT NULL DEFAULT '',
                model      TEXT NOT NULL DEFAULT '',
                cwd        TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS messages (
                session_id TEXT NOT NULL,
                seq        INTEGER NOT NULL,
                role       TEXT NOT NULL,
                text       TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL,
                PRIMARY KEY (session_id, seq),
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_messages_text ON messages(text);
            CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);
            "#,
        )?;
        Ok(Self { conn })
    }

    /// 新建一个会话（已存在则忽略并返回 false）。
    pub fn create_session(
        &mut self,
        id: &str,
        title: &str,
        provider: &str,
        model: &str,
        cwd: &str,
    ) -> Result<bool> {
        let t = now();
        let n = self.conn.execute(
            "INSERT OR IGNORE INTO sessions (id, title, provider, model, cwd, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, title, provider, model, cwd, t, t],
        )?;
        Ok(n > 0)
    }

    /// 向会话追加一条消息（seq 自动按现有条数续）。
    pub fn append_message(&mut self, session_id: &str, role: &str, text: &str) -> Result<i64> {
        let seq: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM messages WHERE session_id = ?1",
            params![session_id],
            |r| r.get(0),
        )?;
        self.conn.execute(
            "INSERT INTO messages (session_id, seq, role, text, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![session_id, seq, role, text, now()],
        )?;
        self.touch(session_id)?;
        Ok(seq)
    }

    /// 覆写某条消息文本（用于流式增量汇聚后的最终落盘）。
    pub fn upsert_message(&mut self, session_id: &str, seq: i64, role: &str, text: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO messages (session_id, seq, role, text, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(session_id, seq) DO UPDATE SET text = excluded.text, role = excluded.role",
            params![session_id, seq, role, text, now()],
        )?;
        self.touch(session_id)?;
        Ok(())
    }

    fn touch(&mut self, session_id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE sessions SET updated_at = ?1 WHERE id = ?2",
            params![now(), session_id],
        )?;
        Ok(())
    }

    /// 重命名会话标题。
    pub fn rename(&mut self, session_id: &str, title: &str) -> Result<()> {
        let n = self.conn.execute(
            "UPDATE sessions SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![title, now(), session_id],
        )?;
        if n == 0 {
            return Err(SessionError::NotFound(session_id.to_string()));
        }
        Ok(())
    }

    /// 更新会话使用的 provider / model。
    pub fn set_provider_model(
        &mut self,
        session_id: &str,
        provider: &str,
        model: &str,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE sessions SET provider = ?1, model = ?2, updated_at = ?3 WHERE id = ?4",
            params![provider, model, now(), session_id],
        )?;
        Ok(())
    }

    /// 列出全部会话元数据，按最近更新倒序。
    pub fn list_sessions(&self) -> Result<Vec<SessionMeta>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, title, provider, model, cwd, created_at, updated_at FROM sessions ORDER BY updated_at DESC")?;
        let rows = stmt.query_map([], |r| {
            Ok(SessionMeta {
                id: r.get(0)?,
                title: r.get(1)?,
                provider: r.get(2)?,
                model: r.get(3)?,
                cwd: r.get(4)?,
                created_at: r.get(5)?,
                updated_at: r.get(6)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// 搜索会话：按标题或消息内容关键词匹配。
    pub fn search_sessions(&self, keyword: &str) -> Result<Vec<SessionMeta>> {
        let like = format!("%{}%", keyword);
        let mut stmt = self.conn.prepare(
            "SELECT DISTINCT s.id, s.title, s.provider, s.model, s.cwd, s.created_at, s.updated_at
             FROM sessions s
             LEFT JOIN messages m ON m.session_id = s.id
             WHERE s.title LIKE ?1 OR m.text LIKE ?1
             ORDER BY s.updated_at DESC",
        )?;
        let rows = stmt.query_map([&like], |r| {
            Ok(SessionMeta {
                id: r.get(0)?,
                title: r.get(1)?,
                provider: r.get(2)?,
                model: r.get(3)?,
                cwd: r.get(4)?,
                created_at: r.get(5)?,
                updated_at: r.get(6)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// 读取会话详情（含按序消息），用于恢复对话。
    pub fn get_session(&self, session_id: &str) -> Result<SessionDetail> {
        let meta = self
            .conn
            .query_row(
                "SELECT id, title, provider, model, cwd, created_at, updated_at FROM sessions WHERE id = ?1",
                params![session_id],
                |r| {
                    Ok(SessionMeta {
                        id: r.get(0)?,
                        title: r.get(1)?,
                        provider: r.get(2)?,
                        model: r.get(3)?,
                        cwd: r.get(4)?,
                        created_at: r.get(5)?,
                        updated_at: r.get(6)?,
                    })
                },
            )
            .map_err(|_| SessionError::NotFound(session_id.to_string()))?;
        let mut stmt = self.conn.prepare(
            "SELECT seq, role, text FROM messages WHERE session_id = ?1 ORDER BY seq ASC",
        )?;
        let rows = stmt.query_map(params![session_id], |r| {
            Ok(SessionMsg {
                seq: r.get(0)?,
                role: r.get(1)?,
                text: r.get(2)?,
            })
        })?;
        let mut messages = Vec::new();
        for row in rows {
            messages.push(row?);
        }
        Ok(SessionDetail { meta, messages })
    }

    /// 删除会话（连带消息）。
    pub fn delete_session(&mut self, session_id: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM sessions WHERE id = ?1", params![session_id])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_db(name: &str) -> String {
        let dir = std::env::temp_dir().join(format!("harness-sess-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        format!("{}/{name}.sqlite", dir.display())
    }

    #[test]
    fn roundtrip_crud() {
        let mut s = SessionStore::open(tmp_db("a")).unwrap();
        s.create_session("s1", "hello", "openai", "gpt-4.1", "/ws").unwrap();
        // 重复建同 id -> false
        assert!(!s.create_session("s1", "dup", "", "", "").unwrap());

        s.append_message("s1", "user", "hi").unwrap();
        s.append_message("s1", "assistant", "hello there").unwrap();
        s.upsert_message("s1", 0, "user", "hi-updated").unwrap();

        let d = s.get_session("s1").unwrap();
        assert_eq!(d.messages.len(), 2);
        assert_eq!(d.messages[0].text, "hi-updated");
        assert_eq!(d.messages[1].role, "assistant");
        assert_eq!(d.meta.title, "hello");

        // 搜索按内容命中
        let hits = s.search_sessions("there").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "s1");

        // 列表
        let all = s.list_sessions().unwrap();
        assert_eq!(all.len(), 1);

        // 重命名
        s.rename("s1", "renamed").unwrap();
        assert_eq!(s.get_session("s1").unwrap().meta.title, "renamed");

        // 删除
        s.delete_session("s1").unwrap();
        assert!(s.get_session("s1").is_err());
        assert!(s.list_sessions().unwrap().is_empty());
    }

    #[test]
    fn rename_missing_errors() {
        let mut s = SessionStore::open(tmp_db("b")).unwrap();
        assert!(matches!(s.rename("nope", "x"), Err(SessionError::NotFound(_))));
    }

    #[test]
    fn search_matches_title() {
        let mut s = SessionStore::open(tmp_db("c")).unwrap();
        s.create_session("x", "feature work", "mock", "m", "/").unwrap();
        assert_eq!(s.search_sessions("feature").unwrap().len(), 1);
        assert!(s.search_sessions("nothing-here").unwrap().is_empty());
    }
}