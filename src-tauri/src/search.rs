//! T15 联网搜索：Tauri 命令层。
//!
//! - `search_execute`：直接用 REST 执行一次网页搜索并返回规整结果（供前端“来源展示”）。
//!   支持显式 `apiKey`；未提供时回退到 `TAVILY_API_KEY` / `SERPER_API_KEY` 环境变量，
//!   `base_url` 可指向内部网关或回归测试 mock，不强制依赖公网。
//! - `search_register_mcp`：把 `[mcp_servers.tavily|serper]` 写入 config.toml（合并语义），
//!   codex 在下一个 app-server 启动时即可调用该搜索 MCP 的 `web_search` 工具。
//! - `search_status`：回读注册状态用于展示/验证。

use harness_search::{SearchClient, SearchConfig, SearchMcpConfig, SearchProvider};
use harness_config::McpServerConfig;

/// 直接执行一次搜索。`provider` 取 `tavily` / `serper`。
#[tauri::command]
pub async fn search_execute(
    query: String,
    provider: Option<String>,
    api_key: Option<String>,
    base_url: Option<String>,
    max_results: Option<usize>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let prov = match provider.as_deref() {
            Some("serper") => SearchProvider::Serper,
            _ => SearchProvider::Tavily,
        };
        let cfg = SearchConfig {
            provider: prov,
            base_url: base_url
                .filter(|b| !b.is_empty())
                .unwrap_or_else(|| "https://api.tavily.com".to_string()),
            api_key: api_key.unwrap_or_default(),
            ..Default::default()
        };
        let client = SearchClient::new(cfg);
        let resp = client
            .search(&query, max_results.unwrap_or(5))
            .map_err(|e| e.to_string())?;
        Ok::<serde_json::Value, String>(serde_json::json!({
            "query": resp.query,
            "results": resp.results,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 注册（或覆写）`mcp_servers.tavily` / `mcp_servers.serper` 配置。
#[tauri::command]
pub async fn search_register_mcp(
    codex_home: String,
    provider: String,
    api_key: Option<String>,
) -> Result<McpServerConfig, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let prov = match provider.as_str() {
            "serper" => SearchProvider::Serper,
            _ => SearchProvider::Tavily,
        };
        let spec = SearchMcpConfig::build(prov, api_key.as_deref());
        spec.validate().map_err(|e| e)?;
        let mut cfg = harness_config::read(&codex_home).map_err(|e| e.to_string())?;
        let server = McpServerConfig {
            id: spec.id,
            command: spec.command,
            args: spec.args,
            env: spec.env,
            env_vars: spec.env_vars,
            enabled: true,
        };
        cfg.mcp_servers.retain(|m| m.id != server.id);
        cfg.mcp_servers.push(server.clone());
        harness_config::write(&codex_home, &cfg).map_err(|e| e.to_string())?;
        Ok::<McpServerConfig, String>(server)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 回读搜索 MCP 注册状态。返回 null 表示未注册。
#[tauri::command]
pub async fn search_status(codex_home: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = harness_config::read(&codex_home).map_err(|e| e.to_string())?;
        let tavily = cfg.mcp_servers.iter().find(|m| m.id == "tavily");
        let serper = cfg.mcp_servers.iter().find(|m| m.id == "serper");
        let render = |s: Option<&McpServerConfig>| match s {
            Some(s) => serde_json::json!({
                "registered": true,
                "command": s.command,
                "args": s.args,
                "envKeys": s.env.iter().map(|kv| kv.split('=').next().unwrap_or("").to_string()).collect::<Vec<_>>(),
                "envVars": s.env_vars,
                "enabled": s.enabled,
            }),
            None => serde_json::json!({ "registered": false }),
        };
        Ok::<serde_json::Value, String>(serde_json::json!({
            "tavily": render(tavily),
            "serper": render(serper),
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}