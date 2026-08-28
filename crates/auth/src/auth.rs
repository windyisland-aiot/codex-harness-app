//! 认证服务核心：注册、登录、会话校验/登出、改密、停用。

use std::sync::Arc;

use crate::error::AuthError;
use crate::password;
use crate::store::{SessionRecord, UserRecord, UserRole, UserStore};
use crate::token;

/// 认证服务配置。
#[derive(Clone, Copy, Debug)]
pub struct AuthConfig {
    /// 会话有效期（毫秒）。
    pub session_ttl_ms: u64,
    /// 触发锁定前的最大连续失败次数。
    pub max_failed_attempts: u32,
    /// 锁定时长（毫秒）。
    pub lockout_ms: u64,
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            session_ttl_ms: 8 * 60 * 60 * 1000, // 8 小时
            max_failed_attempts: 5,
            lockout_ms: 30 * 60 * 1000, // 30 分钟
        }
    }
}

/// 一次成功登录返回给客户端的会话。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Session {
    /// 原始 token（仅此一次返回给客户端，绝不落库）。
    pub raw_token: String,
    pub username: String,
    pub display_name: String,
    pub role: UserRole,
    pub created_at_ms: u64,
    pub expires_at_ms: u64,
}

/// 认证服务。
pub struct AuthService {
    store: Arc<dyn UserStore>,
    cfg: AuthConfig,
    /// 可注入的当前时间（毫秒），便于测试。
    now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
}

impl AuthService {
    pub fn new(store: Arc<dyn UserStore>, cfg: AuthConfig) -> Self {
        Self {
            store,
            cfg,
            now_ms: Arc::new(move || {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0)
            }),
        }
    }

    /// 测试用：注入时钟。
    #[doc(hidden)]
    pub fn with_clock(
        store: Arc<dyn UserStore>,
        cfg: AuthConfig,
        now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
    ) -> Self {
        Self {
            store,
            cfg,
            now_ms,
        }
    }

    fn now(&self) -> u64 {
        (self.now_ms)()
    }

    fn get_user_checked(&self, username: &str) -> Result<UserRecord, AuthError> {
        self.store
            .get_user(username)?
            .ok_or(AuthError::InvalidCredentials)
    }

    /// 注册账号（管理员建号）。密码强度校验见哈希模块。
    pub fn register(
        &self,
        username: &str,
        password: &str,
        display_name: &str,
        role: UserRole,
    ) -> Result<UserRecord, AuthError> {
        let username = username.trim().to_lowercase();
        if username.is_empty() {
            return Err(AuthError::WeakPassword {
                reason: "用户名为空".to_string(),
            });
        }
        if self.store.get_user(&username)?.is_some() {
            return Err(AuthError::UsernameTaken);
        }
        let hash = password::hash_password(password)?;
        let user = UserRecord {
            username,
            display_name: display_name.trim().to_string(),
            role,
            password_hash: hash,
            created_at_ms: self.now(),
            disabled: false,
            failed_attempts: 0,
            locked_until_ms: 0,
        };
        self.store.put_user(&user)?;
        Ok(user)
    }

    /// 账号密码登录。校验失败会累计计数并在超阈值后锁定。
    pub fn login(&self, username: &str, password: &str) -> Result<Session, AuthError> {
        let username = username.trim().to_lowercase();
        let mut user = match self.store.get_user(&username)? {
            Some(u) => u,
            None => {
                // 用户不存在也消耗一次攻击面，避免枚举账号。
                password::verify_password(password, &self.dummy_hash())?;
                return Err(AuthError::InvalidCredentials);
            }
        };

        let now = self.now();
        if user.locked_until_ms > now {
            return Err(AuthError::RateLimited {
                retry_after_secs: (user.locked_until_ms - now) / 1000,
            });
        }
        if user.disabled {
            return Err(AuthError::UserDisabled);
        }

        match password::verify_password(password, &user.password_hash) {
            Ok(()) => {
                user.failed_attempts = 0;
                user.locked_until_ms = 0;
                self.store.put_user(&user)?;
                self.issue_session(&user)
            }
            Err(_) => {
                user.failed_attempts += 1;
                if user.failed_attempts >= self.cfg.max_failed_attempts {
                    user.locked_until_ms = now + self.cfg.lockout_ms;
                    user.failed_attempts = 0;
                }
                self.store.put_user(&user)?;
                Err(AuthError::InvalidCredentials)
            }
        }
    }

    /// 签发会话并落库存 token 摘要。
    fn issue_session(&self, user: &UserRecord) -> Result<Session, AuthError> {
        let now = self.now();
        let raw = token::generate_raw_token();
        let hash = token::hash_token(&raw);
        let expires = now + self.cfg.session_ttl_ms;
        self.store.put_session(&SessionRecord {
            token_hash: hash,
            username: user.username.clone(),
            created_at_ms: now,
            expires_at_ms: expires,
        })?;
        Ok(Session {
            raw_token: raw,
            username: user.username.clone(),
            display_name: user.display_name.clone(),
            role: user.role,
            created_at_ms: now,
            expires_at_ms: expires,
        })
    }

    /// 校验会话 token，返回对应用户。过期会顺手吊销该会话。
    pub fn validate_session(&self, raw_token: &str) -> Result<UserRecord, AuthError> {
        let hash = token::hash_token(raw_token);
        let rec = self
            .store
            .get_session(&hash)?
            .ok_or(AuthError::InvalidToken)?;
        if rec.expires_at_ms <= self.now() {
            self.store.remove_session(&hash)?;
            return Err(AuthError::SessionExpired);
        }
        let user = self
            .store
            .get_user(&rec.username)?
            .ok_or(AuthError::InvalidToken)?;
        if user.disabled {
            return Err(AuthError::UserDisabled);
        }
        Ok(user)
    }

    /// 登出：吊销该 token 对应的会话。
    pub fn logout(&self, raw_token: &str) -> Result<(), AuthError> {
        let hash = token::hash_token(raw_token);
        self.store.remove_session(&hash)
    }

    /// 修改密码。成功后吊销该用户全部现存会话。
    pub fn change_password(
        &self,
        username: &str,
        old_password: &str,
        new_password: &str,
    ) -> Result<(), AuthError> {
        let username = username.trim().to_lowercase();
        let mut user = self.get_user_checked(&username)?;
        if user.disabled {
            return Err(AuthError::UserDisabled);
        }
        password::verify_password(old_password, &user.password_hash)?;
        let new_hash = password::hash_password(new_password)?;
        user.password_hash = new_hash;
        self.store.put_user(&user)?;
        // 改密后吊销所有存量会话，重新登录。
        self.store.remove_sessions_for_user(&username)
    }

    /// 管理员：停用 / 启用账号。停用同时吊销其全部会话。
    pub fn set_user_disabled(&self, username: &str, disabled: bool) -> Result<(), AuthError> {
        let username = username.trim().to_lowercase();
        let mut user = self
            .store
            .get_user(&username)?
            .ok_or(AuthError::UnknownUser)?;
        user.disabled = disabled;
        self.store.put_user(&user)?;
        if disabled {
            self.store.remove_sessions_for_user(&username)?;
        }
        Ok(())
    }

    fn dummy_hash(&self) -> String {
        // 固定哈希，用于等时对比、避免账号枚举。
        "$argon2id$v=19$m=19456,t=2,p=1$aaaaaaaaaaaaaaaa$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string()
    }
}