use thiserror::Error;

/// 认证模块统一错误类型。
#[derive(Error, Debug, Clone, PartialEq, Eq)]
pub enum AuthError {
    #[error("用户名已存在")]
    UsernameTaken,
    #[error("用户名或密码错误")]
    InvalidCredentials,
    #[error("用户不存在")]
    UnknownUser,
    #[error("用户已被停用")]
    UserDisabled,
    #[error("会话无效")]
    InvalidToken,
    #[error("会话已过期")]
    SessionExpired,
    /// 登录失败次数过多触发限流锁定。
    #[error("登录尝试过多，请 {retry_after_secs}s 后重试")]
    RateLimited { retry_after_secs: u64 },
    /// 密码强度不足。
    #[error("密码强度不足：{reason}")]
    WeakPassword { reason: String },
    #[error("旧密码不正确")]
    WrongPassword,
    #[error("存储错误：{0}")]
    Store(String),
    #[error("内部错误：{0}")]
    Internal(String),
}