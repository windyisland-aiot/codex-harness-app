//! T13 飞书 OAuth：把 `app_access_token` / `user_access_token` 授权换取与刷新封装成 Tauri 命令。
//!
//! 承载完整生命周期：
//! - `feishu_oauth_app_token`：取 `app_access_token`（校验 app_id/secret 是否正确）。
//! - `feishu_oauth_authorize_url`：生成用户在浏览器打开的授权页 URL。
//! - `feishu_oauth_exchange`：用回调 `code` 换取 `user_access_token` + `refresh_token`。
//! - `feishu_oauth_refresh`：用 `refresh_token` 刷新，返回滚动后的新 token。
//!
//! 命令均为无状态（token 由前端/宿主持有），保持了与 `feishu.rs` 一致的轻量风格。

use harness_feishu_oauth::{FeishuOAuth, FeishuOAuthConfig, TokenBundle};
use serde::Deserialize;

/// 从命令参数与进程环境拼出 OAuth 配置。
///
/// 优先取显式传入的 `app_id/app_secret`；为空时回退到 `FEISHU_APP_ID`/`FEISHU_APP_SECRET`
/// 环境变量（与 T12 飞书 MCP 的 env 注入约定一致）。`base_url` 供沙箱/测试环境覆盖。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthParams {
    pub app_id: Option<String>,
    pub app_secret: Option<String>,
    pub redirect_uri: Option<String>,
    pub base_url: Option<String>,
}

fn build_client(p: OAuthParams) -> FeishuOAuth {
    let app_id = p
        .app_id
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("FEISHU_APP_ID").ok())
        .unwrap_or_default();
    let app_secret = p
        .app_secret
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("FEISHU_APP_SECRET").ok())
        .unwrap_or_default();
    let cfg = FeishuOAuthConfig {
        app_id,
        app_secret,
        redirect_uri: p.redirect_uri.unwrap_or_default(),
        base_url: p.base_url.unwrap_or_else(|| FEISHU_OPEN_BASE.to_string()),
        ..Default::default()
    };
    FeishuOAuth::new(cfg)
}

const FEISHU_OPEN_BASE: &str = "https://open.feishu.cn";

/// 校验应用凭据并取 `app_access_token`。成功返回 token 与其有效期。
#[tauri::command]
pub async fn feishu_oauth_app_token(
    params: OAuthParams,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let client = build_client(params);
        let t = client.app_access_token().map_err(|e| e.to_string())?;
        Ok::<serde_json::Value, String>(serde_json::json!({
            "app_access_token": t.token,
            "expire": t.expire,
            "msg": t.msg,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 生成用户授权页 URL。`state` 建议为随机串，授权回调时回传以校验防 CSRF。
#[tauri::command]
pub async fn feishu_oauth_authorize_url(
    params: OAuthParams,
    state: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let client = build_client(params);
        Ok::<String, String>(client.authorize_url(&state))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 用回传的授权码 `code` 换取 `user_access_token` + `refresh_token`。
#[tauri::command]
pub async fn feishu_oauth_exchange(
    params: OAuthParams,
    code: String,
) -> Result<TokenBundle, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let client = build_client(params);
        client.exchange_code(&code).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 用 `refresh_token` 刷新，返回滚动后的新 token（含新 refresh_token）。
#[tauri::command]
pub async fn feishu_oauth_refresh(
    params: OAuthParams,
    refresh_token: String,
) -> Result<TokenBundle, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let client = build_client(params);
        client.refresh(&refresh_token).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}