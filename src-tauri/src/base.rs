//! T19 · 飞书多维表格（Bitable）MCP：注册 `lark-mcp`（官方 npm 包）
//! 为 `[mcp_servers.base]`，内置 preset.default + approval_v4 工具集。
//!
//! 设计点：
//! - id 固定为 `"base"`，同时覆盖 bitable / im / approval / calendar / task 全链路。
//! - 命令从 `env_vars` 读 FEISHU_APP_ID / FEISHU_APP_SECRET（Harness 启动时自动注入）。
//! - 幂等：重复调用 `base_register_mcp` 只会 retain+push，不会产生重复条目。
//! - 健康检查 `base_health` 直接调飞书开放平台 auth 端点，失败时给安装 hint。
//! - v0.8.5：`provision_lark_mcp` 启动时做一次性预装（带标记文件），
//!   避免每个新会话都重新 `npm install` 一遍。

use std::path::Path;
use std::process::Command;
use std::time::{Duration, SystemTime};

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

// ============== v0.8.5：lark-mcp 一次性预装 ==============

/// 标记文件：记录上次预装结果，避免每次启动（每个新会话）都重复 `npm install`。
const LARK_MCP_MARKER: &str = ".lark-mcp-provisioned";
/// 安装失败后多久允许再试一次（避免断网时每次启动都卡在 npm 上）。
const LARK_MCP_RETRY_SECS: u64 = 24 * 3600;

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Windows 上 npm 是 `npm.cmd`，`Command::new("npm")` 不会走 PATHEXT，必须经 `cmd /C`。
fn npm_command() -> Command {
    if let Ok(bin) = std::env::var("HARNESS_NPM_BIN") {
        if !bin.trim().is_empty() {
            return Command::new(bin);
        }
    }
    if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg("npm");
        c
    } else {
        Command::new("npm")
    }
}

/// `lark-mcp` 是否已在 PATH 上可用。
///
/// 不做「起进程试跑」：Windows 上 npm 全局安装出来的是 `lark-mcp.cmd`（`Command::new`
/// 不走 PATHEXT），`--version` 也未必被 CLI 支持，探针会误判成未安装。直接按
/// PATH × 可执行扩展名查文件，跨平台且零副作用。
fn lark_mcp_available() -> bool {
    let exts: Vec<String> = if cfg!(windows) {
        let raw = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
        let mut v: Vec<String> = raw
            .split(';')
            .map(|e| e.trim().to_ascii_lowercase())
            .filter(|e| !e.is_empty())
            .collect();
        v.push(String::new());
        v
    } else {
        vec![String::new()]
    };
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    for dir in std::env::split_paths(&path) {
        for ext in &exts {
            if dir.join(format!("lark-mcp{ext}")).is_file() {
                return true;
            }
        }
    }
    false
}

/// 标记文件里记着上次预装的尝试时间：`LARK_MCP_RETRY_SECS` 内不重复尝试
/// （成功过也一样 —— 正常情况下 `lark_mcp_available()` 会先短路，走到这里说明
/// 二进制又不见了，此时按天级重试即可）。
fn marker_allows_attempt(marker: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(marker) else {
        return true;
    };
    let mut at = 0u64;
    for line in text.lines() {
        if let Some(("at", v)) = line.split_once('=') {
            at = v.trim().parse().unwrap_or(0);
        }
    }
    now_unix().saturating_sub(at) >= LARK_MCP_RETRY_SECS
}

fn write_marker(marker: &Path, status: &str) {
    let body = format!("status={status}\nat={}\n", now_unix());
    let _ = std::fs::write(marker, body);
}

/// 启动时的一次性预装：`lark-mcp` 不在 PATH 上才 `npm install -g`，并用标记文件记住结果。
///
/// 返回值是**给日志用的文案**：`None` 表示「已就绪/本次无需动作」。
pub fn provision_lark_mcp(codex_home: &str) -> Option<String> {
    let marker = Path::new(codex_home).join(LARK_MCP_MARKER);

    if lark_mcp_available() {
        write_marker(&marker, "ok");
        return None;
    }
    if !marker_allows_attempt(&marker) {
        return None;
    }

    let out = npm_command()
        .args(["install", "-g", "@larksuiteoapi/lark-mcp"])
        .output();
    let message = match out {
        Ok(o) if o.status.success() => {
            if lark_mcp_available() {
                write_marker(&marker, "ok");
                "lark-mcp 预装完成".to_string()
            } else {
                // npm 装完但 PATH 里还看不到（常见于刚写入 PATH、进程未重启）
                write_marker(&marker, "installed");
                "lark-mcp 已安装到全局，PATH 生效后可用".to_string()
            }
        }
        Ok(o) => {
            write_marker(&marker, "failed");
            let tail: String = String::from_utf8_lossy(&o.stderr)
                .chars()
                .rev()
                .take(300)
                .collect::<String>()
                .chars()
                .rev()
                .collect();
            format!("lark-mcp 自动安装失败（可手动 npm i -g @larksuiteoapi/lark-mcp）：{tail}")
        }
        Err(e) => {
            write_marker(&marker, "failed");
            format!("未找到 npm，跳过 lark-mcp 预装（飞书表格能力需先装 Node.js）：{e}")
        }
    };
    Some(message)
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
