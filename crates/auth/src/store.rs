//! 用户 / 会话存储抽象与两种实现：内存（测试）与 JSON 文件（本地持久化）。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::error::AuthError;

/// 用户角色。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UserRole {
    /// 管理员：可建号、停用账号。
    Admin,
    /// 普通员工。
    User,
    /// 只读/访客。
    Viewer,
}

/// 持久化的用户记录。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UserRecord {
    pub username: String,
    pub display_name: String,
    pub role: UserRole,
    /// Argon2id 的 PHC 格式哈希。
    pub password_hash: String,
    pub created_at_ms: u64,
    pub disabled: bool,
    /// 连续失败次数（用于限流）。
    pub failed_attempts: u32,
    /// 锁定截止毫秒（0 = 未锁定）。
    pub locked_until_ms: u64,
}

/// 持久化的会话记录。注意：**只存 token 摘要，绝不存原始 token**。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionRecord {
    pub token_hash: String,
    pub username: String,
    pub created_at_ms: u64,
    pub expires_at_ms: u64,
}

/// 存储接口。为便于测试与后续无缝替换为 SQLite，全部方法均为确定性同步接口。
pub trait UserStore: Send + Sync {
    fn get_user(&self, username: &str) -> Result<Option<UserRecord>, AuthError>;
    fn put_user(&self, user: &UserRecord) -> Result<(), AuthError>;
    fn remove_user(&self, username: &str) -> Result<(), AuthError>;
    fn list_users(&self) -> Result<Vec<UserRecord>, AuthError>;

    fn get_session(&self, token_hash: &str) -> Result<Option<SessionRecord>, AuthError>;
    fn put_session(&self, rec: &SessionRecord) -> Result<(), AuthError>;
    fn remove_session(&self, token_hash: &str) -> Result<(), AuthError>;
    fn remove_sessions_for_user(&self, username: &str) -> Result<(), AuthError>;
}

struct Shared {
    users: HashMap<String, UserRecord>,
    sessions: HashMap<String, SessionRecord>,
}

/// 内存实现（测试/快速启动）。多线程安全。
pub struct MemoryStore {
    inner: Arc<Mutex<Shared>>,
}

impl MemoryStore {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Shared {
                users: HashMap::new(),
                sessions: HashMap::new(),
            })),
        }
    }
}

impl Default for MemoryStore {
    fn default() -> Self {
        Self::new()
    }
}

impl UserStore for MemoryStore {
    fn get_user(&self, username: &str) -> Result<Option<UserRecord>, AuthError> {
        Ok(self.inner.lock().unwrap().users.get(username).cloned())
    }
    fn put_user(&self, user: &UserRecord) -> Result<(), AuthError> {
        self.inner
            .lock()
            .unwrap()
            .users
            .insert(user.username.clone(), user.clone());
        Ok(())
    }
    fn remove_user(&self, username: &str) -> Result<(), AuthError> {
        self.inner.lock().unwrap().users.remove(username);
        Ok(())
    }
    fn list_users(&self) -> Result<Vec<UserRecord>, AuthError> {
        Ok(self
            .inner
            .lock()
            .unwrap()
            .users
            .values()
            .cloned()
            .collect())
    }
    fn get_session(&self, token_hash: &str) -> Result<Option<SessionRecord>, AuthError> {
        Ok(self.inner.lock().unwrap().sessions.get(token_hash).cloned())
    }
    fn put_session(&self, rec: &SessionRecord) -> Result<(), AuthError> {
        self.inner
            .lock()
            .unwrap()
            .sessions
            .insert(rec.token_hash.clone(), rec.clone());
        Ok(())
    }
    fn remove_session(&self, token_hash: &str) -> Result<(), AuthError> {
        self.inner.lock().unwrap().sessions.remove(token_hash);
        Ok(())
    }
    fn remove_sessions_for_user(&self, username: &str) -> Result<(), AuthError> {
        self.inner
            .lock()
            .unwrap()
            .sessions
            .retain(|_, s| s.username != username);
        Ok(())
    }
}

/// JSON 文件实现。原子写（写临时文件后 rename）。
pub struct FileStore {
    inner: Arc<Mutex<Shared>>,
    path: PathBuf,
}

impl FileStore {
    pub fn new(path: impl Into<PathBuf>) -> Result<Self, AuthError> {
        let path = path.into();
        let shared = Shared {
            users: HashMap::new(),
            sessions: HashMap::new(),
        };
        let store = FileStore {
            inner: Arc::new(Mutex::new(shared)),
            path,
        };
        store.reload()?;
        Ok(store)
    }

    fn reload(&self) -> Result<(), AuthError> {
        if !self.path.exists() {
            self.flush()?;
            return Ok(());
        }
        let data = std::fs::read_to_string(&self.path)
            .map_err(|e| AuthError::Store(format!("read: {e}")))?;
        if data.trim().is_empty() {
            return Ok(());
        }
        let persisted: Persisted =
            serde_json::from_str(&data).map_err(|e| AuthError::Store(format!("parse: {e}")))?;
        let mut guard = self.inner.lock().unwrap();
        guard.users = persisted.users;
        guard.sessions = persisted.sessions;
        Ok(())
    }

    fn flush(&self) -> Result<(), AuthError> {
        let guard = self.inner.lock().unwrap();
        let persisted = Persisted {
            users: guard.users.clone(),
            sessions: guard.sessions.clone(),
        };
        let json = serde_json::to_string_pretty(&persisted)
            .map_err(|e| AuthError::Store(format!("serialize: {e}")))?;
        drop(guard); // 释放锁后再写盘
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|e| AuthError::Store(format!("mkdir: {e}")))?;
        }
        // 原子写：先写临时文件再 rename。
        let tmp = self
            .path
            .with_extension(format!("tmp.{}.json", std::process::id()));
        std::fs::write(&tmp, json).map_err(|e| AuthError::Store(format!("write tmp: {e}")))?;
        std::fs::rename(&tmp, &self.path)
            .map_err(|e| AuthError::Store(format!("rename: {e}")))?;
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
struct Persisted {
    users: HashMap<String, UserRecord>,
    sessions: HashMap<String, SessionRecord>,
}

impl UserStore for FileStore {
    fn get_user(&self, username: &str) -> Result<Option<UserRecord>, AuthError> {
        Ok(self.inner.lock().unwrap().users.get(username).cloned())
    }
    fn put_user(&self, user: &UserRecord) -> Result<(), AuthError> {
        self.inner
            .lock()
            .unwrap()
            .users
            .insert(user.username.clone(), user.clone());
        self.flush()
    }
    fn remove_user(&self, username: &str) -> Result<(), AuthError> {
        self.inner.lock().unwrap().users.remove(username);
        self.flush()
    }
    fn list_users(&self) -> Result<Vec<UserRecord>, AuthError> {
        Ok(self
            .inner
            .lock()
            .unwrap()
            .users
            .values()
            .cloned()
            .collect())
    }
    fn get_session(&self, token_hash: &str) -> Result<Option<SessionRecord>, AuthError> {
        Ok(self.inner.lock().unwrap().sessions.get(token_hash).cloned())
    }
    fn put_session(&self, rec: &SessionRecord) -> Result<(), AuthError> {
        self.inner
            .lock()
            .unwrap()
            .sessions
            .insert(rec.token_hash.clone(), rec.clone());
        self.flush()
    }
    fn remove_session(&self, token_hash: &str) -> Result<(), AuthError> {
        self.inner.lock().unwrap().sessions.remove(token_hash);
        self.flush()
    }
    fn remove_sessions_for_user(&self, username: &str) -> Result<(), AuthError> {
        self.inner
            .lock()
            .unwrap()
            .sessions
            .retain(|_, s| s.username != username);
        self.flush()
    }
}