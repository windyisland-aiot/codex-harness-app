//! 配置面板的数据模型。

use serde::{Deserialize, Serialize};

/// 面向配置面板的归一化应用配置（对应 codex config.toml 的可管理字段）。
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    /// 默认模型名。
    pub model: String,
    /// 默认模型提供商 id。
    pub model_provider: String,
    /// 审批策略：never / on-request / on-failure 等。
    pub approval_policy: String,
    /// 已注册的模型提供商列表。
    pub model_providers: Vec<ProviderConfig>,
    /// 已注册的 MCP server 列表。
    pub mcp_servers: Vec<McpServerConfig>,
}

/// 一个模型提供商。
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    /// 唯一 id（即 `[model_providers.<id>]` 的键）。
    pub id: String,
    /// 展示名。
    pub name: String,
    /// OpenAI 兼容 base_url（含 `/v1`）。
    pub base_url: String,
    /// 读取 API key 的环境变量名。
    pub env_key: String,
    /// wire_api：responses / chat。
    pub wire_api: String,
}

/// 一个 MCP server。
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    /// 唯一 id（即 `[mcp_servers.<id>]` 的键）。
    pub id: String,
    /// 可执行文件。
    pub command: String,
    /// 参数。
    pub args: Vec<String>,
    /// env 环境变量（简单映射字符串）。
    pub env: String,
}