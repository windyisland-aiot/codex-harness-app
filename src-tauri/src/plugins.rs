//! T14 插件与 Skill 系统：Tauri 命令层。
//!
//! - `plugins_list`：扫描磁盘上的 skills（SKILL.md）与插件（plugin.toml），并结合
//!   当前 `config.toml` 中 `[skills.config]` / `[plugins.<id>]` 的开关，返回清单。
//! - `plugins_apply`：把面板编辑后的 skills 规则与插件开关合并写回 config.toml
//!   （复用 harness-config 的合并语义），供 codex 下一进程加载。

use std::path::PathBuf;

use harness_config::{AppConfig, PluginRule, SkillRule};
use harness_plugins::{discover_plugins, discover_skills};
use tauri::Manager;

/// 计算默认扫描根目录（v0.5.3：飞书等内置 skill 随安装包分发）。
///
/// 依次包含三类，`discover_*` 自带按 canonicalize 去重，重叠无副作用：
/// 1. 打包资源目录 `<resource_dir>/skills|plugins`（tauri.conf.json bundle.resources）
/// 2. `<codex_home>/skills|plugins`（如 `~/.codex/skills`，用户放置的自定义 skill）
/// 3. 开发模式兜底 `src-tauri/resources/skills|plugins`（未打包时 resource_dir 不指向源码）
fn default_roots(app: &tauri::AppHandle, codex_home: &str, kind: &str) -> Vec<(PathBuf, &'static str)> {
    let mut roots = Vec::new();
    if let Ok(rd) = app.path().resource_dir() {
        roots.push((rd.join(kind), "bundled"));
    }
    roots.push((PathBuf::from(codex_home).join(kind), "codex-home"));
    roots.push((
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join(kind),
        "bundled",
    ));
    roots
}

/// 递归拷贝目录（src → dst，dst 会被创建；同名文件覆盖，保持与安装包一致）。
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("mkdir {}: {e}", dst.display()))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("read {}: {e}", src.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let p = entry.path();
        let target = dst.join(entry.file_name());
        if p.is_dir() {
            copy_dir_recursive(&p, &target)?;
        } else {
            std::fs::copy(&p, &target).map_err(|e| format!("copy {}: {e}", p.display()))?;
        }
    }
    Ok(())
}

/// v0.5.4：把随安装包分发的内置 skills 同步到 `<codex_home>/skills/`。
///
/// 为什么这样做：codex 子进程通过 `CODEX_HOME` 环境变量只扫描 `$CODEX_HOME/skills`，
/// 而安装包资源目录的运行时路径是动态的（MSI/NSIS 安装位置不定），无法写进 config.toml。
/// 所以在每次 appserver_start（codex 拉起前）把资源目录下的 skills 物理拷贝过去，
/// 三方路径（codex 进程 / 插件面板扫描 / config.toml 规则）即完全对齐。
///
/// 同时做规则合并：对刚同步进来的 skill，若 config.toml 中**没有任何**对应规则，
/// 追加一条 `[[skills.config]] path=<dir> enabled=true`（首次安装默认启用）；
/// 已有规则（无论开关）不动，尊重用户在插件面板里的选择。
///
/// 返回同步的 skill 个数。
pub fn sync_bundled_skills(app: &tauri::AppHandle, codex_home: &str) -> Result<usize, String> {
    // 资源目录优先，开发模式兜底 src-tauri/resources/skills。
    let bundled_roots: Vec<PathBuf> = {
        let mut v = Vec::new();
        if let Ok(rd) = app.path().resource_dir() {
            v.push(rd.join("skills"));
        }
        v.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("skills"));
        v
    };

    let dest_root = PathBuf::from(codex_home).join("skills");
    let mut synced: Vec<PathBuf> = Vec::new();
    for root in bundled_roots {
        if !root.is_dir() { continue; }
        for entry in std::fs::read_dir(&root).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let p = entry.path();
            if p.is_dir() && p.join("SKILL.md").is_file() {
                let target = dest_root.join(entry.file_name());
                copy_dir_recursive(&p, &target)?;
                synced.push(target);
            }
        }
    }
    if synced.is_empty() {
        return Ok(0);
    }

    // 规则合并：只为「完全没有规则」的 skill 追加启用规则。
    let mut cfg = harness_config::read(codex_home).map_err(|e| e.to_string())?;
    let mut added = 0;
    for dir in &synced {
        let dir_str = dir.to_string_lossy().to_string();
        let has_rule = cfg.skills.iter().any(|r| {
            (!r.path.is_empty() && r.path == dir_str)
                || (!r.name.is_empty()
                    && r.name == dir.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default())
        });
        if !has_rule {
            cfg.skills.push(SkillRule {
                name: String::new(),
                path: dir_str,
                enabled: true,
            });
            added += 1;
        }
    }
    if added > 0 {
        harness_config::write(codex_home, &cfg).map_err(|e| e.to_string())?;
    }
    Ok(synced.len())
}

/// 扫描一个 skill/插件清单。前端传入的 `skill_roots`/`plugin_roots` 为额外自定义根，
/// 后端总是附带默认根（打包资源 + codex_home），保证内置 skill（如 feishu-bot）可被检测到。
#[tauri::command]
pub async fn plugins_list(
    app: tauri::AppHandle,
    codex_home: String,
    skill_roots: Vec<String>,
    plugin_roots: Vec<String>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = harness_config::read(&codex_home).map_err(|e| e.to_string())?;

        // 默认根 + 前端额外传入的自定义根，去重后扫描。
        let mut all_skill_roots: Vec<(PathBuf, &'static str)> = default_roots(&app, &codex_home, "skills");
        for r in skill_roots.iter().filter(|s| !s.trim().is_empty()) {
            all_skill_roots.push((PathBuf::from(r), "custom"));
        }
        let mut seen_roots: Vec<PathBuf> = Vec::new();
        let mut dedup_roots: Vec<(PathBuf, &'static str)> = Vec::new();
        for (p, src) in all_skill_roots {
            let canon = p.canonicalize().unwrap_or(p.clone());
            if !seen_roots.contains(&canon) {
                seen_roots.push(canon);
                dedup_roots.push((p, src));
            }
        }

        let mut skills: Vec<harness_plugins::SkillInfo> = Vec::new();
        let mut skill_sources: Vec<&'static str> = Vec::new();
        for (root, src) in &dedup_roots {
            for s in discover_skills(&[root.clone()]) {
                if !skills.iter().any(|x| x.dir == s.dir) {
                    skills.push(s);
                    skill_sources.push(src);
                }
            }
        }
        // 标记当前配置里的开关（按 name 或 path 匹配）。
        let skills_json: Vec<serde_json::Value> = skills
            .iter()
            .enumerate()
            .map(|(i, s)| {
                let rule = cfg.skills.iter().find(|r| {
                    (!r.name.is_empty() && r.name == s.name) || (!r.path.is_empty() && r.path == s.dir.to_string_lossy())
                });
                let enabled = rule.map(|r| r.enabled).unwrap_or(true);
                serde_json::json!({
                    "name": s.name,
                    "description": s.description,
                    "dir": s.dir.to_string_lossy(),
                    "enabled": enabled,
                    "source": skill_sources.get(i).copied().unwrap_or("custom"),
                })
            })
            .collect();

        // 插件：默认根 + 自定义根（同样去重）。
        let mut all_plugin_roots: Vec<(PathBuf, &'static str)> = default_roots(&app, &codex_home, "plugins");
        for r in plugin_roots.iter().filter(|s| !s.trim().is_empty()) {
            all_plugin_roots.push((PathBuf::from(r), "custom"));
        }
        let mut plugins: Vec<harness_plugins::PluginInfo> = Vec::new();
        for (root, _src) in &all_plugin_roots {
            for p in discover_plugins(&[root.clone()]) {
                if !plugins.iter().any(|x| x.dir == p.dir) {
                    plugins.push(p);
                }
            }
        }
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
            "bundledSkillsEnabled": cfg.bundled_skills_enabled.unwrap_or(true),
            "skillsIncludeInstructions": cfg.skills_include_instructions,
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
#[cfg(test)]
mod sync_tests {
    use super::*;
    use std::path::PathBuf;

    fn tdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "harness-sync-{tag}-{}-{}", std::process::id(), tag
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// copy_dir_recursive：多层目录 + 文件内容逐字节一致；重复同步（覆盖）幂等。
    #[test]
    fn copy_dir_recursive_copies_nested_and_is_idempotent() {
        let src = tdir("src");
        let skill = src.join("feishu-bot");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(skill.join("SKILL.md"), "---\nname: feishu-bot\n---\nbody").unwrap();
        std::fs::create_dir_all(skill.join("refs")).unwrap();
        std::fs::write(skill.join("refs/a.txt"), "nested").unwrap();

        let dst_root = tdir("dst");
        let dst = dst_root.join("feishu-bot");
        copy_dir_recursive(&skill, &dst).unwrap();
        assert_eq!(
            std::fs::read_to_string(dst.join("SKILL.md")).unwrap(),
            "---\nname: feishu-bot\n---\nbody"
        );
        assert_eq!(std::fs::read_to_string(dst.join("refs/a.txt")).unwrap(), "nested");

        // 第二次同步（内容更新后覆盖）→ 目标保持一致。
        std::fs::write(skill.join("SKILL.md"), "---\nname: feishu-bot\n---\nv2").unwrap();
        copy_dir_recursive(&skill, &dst).unwrap();
        assert!(std::fs::read_to_string(dst.join("SKILL.md")).unwrap().contains("v2"));

        let _ = std::fs::remove_dir_all(&src);
        let _ = std::fs::remove_dir_all(&dst_root);
    }

    /// 规则合并语义：已有规则（无论开关）不重复追加——用纯数据结构模拟。
    /// （sync_bundled_skills 本体需要 AppHandle，这里测其合并判断逻辑的等价形式。）
    #[test]
    fn rule_merge_does_not_duplicate_existing_rules() {
        let dir = "/some/codex-home/skills/feishu-bot";
        let existing = vec![
            SkillRule { name: String::new(), path: dir.to_string(), enabled: false },
        ];
        // 同一路径已有规则 → 不应再追加（哪怕规则是 disabled，尊重用户选择）。
        let has_rule = existing
            .iter()
            .any(|r| (!r.path.is_empty() && r.path == dir));
        assert!(has_rule);

        // 换一个新路径 → 应追加。
        let new_dir = "/some/codex-home/skills/other-skill";
        let has_rule = existing
            .iter()
            .any(|r| (!r.path.is_empty() && r.path == new_dir));
        assert!(!has_rule);
    }
}
