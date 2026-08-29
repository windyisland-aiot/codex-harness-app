//! 配置面板的数据模型。

use serde::{Deserialize, Serialize};

/// 面向配置面板的归一化应用配置（对应 codex config.toml 的可管理字段）。
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
    /// T14：`[skills.bundled] enabled`（缺省不写=开启）。`None` 表示未显式配置。
    pub bundled_skills_enabled: Option<bool>,
    /// T14：`[skills] include_instructions`（自动技能指令块）。`None` 表示不显式写。
    pub skills_include_instructions: Option<bool>,
    /// T14：`[[skills.config]]` 启用/停用规则（按 name 或 path）。
    pub skills: Vec<SkillRule>,
    /// T14：`[plugins.<id>]` 插件开关。
    pub plugins: Vec<PluginRule>,
}

/// 一个模型提供商。
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    /// 唯一 id（即 `[model_providers.<id>]` 的键）。
    pub id: String,
    /// 展示名。
    pub name: String,
    /// codex 要求的 provider 类型：
    /// - 自定义 OpenAI 兼容服务（火山方舟、DeepSeek 等）= `"Custom"`
    /// - codex 内置 OpenAI = `"OpenAI"`（但 id 不能写 "openai"，否则冲突）
    ///
    /// 缺省 `"Custom"`，即 Harness 单 Ark 默认走 Custom 提供程序。
    /// 写入 config.toml 时对应字段名 `type`（不是 camelCase，codex 约定如此）。
    #[serde(rename = "type", default = "default_provider_type")]
    pub provider_type: String,
    /// OpenAI 兼容 base_url（含 `/v1`）。
    pub base_url: String,
    /// 读取 API key 的环境变量名。
    pub env_key: String,
    /// wire_api：responses / chat。
    pub wire_api: String,
}

fn default_provider_type() -> String { "Custom".to_string() }

/// 一个 MCP server。
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    /// 唯一 id（即 `[mcp_servers.<id>]` 的键）。
    pub id: String,
    /// 可执行文件。
    pub command: String,
    /// 参数。
    pub args: Vec<String>,
    /// 直接注入的环境变量，每项 `KEY=value`（序列化为 `env = { KEY = "value" }`）。
    pub env: Vec<String>,
    /// 透传的环境变量名（序列化为 `env_vars = ["NAME", ...]`，值取当前进程）。
    pub env_vars: Vec<String>,
    /// 是否启用（codex `enabled`，缺省 true）。
    pub enabled: bool,
}

/// T14：一条 skill 启用/停用规则（`[skills.config]`）。
/// 选择器为 name 或 path 二选一（codex `SkillConfig` 不允许同时出现）。
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRule {
    /// 按名称选择（`name = ...`）。
    pub name: String,
    /// 按目录路径选择（`path = ...`）。
    pub path: String,
    /// 是否启用。
    pub enabled: bool,
}

/// T14：一条插件开关规则（`[plugins.<id>] enabled`）。
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRule {
    /// 插件 id。
    pub id: String,
    /// 是否启用。
    pub enabled: bool,
}
