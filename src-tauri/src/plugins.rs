//! T14 插件与 Skill 系统：Tauri 命令层。
//!
//! - `plugins_list`：扫描磁盘上的 skills（SKILL.md）与插件（plugin.toml），并结合
//!   当前 `config.toml` 中 `[skills.config]` / `[plugins.<id>]` 的开关，返回清单。
//! - `plugins_apply`：把面板编辑后的 skills 规则与插件开关合并写回 config.toml
//!   （复用 harness-config 的合并语义），供 codex 下一进程加载。

use std::path::PathBuf;

use harness_config::{AppConfig, PluginRule, SkillRule};
use harness_plugins::{discover_plugins, discover_skills};

/// 扫描一个 skill/插件清单。
#[tauri::command]
pub async fn plugins_list(
    codex_home: String,
    skill_roots: Vec<String>,
    plugin_roots: Vec<String>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = harness_config::read(&codex_home).map_err(|e| e.to_string())?;

        let skills = discover_skills(
            &skill_roots.iter().map(PathBuf::from).collect::<Vec<_>>(),
        );
        // 标记当前配置里的开关（按 name 或 path 匹配）。
        let skills_json: Vec<serde_json::Value> = skills
            .iter()
            .map(|s| {
                let rule = cfg.skills.iter().find(|r| {
                    (!r.name.is_empty() && r.name == s.name) || (!r.path.is_empty() && r.path == s.dir.to_string_lossy())
                });
                let enabled = rule.map(|r| r.enabled).unwrap_or(true);
                serde_json::json!({
                    "name": s.name,
                    "description": s.description,
                    "dir": s.dir.to_string_lossy(),
                    "enabled": enabled,
                })
            })
            .collect();

        let plugins = discover_plugins(
            &plugin_roots.iter().map(PathBuf::from).collect::<Vec<_>>(),
        );
        let plugins_json: Vec<serde_json::Value> = plugins
            .iter()
            .map(|p| {
                let enabled = cfg
                    .plugins
                    .iter()
                    .find(|r| r.id == p.id)
                    .map(|r| r.enabled)
                    .unwrap_or(true);
                serde_json::json!({
                    "id": p.id,
                    "name": p.name,
                    "description": p.description,
                    "dir": p.dir.to_string_lossy(),
                    "enabled": enabled,
                })
            })
            .collect();

        Ok::<serde_json::Value, String>(serde_json::json!({
            "skills": skills_json,
            "plugins": plugins_json,
            "bundled_skills_enabled": cfg.bundled_skills_enabled.unwrap_or(true),
            "skills_include_instructions": cfg.skills_include_instructions,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 写回 skills / 插件配置。`skills` = [{name,path,enabled}]，`plugins` = {id: enabled}。
#[tauri::command]
pub async fn plugins_apply(
    codex_home: String,
    skills: Vec<serde_json::Value>,
    plugins: serde_json::Value,
    bundled_skills_enabled: Option<bool>,
    skills_include_instructions: Option<bool>,
) -> Result<AppConfig, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cfg = harness_config::read(&codex_home).map_err(|e| e.to_string())?;

        // 重建 skills 规则。由 config 合并入口进入，因此传入的是全量列表。
        let mut rules = Vec::new();
        for v in &skills {
            let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let path = v.get("path").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let enabled = v.get("enabled").and_then(|x| x.as_bool()).unwrap_or(true);
            if !name.is_empty() || !path.is_empty() {
                rules.push(SkillRule { name, path, enabled });
            }
        }
        cfg.skills = rules;

        // 重建插件开关：`plugins` 为 { id: enabled }。
        let mut prules = Vec::new();
        if let Some(map) = plugins.as_object() {
            for (id, v) in map {
                let enabled = v.as_bool().unwrap_or(true);
                prules.push(PluginRule { id: id.clone(), enabled });
            }
        }
        cfg.plugins = prules;

        cfg.bundled_skills_enabled = bundled_skills_enabled;
        cfg.skills_include_instructions = skills_include_instructions;

        harness_config::write(&codex_home, &cfg).map_err(|e| e.to_string())?;
        Ok::<AppConfig, String>(cfg)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 便捷：把一组自定义 skill 目录追加为 `[[skills.config]] path` 规则并启用。
/// 供"添加自定义 skill"场景用，避免前端拼全量数组。
#[tauri::command]
pub async fn plugins_add_skill_dir(
    codex_home: String,
    dir: String,
    enabled: bool,
) -> Result<AppConfig, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cfg = harness_config::read(&codex_home).map_err(|e| e.to_string())?;
        cfg.skills
            .retain(|r| r.path != dir);
        cfg.skills.push(SkillRule {
            name: String::new(),
            path: dir,
            enabled,
        });
        harness_config::write(&codex_home, &cfg).map_err(|e| e.to_string())?;
        Ok::<AppConfig, String>(cfg)
    })
    .await
    .map_err(|e| e.to_string())?
}