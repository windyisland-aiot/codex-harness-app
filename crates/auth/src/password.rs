//! 密码哈希与校验（Argon2id）与口令相关安全策略。

use argon2::password_hash::{rand_core::RngCore, SaltString};
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use rand_core::OsRng;
use zeroize::Zeroizing;

use crate::error::AuthError;

const MIN_PASSWORD_LEN: usize = 8;

/// 校验密码强度（企业应用最少 8 位，至少包含字母与数字）。
fn validate_strength(password: &str) -> Result<(), AuthError> {
    if password.len() < MIN_PASSWORD_LEN {
        return Err(AuthError::WeakPassword {
            reason: format!("至少 {} 个字符", MIN_PASSWORD_LEN),
        });
    }
    let has_alpha = password.chars().any(|c| c.is_alphabetic());
    let has_digit = password.chars().any(|c| c.is_ascii_digit());
    if !(has_alpha && has_digit) {
        return Err(AuthError::WeakPassword {
            reason: "需同时包含字母与数字".to_string(),
        });
    }
    Ok(())
}

/// 用 Argon2id 对密码生成 PHC 格式哈希。
pub(crate) fn hash_password(password: &str) -> Result<String, AuthError> {
    validate_strength(password)?;
    let zeroized = Zeroizing::new(password.to_owned());
    let mut salt_bytes = [0u8; 16];
    OsRng.fill_bytes(&mut salt_bytes);
    // 使用随机字节构造 SaltString，避免对 Argon2 默认实现的依赖差异。
    let salt = SaltString::encode_b64(&salt_bytes)
        .map_err(|e| AuthError::Internal(format!("salt b64: {e}")))?;
    let argon2 = Argon2::default();
    let hash = argon2
        .hash_password(zeroized.as_bytes(), &salt)
        .map_err(|e| AuthError::Internal(format!("hash: {e}")))?
        .to_string();
    Ok(hash)
}

/// 校验密码与存储哈希是否匹配（常数时间）。
pub(crate) fn verify_password(password: &str, stored_hash: &str) -> Result<(), AuthError> {
    let zeroized = Zeroizing::new(password.to_owned());
    let parsed = PasswordHash::new(stored_hash)
        .map_err(|e| AuthError::Internal(format!("bad hash format: {e}")))?;
    Argon2::default()
        .verify_password(zeroized.as_bytes(), &parsed)
        .map_err(|_| AuthError::InvalidCredentials)
}