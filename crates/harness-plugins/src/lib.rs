//! # harness-plugins
//!
//! T14 插件与 Skill 系统：负责在磁盘上**发现** skill 与插件，并为配置面板提供清单。
//!
//! 与 codex 的约定对齐：
//! - 一个 **skill** 是一个含 `SKILL.md` 的目录；`SKILL.md` 的 frontmatter（YAML）
//!   提供 `name` 与 `description`。codex 通过 `[skills.config]` 按 `name`/`path`
//!   启用或停用。
//! - 一个 **插件** 在本 harness 中定义为含 `plugin.toml`（`name`/`description`）
//!   的目录；用户通过 `[plugins.<id>] enabled` 开关。
//!
//! 该 crate 输出发现结果与解析后的元数据，配置的写入由 harness-config 负责。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// 一个被发现的 skill。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    /// skill 名称（来自 SKILL.md frontmatter，缺省取目录名）。
    pub name: String,
    /// 一句话描述。
    pub description: String,
    /// SKILL.md 所在目录的绝对路径（用于 `path` 选择器）。
    pub dir: PathBuf,
}

/// 一个被发现的插件。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    /// 插件 id（目录名）。
    pub id: String,
    /// 展示名。
    pub name: String,
    /// 描述。
    pub description: String,
    /// 插件目录路径。
    pub dir: PathBuf,
}

/// 扫描 `roots`（均为目录）递归寻找 `SKILL.md`，返回每个 skill 的元数据。
pub fn discover_skills(roots: &[PathBuf]) -> Vec<SkillInfo> {
    let mut out = Vec::new();
    // 用 BTreeMap 去重（同一目录多个 root 命中时取一次，路径稳定排序）。
    let mut seen: BTreeMap<PathBuf, SkillInfo> = BTreeMap::new();
    for root in roots {
        if !root.is_dir() {
            continue;
        }
        walk_skill(root, &mut seen);
    }
    for (_, v) in seen {
        out.push(v);
    }
    out
}

fn walk_skill(dir: &Path, seen: &mut BTreeMap<PathBuf, SkillInfo>) {
    let skill_md = dir.join("SKILL.md");
    if skill_md.is_file() {
        if let Some(info) = parse_skill_dir(dir) {
            // 规范化为绝对路径，便于去重与后续 `path` 选择器。
            let canon = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
            seen.insert(canon, info);
        }
        // 该目录已是一个 skill，不再递归其子目录。
        return;
    }
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in read.flatten() {
        let p = entry.path();
        if p.is_dir() {
            walk_skill(&p, seen);
        }
    }
}

/// 解析单目录技能：读取 `SKILL.md` 的 frontmatter。
///
/// frontmatter 样例：
/// ```yaml
/// ---
/// name: code-review
/// description: 对 Pull Request 进行代码审查
/// ---
/// # 正文……
/// ```
pub fn parse_skill_dir(dir: &Path) -> Option<SkillInfo> {
    let skill_md = dir.join("SKILL.md");
    let text = std::fs::read_to_string(&skill_md).ok()?;
    // 仅提取 `---` 包裹的 frontmatter（允许结尾无第二个 `---`）。
    let content = text
        .strip_prefix("---")
        .and_then(|rest| rest.split_once("---").map(|(fm, _)| fm.trim()))
        .unwrap_or("");
    let mut name = dir
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut description = String::new();
    if !content.is_empty() {
        // frontmatter 是 YAML；用 toml 引擎解析最宽松的 key: value 行子集。
        for line in content.lines() {
            let line = line.trim();
            if let Some((k, v)) = line.split_once(':') {
                let k = k.trim();
                let v = v.trim().trim_matches('"').trim_matches('\'');
                if k == "name" && !v.is_empty() {
                    name = v.to_string();
                } else if k == "description" && !v.is_empty() {
                    description = v.to_string();
                }
            }
        }
    }
    if name.is_empty() {
        return None;
    }
    Some(SkillInfo {
        name,
        description,
        dir: dir.to_path_buf(),
    })
}

/// 扫描 `roots` 寻找插件目录（含 `plugin.toml`）。
pub fn discover_plugins(roots: &[PathBuf]) -> Vec<PluginInfo> {
    let mut out = Vec::new();
    let mut seen: BTreeMap<PathBuf, PluginInfo> = BTreeMap::new();
    for root in roots {
        if !root.is_dir() {
            continue;
        }
        walk_plugin(root, &mut seen);
    }
    for (_, v) in seen {
        out.push(v);
    }
    out
}

fn walk_plugin(dir: &Path, seen: &mut BTreeMap<PathBuf, PluginInfo>) {
    let manifest = dir.join("plugin.toml");
    if manifest.is_file() {
        if let Some(info) = parse_plugin_dir(dir) {
            let canon = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
            seen.insert(canon, info);
        }
        // 插件目录不再递归。
        return;
    }
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in read.flatten() {
        let p = entry.path();
        if p.is_dir() {
            walk_plugin(&p, seen);
        }
    }
}

/// 解析插件清单 `plugin.toml`（`name` / `description`）。
pub fn parse_plugin_dir(dir: &Path) -> Option<PluginInfo> {
    let text = std::fs::read_to_string(dir.join("plugin.toml")).ok()?;
    let doc: toml::Value = toml::from_str(&text).ok()?;
    let table = doc.as_table()?;
    let id = dir.file_name().map(|s| s.to_string_lossy().to_string())?;
    let name = table
        .get("name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(&id)
        .to_string();
    let description = table
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Some(PluginInfo {
        id,
        name,
        description,
        dir: dir.to_path_buf(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("harness-plugins-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn discovers_and_parses_skills_recursively() {
        let root = tdir("skills");
        // 顶层直接是一个 skill 目录。
        let a = root.join("code-review");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(
            a.join("SKILL.md"),
            "---\nname: code-review\ndescription: 代码审查\n---\n正文",
        )
        .unwrap();
        // 嵌套在子目录里的 skill。
        let nested_root = root.join("collections/general");
        let b = nested_root.join("git-help");
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(b.join("SKILL.md"), "---\nname: git-help\ndescription: Git 帮助\n---\n").unwrap();
        // 非 skill 目录不应被当作 skill。
        std::fs::create_dir_all(root.join("empty")).unwrap();

        let skills = discover_skills(&[root.clone()]);
        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"code-review"), "{names:?}");
        assert!(names.contains(&"git-help"), "{names:?}");
        assert_eq!(skills.len(), 2);
        let review = skills.iter().find(|s| s.name == "code-review").unwrap();
        assert_eq!(review.description, "代码审查");
        assert!(review.dir.join("SKILL.md").exists());
        // 目录名缺省 fallback
        let c = root.join("fallback-name");
        std::fs::create_dir_all(&c).unwrap();
        std::fs::write(c.join("SKILL.md"), "无 frontmatter 正文").unwrap();
        let skills = discover_skills(&[root.clone()]);
        assert!(skills.iter().any(|s| s.name == "fallback-name"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn discovers_plugins_with_manifest() {
        let root = tdir("plugins");
        let p1 = root.join("my-tool");
        std::fs::create_dir_all(&p1).unwrap();
        std::fs::write(p1.join("plugin.toml"), "name = \"我的工具\"\ndescription = \"一个示例插件\"\n").unwrap();
        // 无 plugin.toml 的目录不算插件。
        std::fs::create_dir_all(root.join("not-a-plugin")).unwrap();

        let plugins = discover_plugins(&[root.clone()]);
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].id, "my-tool");
        assert_eq!(plugins[0].name, "我的工具");
        assert_eq!(plugins[0].description, "一个示例插件");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn discover_is_idempotent_across_overlapping_roots() {
        let root = tdir("overlap");
        let a = root.join("code-review");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(a.join("SKILL.md"), "---\nname: code-review\n---\n").unwrap();

        // 同时传入父目录与子目录，同一 skill 只应出现一次。
        let skills = discover_skills(&[root.clone(), a.clone()]);
        assert_eq!(
            skills.iter().filter(|s| s.name == "code-review").count(),
            1
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}