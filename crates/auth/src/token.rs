//! 会话 token：签发随机令牌，落库存其 SHA-256 摘要。

use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha256};

/// 返回给客户端的原始会话 token（临时）。
pub(crate) fn generate_raw_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 落库用 token 摘要：`sha256(raw_token)`。
pub(crate) fn hash_token(raw: &str) -> String {
    let digest = Sha256::digest(raw.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}