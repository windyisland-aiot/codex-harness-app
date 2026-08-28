//! # harness-auth
//!
//! 企业内部 Agent 桌面应用的 **应用级账号/口令登录** 模块（T02）。
//!
//! 职责（与多模型/飞书等工具凭据**完全分离** —— 本模块只负责账号口令、会话 token，
//! 不读写 codex 的 `config.toml`）：
//! - 账号注册（管理员建号或首启建号）
//! - 密码校验与登录（Argon2id 哈希、防爆破限流）
//! - 会话 token 签发 / 校验 / 登出（token 落库时只存其 SHA-256 摘要）
//! - 改密（改完吊销其全部现存会话）
//! - 会话过期 / 用户停用
//!
//! 存储抽象为 [`UserStore`]，内置 [`MemoryStore`]（内存，快速测试）与
//! [`FileStore`]（JSON 文件持久化）。后续可无损替换为 SQLite（T16 会话持久化）。

mod auth;
mod error;
mod password;
mod store;
mod token;

pub use auth::{AuthConfig, AuthService, Session};
pub use error::AuthError;
pub use store::{FileStore, MemoryStore, SessionRecord, UserRecord, UserRole, UserStore};