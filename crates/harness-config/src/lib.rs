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
/// 文件不存在时返回默认值（全部为空），不会报错。
pub fn read(codex_home: &str) -> Result<AppConfig> {
    let path = config_path(codex_home);
    let mut cfg = AppConfig::default();
    if !path.exists() {
        return Ok(cfg);
    }
    let text = std::fs::read_to_string(&path)?;
    if text.trim().is_empty() {
        return Ok(cfg);
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

    Ok(cfg)
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