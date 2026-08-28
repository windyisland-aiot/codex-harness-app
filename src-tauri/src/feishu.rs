//! T12 飞书 MCP 集成：把 `lark-openapi-mcp` 注册为 `[mcp_servers.feishu]`。
//!
//! - `feishu_register_mcp`：把飞书 MCP server 写入 `config.toml`（合并语义，仅更新
//!   `mcp_servers.feishu`，保留其它配置）。env 以表写入，env_vars 透传进程环境变量。
//!     codex 会在下一个 app-server 启动时自动拉起该 MCP server，从而让 Agent 获得
//!     飞书消息 / 文档 / 日历等工具（im/docx 操作）。
//! - `feishu_status`：回读确认注册是否成功。

use std::collections::HashMap;

use harness_config::McpServerConfig;

/// 注册（或覆写）`mcp_servers.feishu` 配置。
#[tauri::command]
pub async fn feishu_register_mcp(
    codex_home: String,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    env_vars: Vec<String>,
) -> Result<McpServerConfig, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cfg = harness_config::read(&codex_home).map_err(|e| e.to_string())?;
        let server = McpServerConfig {
            id: "feishu".into(),
            command,
            args,
            env: env
                .into_iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect(),
            env_vars,
            enabled: true,
        };
        // 覆写已存在的 feishu 条目。
        cfg.mcp_servers.retain(|m| m.id != "feishu");
        cfg.mcp_servers.push(server.clone());
        harness_config::write(&codex_home, &cfg).map_err(|e| e.to_string())?;
        Ok::<McpServerConfig, String>(server)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 回读飞书 MCP 注册状态（用于验证/展示）。返回 null 表示未注册。
#[tauri::command]
pub async fn feishu_status(codex_home: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = harness_config::read(&codex_home).map_err(|e| e.to_string())?;
        let hit = cfg.mcp_servers.iter().find(|m| m.id == "feishu");
        Ok::<serde_json::Value, String>(match hit {
            Some(s) => serde_json::json!({
                "registered": true,
                "command": s.command,
                "args": s.args,
                "envKeys": s.env.iter().map(|kv| kv.split('=').next().unwrap_or("").to_string()).collect::<Vec<_>>(),
                "envVars": s.env_vars,
                "enabled": s.enabled,
            }),
            None => serde_json::json!({ "registered": false }),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}