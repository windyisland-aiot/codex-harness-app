//! # harness-config
//!
//! T09：读写 codex 的 `config.toml`（位于 `CODEX_HOME`）。
//!
//! 面向配置面板暴露一个归一化的 [`AppConfig`]，覆盖用户可管理的字段：
//! - `model` / `model_provider`（默认模型）
//! - `approval_policy`（审批策略）
//! - `model_providers`（模型提供商：base_url / env_key / wire_api）
//! - `mcp_servers`（MCP server：command / args / env）
//!
//! 读写采用“合并”语义：写回时保留 config.toml 中其它未被面板管理的关键字，
//! 只更新上述分区，避免破坏 codex 的额外配置。

pub mod model;

pub use model::{AppConfig, McpServerConfig, PluginRule, ProviderConfig, SkillRule};

use std::path::{Path, PathBuf};

/// 配置相关错误。
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("toml: {0}")]
    Toml(#[from] toml::de::Error),
    #[error("toml serialize: {0}")]
    TomlSer(#[from] toml::ser::Error),
    #[error("invalid expected type in section `{section}`: {why}")]
    Type { section: String, why: String },
}

pub type Result<T> = std::result::Result<T, ConfigError>;

/// 配置文件名（codex 默认）。
pub const CONFIG_FILE: &str = "config.toml";

/// 返回 `<codex_home>/config.toml`。
pub fn config_path(codex_home: &str) -> PathBuf {
    Path::new(codex_home).join(CONFIG_FILE)
}

mod conv {
    use super::Result;
    use crate::ConfigError;

    /// 从 `toml::Value` 读取字符串字段。
    pub fn get_str<'a>(table: &'a toml::map::Map<String, toml::Value>, key: &str, section: &str) -> Result<Option<&'a str>> {
        match table.get(key) {
            None => Ok(None),
            Some(toml::Value::String(s)) => Ok(Some(s)),
            Some(_) => Err(ConfigError::Type {
                section: section.to_string(),
                why: format!("`{key}` not a string"),
            }),
        }
    }

    /// 把一个可选字符串作为顶层标量写入 table（值为空则不写）。
    pub fn put_str(table: &mut toml::map::Map<String, toml::Value>, key: &str, val: Option<&str>) {
        match val {
            Some(v) if !v.is_empty() => table.insert(key.to_string(), toml::Value::String(v.to_string())),
            _ => table.remove(key),
        };
    }
}

/// 读取 `config.toml` 为 [`AppConfig`]。
/// 文件不存在时返回 **火山方舟（Volcengine Ark）默认配置**：
/// - `model = "ark-code-latest"`，`model_provider = "volcengine-ark"`
/// - `[model_providers.volcengine-ark]` baseUrl / envKey / wireApi 预填
/// - 审批策略默认 `on-request`
/// （首次启动即可出模型能力，用户后续可在配置面板切换 / 覆盖）。
///
/// **配置迁移（自动）**：读取后若发现任一 provider 使用已废弃的
/// `wire_api = "chat"`，或 Ark 提供商 base_url 未指向本机内嵌网关，
/// 则自动修正并写回磁盘（保证旧版用户升级后立即可用，无需手动改配置）。
pub fn read(codex_home: &str) -> Result<AppConfig> {
    let path = config_path(codex_home);
    let mut cfg = AppConfig::default();
    if !path.exists() {
        // 文件不存在：生成 Ark 默认配置 **并写回磁盘**，
        // 保证紧随其后启动的 codex app-server 读取到合规 config.toml
        // （避免 codex 用自带内置默认值，默认值里 wire_api 可能为废弃 "chat"）。
        let def = default_ark_config();
        write(codex_home, &def)?;
        return Ok(def);
    }
    let text = std::fs::read_to_string(&path)?;
    if text.trim().is_empty() {
        let def = default_ark_config();
        write(codex_home, &def)?;
        return Ok(def);
    }
    let table: toml::map::Map<String, toml::Value> = match toml::from_str(&text) {
        Ok(m) => m,
        // 解析失败时不丢弃既有手动配置，仅向面板返回空结构。
        Err(_) => return Ok(cfg),
    };

    cfg.model = conv::get_str(&table, "model", "top")?.unwrap_or("").to_string();
    cfg.model_provider = conv::get_str(&table, "model_provider", "top")?.unwrap_or("").to_string();
    cfg.approval_policy = conv::get_str(&table, "approval_policy", "top")?.unwrap_or("").to_string();

    if let Some(toml::Value::Table(providers)) = table.get("model_providers") {
        for (id, v) in providers {
            if let toml::Value::Table(p) = v {
                cfg.model_providers.push(ProviderConfig {
                    id: id.clone(),
                    name: conv::get_str(p, "name", "model_providers")?.unwrap_or(id).to_string(),
                    base_url: conv::get_str(p, "base_url", "model_providers")?
                        .unwrap_or("")
                        .to_string(),
                    env_key: conv::get_str(p, "env_key", "model_providers")?
                        .unwrap_or("")
                        .to_string(),
                    wire_api: conv::get_str(p, "wire_api", "model_providers")?
                        .unwrap_or("")
                        .to_string(),
                });
            }
        }
    }

    if let Some(toml::Value::Table(servers)) = table.get("mcp_servers") {
        for (id, v) in servers {
            if let toml::Value::Table(s) = v {
                let mut args = Vec::new();
                if let Some(toml::Value::Array(arr)) = s.get("args") {
                    for a in arr {
                        if let toml::Value::String(x) = a {
                            args.push(x.clone());
                        }
                    }
                }
                // env：T12 起为表 `KEY = "value"`（旧版若为字符串则作为单条 KEY=value）。
                let mut env = Vec::new();
                match s.get("env") {
                    Some(toml::Value::Table(t)) => {
                        for (k, val) in t {
                            if let toml::Value::String(v) = val {
                                env.push(format!("{k}={v}"));
                            }
                        }
                    }
                    Some(toml::Value::String(v)) => env.push(v.clone()),
                    _ => {}
                }
                let mut env_vars = Vec::new();
                if let Some(toml::Value::Array(arr)) = s.get("env_vars") {
                    for a in arr {
                        if let toml::Value::String(x) = a {
                            env_vars.push(x.clone());
                        }
                    }
                }
                let enabled = match s.get("enabled") {
                    Some(toml::Value::Boolean(b)) => *b,
                    _ => true,
                };
                cfg.mcp_servers.push(McpServerConfig {
                    id: id.clone(),
                    command: conv::get_str(s, "command", "mcp_servers")?
                        .unwrap_or("")
                        .to_string(),
                    args,
                    env,
                    env_vars,
                    enabled,
                });
            }
        }
    }

    // T14：`[skills]`（bundled / include_instructions / config）。
    if let Some(toml::Value::Table(skills)) = table.get("skills") {
        cfg.skills_include_instructions = match skills.get("include_instructions") {
            Some(toml::Value::Boolean(b)) => Some(*b),
            _ => None,
        };
        if let Some(toml::Value::Table(bundled)) = skills.get("bundled") {
            if let Some(toml::Value::Boolean(b)) = bundled.get("enabled") {
                cfg.bundled_skills_enabled = Some(*b);
            }
        }
        if let Some(toml::Value::Array(config)) = skills.get("config") {
            for entry in config {
                if let toml::Value::Table(t) = entry {
                    let mut rule = SkillRule {
                        name: conv::get_str(t, "name", "skills.config")?.unwrap_or("").to_string(),
                        path: conv::get_str(t, "path", "skills.config")?.unwrap_or("").to_string(),
                        enabled: true,
                    };
                    if let Some(toml::Value::Boolean(b)) = t.get("enabled") {
                        rule.enabled = *b;
                    }
                    if !rule.name.is_empty() || !rule.path.is_empty() {
                        cfg.skills.push(rule);
                    }
                }
            }
        }
    }

    // T14：`[plugins.<id>] enabled`。
    if let Some(toml::Value::Table(plugins)) = table.get("plugins") {
        for (id, v) in plugins {
            if let toml::Value::Table(p) = v {
                let mut enabled = true;
                if let Some(toml::Value::Boolean(b)) = p.get("enabled") {
                    enabled = *b;
                }
                cfg.plugins.push(PluginRule { id: id.clone(), enabled });
            }
        }
    }

    // 首次读取且无任何配置时，兜底合并 Ark 默认提供商（已存在任何配置时不做强塞）。
    // ⚠️ T14 skills/plugins/bundled/included_instructions 也属于"已存在配置"，需一起判断，
    //    否则空 model 但有插件/技能规则时会被误判为"空"并被 Ark 默认覆盖（丢失技能开关）。
    let empty = cfg.model.is_empty()
        && cfg.model_provider.is_empty()
        && cfg.model_providers.is_empty()
        && cfg.approval_policy.is_empty()
        && cfg.mcp_servers.is_empty()
        && cfg.bundled_skills_enabled.is_none()
        && cfg.skills_include_instructions.is_none()
        && cfg.skills.is_empty()
        && cfg.plugins.is_empty();
    if empty {
        // 文件存在但全为空关键字段（例如用户写了一份空 `[model_providers]` 占位），
        // 仍需要把 Ark 默认配置**写回磁盘**，避免 codex 二进制回退到内置废弃默认值。
        let def = default_ark_config();
        write(codex_home, &def)?;
        return Ok(def);
    }

    // ---------- 配置自动迁移（2026-08 起 wire_api="chat" 被 codex 废弃） ----------
    // 升级用户已存在的 config.toml：任何 provider wire_api=chat → responses；
    // 火山方舟 base_url 直连真实端点 → 改为指向本机内嵌网关（127.0.0.1:18762/v1）。
    // 若有任何字段被修正，立即写回磁盘以保证下次 codex app-server 读取即生效。
    let mut migrated = false;
    for p in cfg.model_providers.iter_mut() {
        // 1) 废弃 wire_api=chat 强制升级
        if p.wire_api == "chat" || p.wire_api.trim().is_empty() {
            p.wire_api = "responses".to_string();
            migrated = true;
        }
        // 2) Ark 提供商未通过内嵌网关 → 切到本机网关
        if p.id == "volcengine-ark" {
            let gw = "http://127.0.0.1:18762/v1";
            if !p.base_url.contains("127.0.0.1") && !p.base_url.contains("localhost") {
                p.base_url = gw.to_string();
                migrated = true;
            }
            if p.env_key.trim().is_empty() {
                p.env_key = "VOLCENGINE_ARK_API_KEY".to_string();
                migrated = true;
            }
        }
    }
    // 3) 默认模型/提供商为空 → 补齐 Ark 默认
    if cfg.model.trim().is_empty() {
        cfg.model = "ark-code-latest".to_string();
        migrated = true;
    }
    if cfg.model_provider.trim().is_empty() {
        cfg.model_provider = "volcengine-ark".to_string();
        migrated = true;
    }
    // 4) Ark 提供商缺失且"默认提供商指向 Ark"或"完全无任何 provider" → 补上
    //    （若用户已有 mock/openai/deepseek 等提供商，不强行塞 Ark，避免破坏纯 mock 测试 / 多供应商场景）
    let needs_ark = cfg.model_providers.is_empty()
        || cfg.model_provider == "volcengine-ark"
        || cfg.model_provider.is_empty();
    if needs_ark && !cfg.model_providers.iter().any(|p| p.id == "volcengine-ark") {
        let def = default_ark_config();
        if let Some(ark) = def.model_providers.into_iter().next() {
            cfg.model_providers.push(ark);
            migrated = true;
        }
    }
    if migrated {
        // 迁移完成必须写回：失败则直接返回错误，
        // 防止上层仍用"看似迁移完成的内存 cfg"但磁盘仍是 wire_api=chat 旧值，
        // 导致随后启动的 codex 子进程加载到废弃配置。
        write(codex_home, &cfg)?;
    }

    Ok(cfg)
}

/// 火山方舟 Ark 编码模型默认配置（首次启动 / 配置文件缺失时使用）。
pub fn default_ark_config() -> AppConfig {
    use crate::model::{AppConfig, ProviderConfig};
    AppConfig {
        model: "ark-code-latest".to_string(),
        model_provider: "volcengine-ark".to_string(),
        approval_policy: "on-request".to_string(),
        model_providers: vec![ProviderConfig {
            id: "volcengine-ark".to_string(),
            name: "火山方舟 Ark Code".to_string(),
            // base_url 指向本机内嵌网关（128 位，Tauri 启动时拉起），
            // 网关负责把 Responses SSE 归一化（过滤 reasoning、补 content）；
            // 真实 Ark 端点与 API key 只由网关持有。
            base_url: "http://127.0.0.1:18762/v1".to_string(),
            env_key: "VOLCENGINE_ARK_API_KEY".to_string(),
            wire_api: "responses".to_string(),
        }],
        mcp_servers: Vec::new(),
        bundled_skills_enabled: None,
        skills_include_instructions: None,
        skills: Vec::new(),
        plugins: Vec::new(),
    }
}

/// 把 [`AppConfig`] 合并写回 `<codex_home>/config.toml`，保留未管理的其它配置。
pub fn write(codex_home: &str, cfg: &AppConfig) -> Result<()> {
    let path = config_path(codex_home);
    let mut table: toml::map::Map<String, toml::Value> = if path.exists() {
        match std::fs::read_to_string(&path) {
            Ok(t) => toml::from_str(&t).unwrap_or_default(),
            Err(_) => Default::default(),
        }
    } else {
        Default::default()
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    conv::put_str(&mut table, "model", Some(cfg.model.as_str()));
    conv::put_str(&mut table, "model_provider", Some(cfg.model_provider.as_str()));
    conv::put_str(&mut table, "approval_policy", Some(cfg.approval_policy.as_str()));

    // model_providers
    let mut providers = toml::map::Map::new();
    for p in &cfg.model_providers {
        if p.id.is_empty() {
            continue;
        }
        let mut t = toml::map::Map::new();
        conv::put_str(&mut t, "name", Some(if p.name.is_empty() { &p.id } else { &p.name }));
        conv::put_str(&mut t, "base_url", Some(p.base_url.as_str()));
        conv::put_str(&mut t, "env_key", Some(p.env_key.as_str()));
        conv::put_str(&mut t, "wire_api", Some(p.wire_api.as_str()));
        providers.insert(p.id.clone(), toml::Value::Table(t));
    }
    table.insert(
        "model_providers".to_string(),
        toml::Value::Table(providers),
    );

    // mcp_servers
    let mut servers = toml::map::Map::new();
    for m in &cfg.mcp_servers {
        if m.id.is_empty() || m.command.is_empty() {
            continue;
        }
        let mut t = toml::map::Map::new();
        t.insert("command".to_string(), toml::Value::String(m.command.clone()));
        if !m.args.is_empty() {
            t.insert(
                "args".to_string(),
                toml::Value::Array(m.args.iter().map(|a| toml::Value::String(a.clone())).collect()),
            );
        }
        // env 序列化为表 `KEY = "value"`（codex stdio MCP 要求）。
        if !m.env.is_empty() {
            let mut env_table = toml::map::Map::new();
            for kv in &m.env {
                if let Some((k, v)) = kv.split_once('=') {
                    env_table.insert(k.to_string(), toml::Value::String(v.to_string()));
                }
            }
            if !env_table.is_empty() {
                t.insert("env".to_string(), toml::Value::Table(env_table));
            }
        }
        if !m.env_vars.is_empty() {
            t.insert(
                "env_vars".to_string(),
                toml::Value::Array(m.env_vars.iter().map(|n| toml::Value::String(n.clone())).collect()),
            );
        }
        if !m.enabled {
            t.insert("enabled".to_string(), toml::Value::Boolean(false));
        }
        servers.insert(m.id.clone(), toml::Value::Table(t));
    }
    table.insert("mcp_servers".to_string(), toml::Value::Table(servers));

    // T14：`[skills]`。
    let write_skills =
        cfg.bundled_skills_enabled.is_some() || cfg.skills_include_instructions.is_some() || !cfg.skills.is_empty();
    if write_skills {
        let mut skills = toml::map::Map::new();
        if let Some(v) = cfg.skills_include_instructions {
            skills.insert("include_instructions".to_string(), toml::Value::Boolean(v));
        }
        if let Some(v) = cfg.bundled_skills_enabled {
            let mut bundled = toml::map::Map::new();
            bundled.insert("enabled".to_string(), toml::Value::Boolean(v));
            skills.insert("bundled".to_string(), toml::Value::Table(bundled));
        }
        if !cfg.skills.is_empty() {
            let mut config = Vec::new();
            for rule in &cfg.skills {
                if rule.name.is_empty() && rule.path.is_empty() {
                    continue;
                }
                let mut t = toml::map::Map::new();
                if !rule.name.is_empty() {
                    t.insert("name".to_string(), toml::Value::String(rule.name.clone()));
                } else {
                    t.insert("path".to_string(), toml::Value::String(rule.path.clone()));
                }
                t.insert("enabled".to_string(), toml::Value::Boolean(rule.enabled));
                config.push(toml::Value::Table(t));
            }
            skills.insert("config".to_string(), toml::Value::Array(config));
        }
        table.insert("skills".to_string(), toml::Value::Table(skills));
    }

    // T14：`[plugins.<id>] enabled`。
    if !cfg.plugins.is_empty() {
        let mut plugins = toml::map::Map::new();
        for rule in &cfg.plugins {
            if rule.id.is_empty() {
                continue;
            }
            let mut t = toml::map::Map::new();
            if !rule.enabled {
                t.insert("enabled".to_string(), toml::Value::Boolean(false));
            }
            plugins.insert(rule.id.clone(), toml::Value::Table(t));
        }
        table.insert("plugins".to_string(), toml::Value::Table(plugins));
    }

    let text = toml::to_string(&toml::Value::Table(table))?;
    std::fs::write(&path, text)?;
    Ok(())
}