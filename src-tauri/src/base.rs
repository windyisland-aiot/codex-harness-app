//! T19 · 飞书多维表格（Bitable）MCP：注册 `lark-mcp`（官方 npm 包）
//! 为 `[mcp_servers.base]`，内置 preset.default + approval_v4 工具集。
//!
//! 设计点：
//! - id 固定为 `"base"`，同时覆盖 bitable / im / approval / calendar / task 全链路。
//! - 命令从 `env_vars` 读 FEISHU_APP_ID / FEISHU_APP_SECRET（Harness 启动时自动注入）。
//! - 幂等：重复调用 `base_register_mcp` 只会 retain+push，不会产生重复条目。
//! - 健康检查 `base_health` 直接调飞书开放平台 auth 端点，失败时给安装 hint。

use std::time::Duration;

use harness_config::McpServerConfig;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseStatus {
    pub registered: bool,
    pub enabled: bool,
    pub app_token_hint: String,
    pub command: Option<String>,
}

/// 一键注册/覆写 `[mcp_servers.base]`。
///
/// - `app_token`：仅在前端用户显式给定时，写入 `--app-token <v>`；否则通过
///   `env_vars`（FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_USER_ACCESS_TOKEN）
///   透传。
#[tauri::command]
pub async fn base_register_mcp(
    codex_home: String,
    app_token: Option<String>,
    env_vars: Option<Vec<String>>,
) -> Result<BaseStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cfg = harness_config::read(&codex_home).map_err(|e| e.to_string())?;

        let mut args: Vec<String> = vec![
            "mcp".into(),
            "-t".into(),
            "preset.default,approval_v4".into(),
            "-m".into(),
            "stdio".into(),
        ];
        if let Some(t) = app_token.as_deref() {
            if !t.trim().is_empty() {
                args.push("--app-token".into());
                args.push(t.trim().to_string());
            }
        }
        let mut env_vars_actual: Vec<String> = vec![
            "FEISHU_USER_ACCESS_TOKEN".into(),
            "FEISHU_APP_ID".into(),
            "FEISHU_APP_SECRET".into(),
        ];
        if let Some(extra) = env_vars {
            for v in extra {
                let v = v.trim().to_string();
                if !v.is_empty() && !env_vars_actual.iter().any(|x| x == &v) {
                    env_vars_actual.push(v);
                }
            }
        }

        let server = McpServerConfig {
            id: "base".into(),
            command: "lark-mcp".into(),
            args,
            env: Vec::new(),
            env_vars: env_vars_actual,
            enabled: true,
        };

        cfg.mcp_servers.retain(|m| m.id != "base");
        cfg.mcp_servers.push(server.clone());
        harness_config::write(&codex_home, &cfg).map_err(|e| e.to_string())?;

        let app_token_hint = if server
            .env_vars
            .iter()
            .any(|v| v == "FEISHU_APP_ID" || v == "FEISHU_USER_ACCESS_TOKEN")
        {
            "已声明 FEISHU_APP_ID / FEISHU_USER_ACCESS_TOKEN 透传，运行时读取当前进程环境。"
                .into()
        } else {
            "未声明凭据透传，请在 lark-cli auth login 或 SettingsPanel 中启用 env_vars。"
                .into()
        };

        Ok(BaseStatus {
            registered: true,
            enabled: server.enabled,
            app_token_hint,
            command: Some(server.command),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn base_status(codex_home: String) -> Result<BaseStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = harness_config::read(&codex_home).map_err(|e| e.to_string())?;
        let hit = cfg.mcp_servers.iter().find(|m| m.id == "base");
        Ok(match hit {
            Some(s) => BaseStatus {
                registered: true,
                enabled: s.enabled,
                app_token_hint: if s
                    .env_vars
                    .iter()
                    .any(|v| v == "FEISHU_APP_ID" || v == "FEISHU_USER_ACCESS_TOKEN")
                {
                    "已声明 FEISHU_APP_ID / FEISHU_USER_ACCESS_TOKEN 透传。".into()
                } else {
                    "未声明凭据透传，请在 lark-cli auth login 或 SettingsPanel 中启用 env_vars。"
                        .into()
                },
                command: Some(s.command.clone()),
            },
            None => BaseStatus {
                registered: false,
                enabled: false,
                app_token_hint: "尚未注册，请点击“启用飞书多维表格 MCP”。".into(),
                command: None,
            },
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseHealth {
    pub ok: bool,
    pub message: String,
    pub hint: Option<String>,
}

#[tauri::command]
pub async fn base_health(app_token: Option<String>) -> Result<BaseHealth, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // 这里使用 ureq 而非 Feign SDK，避免新增依赖；失败时只返回可读文本。
        let endpoint = "https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal";
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(8))
            .build();
        // 发空 POST，不携带真实 app_id/secret：飞书会返回 400/参数缺失，但只要能收到
        // 2xx/4xx 响应就算「飞书开放平台网络可达、Base MCP 依赖的域名能通」。
        match agent
            .post(endpoint)
            .send_json(serde_json::json!({"app_id":"","app_secret":""}))
        {
            Ok(resp) => {
                let status = resp.status();
                let body = resp.into_string().unwrap_or_default();
                let body = sanitize_body(body);
                if (200..300).contains(&status) {
                    Ok(BaseHealth {
                        ok: true,
                        message: format!("飞书开放平台可达（HTTP {status}，已带 app token 响应）"),
                        hint: None,
                    })
                } else if [400, 401, 403, 405].contains(&status) {
                    // 空参数触发 400 是预期（表示网络通畅），返回 ok=true 但带提示
                    let _ = body;
                    Ok(BaseHealth {
                        ok: true,
                        message: format!(
                            "飞书开放平台可达（HTTP {status}，空 app_id/app_secret 触发预期错误；需真实凭据时请在 SettingsPanel 或 lark-cli 中配置）"
                        ),
                        hint: Some(
                            "授权命令：\n  lark-cli auth login\n或写入进程环境变量：\n  $env:FEISHU_APP_ID='<你的app_id>'\n  $env:FEISHU_APP_SECRET='<你的app_secret>'".into()
                        ),
                    })
                } else {
                    Ok(BaseHealth {
                        ok: false,
                        message: format!("飞书开放平台异常 HTTP {status}"),
                        hint: Some("请检查企业网络是否允许访问 open.feishu.cn；是否需要配置 HTTP 代理。".into()),
                    })
                }
            }
            Err(e) => {
                let msg = sanitize_body(e.to_string());
                Ok(BaseHealth {
                    ok: false,
                    message: format!("网络不可达：{msg}"),
                    hint: Some(
                        "安装命令（Windows PowerShell）：\n  npm install -g @larksuiteoapi/lark-mcp\n验证：\n  lark-mcp mcp -h\nHarness 已内置 FEISHU_APP_ID/SECRET，启动时自动注入。".into()
                    ),
                })
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn sanitize_body(body: String) -> String {
    use regex::Regex;
    use std::sync::LazyLock;
    static R1: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)(Bearer|Basic)\s+[A-Za-z0-9\-._~+/=]+").unwrap());
    static R2: LazyLock<Regex> = LazyLock::new(|| {
        let q34: char = 34u8 as char;
        let q39: char = 39u8 as char;
        let pat = format!(
            r"(?i)(token|api[_-]?key|secret|access[_-]?token|refresh[_-]?token)\s*[:=]\s*[{q34}{q39}]?[A-Za-z0-9\-._~+/]+[{q34}{q39}]?"
        );
        Regex::new(&pat).unwrap()
    });
    let s = R1.replace_all(&body, "${1} [REDACTED]").into_owned();
    R2.replace_all(&s, "${1}=[REDACTED]").into_owned()
}
