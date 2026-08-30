//! T18 · RAG 相关的 Tauri 命令。
//!
//! 三件事：
//! 1. `rag_register`：一键在 `[mcp_servers.rag]` 写入注册条目（codex 下次启动时自动
//!    拉起 stdio MCP server，即 `harness-rag-mcp` 可执行文件）。
//! 2. `rag_status`：回读已注册状态。
//! 3. `rag_health`：对 Chroma base_url 发一次 `/api/v1/heartbeat`，检查是否存活；
//!    返回中文可读的健康提示 + 给出安装命令兜底文案。

use harness_config::McpServerConfig;
use harness_rag::{RagClient, RagMcpConfig};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagStatus {
    pub registered: bool,
    pub enabled: bool,
    pub base_url: Option<String>,
    pub collection: Option<String>,
    pub command: Option<String>,
}

/// 注册（或覆写）`mcp_servers.rag`。
#[tauri::command]
pub async fn rag_register(
    codex_home: String,
    base_url: Option<String>,
    default_collection: Option<String>,
    env_vars: Option<Vec<String>>,
) -> Result<RagStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cfg = harness_config::read(&codex_home).map_err(|e| e.to_string())?;

        let mut mcp_cfg = RagMcpConfig::build(base_url.as_deref(), default_collection.as_deref());
        if let Some(extra) = env_vars {
            for v in extra {
                if !v.trim().is_empty() && !mcp_cfg.env_vars.iter().any(|x| x == &v) {
                    mcp_cfg.env_vars.push(v);
                }
            }
        }
        mcp_cfg.validate().map_err(|e| format!("RagMcpConfig invalid: {e}"))?;

        let (id, command, args, env, env_vars, enabled) = mcp_cfg.into_mcp_parts();
        let server = McpServerConfig { id, command, args, env, env_vars, enabled };

        cfg.mcp_servers.retain(|m| m.id != server.id);
        cfg.mcp_servers.push(server.clone());
        harness_config::write(&codex_home, &cfg).map_err(|e| e.to_string())?;

        let base_url = server
            .args
            .windows(2)
            .find(|w| w[0] == "--base-url")
            .map(|w| w[1].clone());
        let collection = server
            .args
            .windows(2)
            .find(|w| w[0] == "--default-collection")
            .map(|w| w[1].clone());
        Ok(RagStatus {
            registered: true,
            enabled: server.enabled,
            base_url,
            collection,
            command: Some(server.command),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn rag_status(codex_home: String) -> Result<RagStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = harness_config::read(&codex_home).map_err(|e| e.to_string())?;
        let Some(s) = cfg.mcp_servers.iter().find(|m| m.id == "rag") else {
            return Ok(RagStatus {
                registered: false,
                enabled: false,
                base_url: None,
                collection: None,
                command: None,
            });
        };
        let base_url = s
            .args
            .windows(2)
            .find(|w| w[0] == "--base-url")
            .map(|w| w[1].clone());
        let collection = s
            .args
            .windows(2)
            .find(|w| w[0] == "--default-collection")
            .map(|w| w[1].clone());
        Ok(RagStatus {
            registered: true,
            enabled: s.enabled,
            base_url,
            collection,
            command: Some(s.command.clone()),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagHealth {
    pub ok: bool,
    pub base_url: String,
    pub message: String,
    /// 非 ok 时给出的用户可执行安装/启动建议。
    pub hint: Option<String>,
}

/// 对 `base_url`（缺省取已注册 rag 的 base_url，再缺省默认值）做一次 heartbeat。
#[tauri::command]
pub async fn rag_health(base_url: Option<String>) -> Result<RagHealth, String> {
    let base = base_url
        .unwrap_or_else(|| harness_rag::DEFAULT_BASE_URL.to_string());
    let base_for_err = base.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let client = RagClient::new(&base);
        match client.health() {
            Ok(()) => Ok(RagHealth {
                ok: true,
                base_url: base,
                message: "Chroma 服务正常".into(),
                hint: None,
            }),
            Err(e) => {
                let hint = format!(
                    "请先启动 Chroma（推荐 Python 方式）：\n  pip install chromadb\n  chroma run --host 127.0.0.1 --port 18763\n或检查 --base-url 是否指向可达地址（当前：{base_for_err}）。"
                );
                Ok(RagHealth {
                    ok: false,
                    base_url: base,
                    message: e.to_string(),
                    hint: Some(hint),
                })
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
