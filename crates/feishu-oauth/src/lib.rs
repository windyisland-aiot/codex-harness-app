//! T13 飞书 OAuth：`app_access_token` / `user_access_token` 获取、授权码换取、刷新。
//!
//! ## 飞书 OAuth 流程
//!
//! 1. `app_access_token`：应用身份令牌，凭 `app_id` + `app_secret` 换取，用于调用
//!    ISV / 企业自建应用内部接口。见 [`FeishuOAuth::app_access_token`]。
//! 2. 用户授权（OAuth 2.0 authorization code）：
//!    - [`FeishuOAuth::authorize_url`] 生成授权页 URL（用户扫码/点击同意）；
//!    - 授权回调携带 `code`，用 [`FeishuOAuth::exchange_code`] 换取 `user_access_token`
//!      与 `refresh_token`；
//!    - token 即将过期时用 [`FeishuOAuth::refresh`] 刷新，避免重新授权。
//!
//! 本 crate 通过可注入的 `base_url` 保持对飞书正式/沙箱环境的兼容，也可在单测中
//! 指向本地 mock HTTP 服务，便于在不触网的情况下验证协议逻辑。

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::json;

/// 飞书开放平台授权域名常量。
pub const FEISHU_OPEN_BASE: &str = "https://open.feishu.cn";
/// 授权页域名常量。
pub const FEISHU_AUTH_BASE: &str = "https://accounts.feishu.cn";

/// OAuth 客户端配置。
#[derive(Debug, Clone)]
pub struct FeishuOAuthConfig {
    /// 应用 app_id。
    pub app_id: String,
    /// 应用 app_secret。
    pub app_secret: String,
    /// 授权回调 redirect_uri（可选，部分应用无需）。
    pub redirect_uri: String,
    /// API 基础地址（默认 `https://open.feishu.cn`），测试可指向 `http://127.0.0.1:PORT`。
    pub base_url: String,
    /// 授权页基础地址（默认 `https://accounts.feishu.cn`）。
    pub auth_base_url: String,
    /// HTTP 超时（默认 15s）。
    pub timeout: Duration,
}

impl Default for FeishuOAuthConfig {
    fn default() -> Self {
        Self {
            app_id: String::new(),
            app_secret: String::new(),
            redirect_uri: String::new(),
            base_url: FEISHU_OPEN_BASE.to_string(),
            auth_base_url: FEISHU_AUTH_BASE.to_string(),
            timeout: Duration::from_secs(15),
        }
    }
}

impl FeishuOAuthConfig {
    /// 用 app_id/app_secret 构造，采用飞书生产环境默认地址。
    pub fn new(app_id: impl Into<String>, app_secret: impl Into<String>) -> Self {
        Self {
            app_id: app_id.into(),
            app_secret: app_secret.into(),
            ..Self::default()
        }
    }
}

/// `POST /open-apis/auth/v3/app_access_token/internal` 响应。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppAccessToken {
    pub code: i64,
    pub msg: String,
    #[serde(rename = "app_access_token", default)]
    pub token: String,
    /// 有效期（秒）。
    #[serde(rename = "expire", default)]
    pub expire: i64,
}

/// OIDC token 响应（授权码换取 / 刷新共用字段）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserAccessToken {
    /// 状态码，0 表示成功。
    pub code: i64,
    pub msg: String,
    #[serde(rename = "access_token", default)]
    pub access_token: String,
    #[serde(rename = "refresh_token", default)]
    pub refresh_token: String,
    /// 有效期（秒）。
    #[serde(rename = "expires_in", default)]
    pub expires_in: i64,
    /// 可选：token 类型，通常 "Bearer"。
    #[serde(rename = "token_type", default)]
    pub token_type: String,
    /// 可选：授权作用域。
    #[serde(default)]
    pub scope: String,
}

/// 换取到的 token 视图（带本地过期时间戳，便于自动刷新判断）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenBundle {
    pub access_token: String,
    pub refresh_token: String,
    pub token_type: String,
    pub scope: String,
    /// 过期绝对时间（Unix 秒）。`i64::MAX` 表示未知/不过期。
    pub exp_ts: i64,
}

impl TokenBundle {
    /// 距过期是否不足 `margin` 秒（用于提前刷新）。
    pub fn expiring_within(&self, now_ts: i64, margin: i64) -> bool {
        self.exp_ts != i64::MAX && self.exp_ts - now_ts < margin
    }
}

fn now_ts() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn to_bundle(resp: &UserAccessToken) -> (TokenBundle, bool) {
    if resp.code == 0 && !resp.access_token.is_empty() {
        let exp_ts = if resp.expires_in > 0 {
            now_ts() + resp.expires_in
        } else {
            i64::MAX
        };
        (
            TokenBundle {
                access_token: resp.access_token.clone(),
                refresh_token: resp.refresh_token.clone(),
                token_type: if resp.token_type.is_empty() {
                    "Bearer".into()
                } else {
                    resp.token_type.clone()
                },
                scope: resp.scope.clone(),
                exp_ts,
            },
            true,
        )
    } else {
        (
            TokenBundle {
                access_token: String::new(),
                refresh_token: String::new(),
                token_type: String::new(),
                scope: String::new(),
                exp_ts: 0,
            },
            false,
        )
    }
}

/// 飞书 OAuth 客户端。
#[derive(Debug, Clone)]
pub struct FeishuOAuth {
    pub config: FeishuOAuthConfig,
    agent: ureq::Agent,
}

/// 结构化的 OAuth 错误。
#[derive(Debug, Clone)]
pub enum OAuthError {
    /// HTTP / 传输层错误。
    Transport(String),
    /// 飞书接口返回的业务错误（code != 0）。
    Api { code: i64, msg: String },
}

impl std::fmt::Display for OAuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OAuthError::Transport(e) => write!(f, "transport: {e}"),
            OAuthError::Api { code, msg } => write!(f, "feishu api error ({code}): {msg}"),
        }
    }
}

impl std::error::Error for OAuthError {}

impl FeishuOAuth {
    /// 用配置构造客户端。
    pub fn new(config: FeishuOAuthConfig) -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout(config.timeout)
            .build();
        Self { config, agent }
    }

    fn api_url(&self, path: &str) -> String {
        format!("{}{}", self.config.base_url.trim_end_matches('/'), path)
    }

    /// 1) 获取 `app_access_token`（应用身份令牌）。
    pub fn app_access_token(&self) -> Result<AppAccessToken, OAuthError> {
        let body = json!({
            "app_id": self.config.app_id,
            "app_secret": self.config.app_secret,
        });
        let resp = self
            .agent
            .post(&self.api_url("/open-apis/auth/v3/app_access_token/internal"))
            .send_json(body)
            .map_err(|e| OAuthError::Transport(e.to_string()))?;
        let parsed: AppAccessToken = resp
            .into_json()
            .map_err(|e| OAuthError::Transport(format!("parse json: {e}")))?;
        if parsed.code != 0 {
            return Err(OAuthError::Api { code: parsed.code, msg: parsed.msg });
        }
        Ok(parsed)
    }

    /// 2a) 生成用户授权页 URL。`state` 用于回调校验（建议随机）。
    pub fn authorize_url(&self, state: &str) -> String {
        let base = self.config.auth_base_url.trim_end_matches('/');
        let mut q = format!(
            "app_id={}&redirect_uri={}&state={}&response_type=code&scope={}",
            percent(&self.config.app_id),
            percent(&self.config.redirect_uri),
            percent(state),
            percent("contact:user.base:readonly,im:message"),
        );
        if self.config.redirect_uri.is_empty() {
            q.push_str("&no_skip_approve=1");
        }
        format!("{base}/open-apis/authen/v1/authorize?{q}")
    }

    /// 2b) 用授权码 `code` 换取 `user_access_token` + `refresh_token`。
    pub fn exchange_code(&self, code: &str) -> Result<TokenBundle, OAuthError> {
        let body = json!({
            "grant_type": "authorization_code",
            "client_id": self.config.app_id,
            "client_secret": self.config.app_secret,
            "code": code,
            "redirect_uri": self.config.redirect_uri,
        });
        let resp = self
            .agent
            .post(&self.api_url("/open-apis/authen/v1/oidc/access_token"))
            .send_json(body)
            .map_err(|e| OAuthError::Transport(e.to_string()))?;
        let parsed: UserAccessToken = resp
            .into_json()
            .map_err(|e| OAuthError::Transport(format!("parse json: {e}")))?;
        let (bundle, ok) = to_bundle(&parsed);
        if !ok {
            return Err(OAuthError::Api { code: parsed.code, msg: parsed.msg });
        }
        Ok(bundle)
    }

    /// 2c) 用 `refresh_token` 刷新 `user_access_token`。成功会返回新的 refresh_token。
    pub fn refresh(&self, refresh_token: &str) -> Result<TokenBundle, OAuthError> {
        let body = json!({
            "grant_type": "refresh_token",
            "client_id": self.config.app_id,
            "client_secret": self.config.app_secret,
            "refresh_token": refresh_token,
        });
        let resp = self
            .agent
            .post(&self.api_url("/open-apis/authen/v1/oidc/refresh_access_token"))
            .send_json(body)
            .map_err(|e| OAuthError::Transport(e.to_string()))?;
        let parsed: UserAccessToken = resp
            .into_json()
            .map_err(|e| OAuthError::Transport(format!("parse json: {e}")))?;
        let (bundle, ok) = to_bundle(&parsed);
        if !ok {
            return Err(OAuthError::Api { code: parsed.code, msg: parsed.msg });
        }
        Ok(bundle)
    }
}

/// 简易百分比编码（仅编码非安全字符），用于拼授权 URL 查询参数。
fn percent(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push('%');
                out.push_str(&format!("{:02X}", b));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    use super::*;

    /// 极简 mock HTTP 服务：读请求（解析头部与 Content-Length 长度 body），返回预设 JSON。
    fn spawn_mock(handler: impl Fn(&str) -> (u16, String) + Send + 'static) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            for stream in listener.incoming() {
                if let Ok(mut s) = stream {
                    // 逐行读请求行 + 头部直到空行，再按 Content-Length 读 body。
                    let mut head = Vec::new();
                    let mut one = [0u8; 1];
                    while !head.ends_with(b"\r\n\r\n") {
                        if s.read(&mut one).unwrap_or(0) == 0 {
                            return;
                        }
                        head.push(one[0]);
                    }
                    let head_str = String::from_utf8_lossy(&head).to_string();
                    let content_len = head_str
                        .lines()
                        .find_map(|l| {
                            l.split(':')
                                .next()
                                .filter(|k| k.eq_ignore_ascii_case("content-length"))
                                .and_then(|_| {
                                    l.split_once(':').and_then(|(_, v)| {
                                        v.trim().parse::<usize>().ok()
                                    })
                                })
                        })
                        .unwrap_or(0);
                    let mut body = vec![0u8; content_len];
                    if content_len > 0 {
                        let mut read = 0;
                        while read < content_len {
                            let n = s.read(&mut body[read..]).unwrap_or(0);
                            if n == 0 {
                                break;
                            }
                            read += n;
                        }
                    }
                    let body_str = String::from_utf8_lossy(&body).to_string();
                    let (code, resp_body) = handler(&format!("{head_str}\n{body_str}"));
                    let resp = format!(
                        "HTTP/1.1 {code} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{resp_body}",
                        resp_body.len()
                    );
                    let _ = s.write_all(resp.as_bytes());
                }
            }
        });
        port
    }

    #[test]
    fn app_access_token_success() {
        let port = spawn_mock(|req| {
            assert!(req.contains("app_access_token/internal"));
            (200, r#"{"code":0,"msg":"ok","app_access_token":"aAppTok","expire":7200}"#.into())
        });
        let cfg = FeishuOAuthConfig {
            app_id: "cli_test".into(),
            app_secret: "secret".into(),
            base_url: format!("http://127.0.0.1:{port}"),
            auth_base_url: "http://127.0.0.1:9999".into(),
            ..Default::default()
        };
        let client = FeishuOAuth::new(cfg);
        let tok = client.app_access_token().unwrap();
        assert_eq!(tok.token, "aAppTok");
        assert_eq!(tok.code, 0);
    }

    #[test]
    fn app_access_token_api_error() {
        let port = spawn_mock(|_| (200, r#"{"code":99991663,"msg":"app not found"}"#.into()));
        let cfg = FeishuOAuthConfig {
            app_id: "bad".into(),
            app_secret: "x".into(),
            base_url: format!("http://127.0.0.1:{port}"),
            ..Default::default()
        };
        match FeishuOAuth::new(cfg).app_access_token() {
            Err(OAuthError::Api { code, .. }) => assert_eq!(code, 99991663),
            other => panic!("expected api error, got {other:?}"),
        }
    }

    #[test]
    fn exchange_code_returns_bundle_with_expiry() {
        let port = spawn_mock(|req| {
            assert!(req.contains("oidc/access_token"));
            assert!(req.contains("authorization_code"));
            (
                200,
                r#"{"code":0,"msg":"ok","access_token":"uTok","refresh_token":"rTok","expires_in":7200,"scope":"im:message"}"#.into(),
            )
        });
        let before = now_ts();
        let cfg = FeishuOAuthConfig {
            app_id: "app".into(),
            app_secret: "s".into(),
            base_url: format!("http://127.0.0.1:{port}"),
            ..Default::default()
        };
        let b = FeishuOAuth::new(cfg).exchange_code("authcode123").unwrap();
        assert_eq!(b.access_token, "uTok");
        assert_eq!(b.refresh_token, "rTok");
        assert_eq!(b.token_type, "Bearer");
        assert!(b.exp_ts >= before + 7200 - 2 && b.exp_ts <= before + 7200 + 2);
        assert!(!b.expiring_within(before, 60), "不应提前过期");
        assert!(b.expiring_within(b.exp_ts - 5, 60), "临近过期应触发刷新");
    }

    #[test]
    fn refresh_token_rotates_and_rejects_bad() {
        let good_port = spawn_mock(|req| {
            assert!(req.contains("refresh_access_token"));
            (
                200,
                r#"{"code":0,"msg":"ok","access_token":"newTok","refresh_token":"newRef","expires_in":3600}"#.into(),
            )
        });
        let cfg = FeishuOAuthConfig {
            app_id: "app".into(),
            app_secret: "s".into(),
            base_url: format!("http://127.0.0.1:{good_port}"),
            ..Default::default()
        };
        let c = FeishuOAuth::new(cfg);
        let b = c.refresh("oldRef").unwrap();
        assert_eq!(b.access_token, "newTok");
        assert_eq!(b.refresh_token, "newRef");

        let bad_port = spawn_mock(|_| (200, r#"{"code":99991742,"msg":"refresh token invalid"}"#.into()));
        let cfg2 = FeishuOAuthConfig {
            base_url: format!("http://127.0.0.1:{bad_port}"),
            ..Default::default()
        };
        match FeishuOAuth::new(cfg2).refresh("dead") {
            Err(OAuthError::Api { code, .. }) => assert_eq!(code, 99991742),
            other => panic!("expected api error, got {other:?}"),
        }
    }

    #[test]
    fn authorize_url_encodes_params_and_scope() {
        let cfg = FeishuOAuthConfig {
            app_id: "cli a/b".into(),
            app_secret: "s".into(),
            redirect_uri: "https://example.com/cb?from=app".into(),
            ..Default::default()
        };
        let url = FeishuOAuth::new(cfg).authorize_url("st flo");
        assert!(url.starts_with("https://accounts.feishu.cn/open-apis/authen/v1/authorize?"));
        assert!(url.contains("app_id=cli%20a%2Fb"), "{url}");
        assert!(url.contains("redirect_uri=https%3A%2F%2Fexample.com%2Fcb%3Ffrom%3Dapp"), "{url}");
        assert!(url.contains("state=st%20flo"), "{url}");
        assert!(url.contains("response_type=code"), "{url}");
    }
}