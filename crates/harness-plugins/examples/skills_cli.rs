//! T14 插件与 Skill 命令行示例：扫描 skills / 插件目录并输出 JSON。
//! 供黑盒 e2e 复用。
//!
//! 用法：
//!   --skill-root <dir> [--skill-root <dir> ...]  --scan-skills
//!   --plugin-root <dir> [--plugin-root <dir> ...] --scan-plugins
//!   --help

use std::path::PathBuf;

use harness_plugins::{discover_plugins, discover_skills};

fn main() {
    let mut skill_roots = Vec::new();
    let mut plugin_roots = Vec::new();
    let mut scan_skills = false;
    let mut scan_plugins = false;
    let mut it = std::env::args().skip(1);
    while let Some(x) = it.next() {
        match x.as_str() {
            "--skill-root" => {
                if let Some(v) = it.next() {
                    skill_roots.push(PathBuf::from(v));
                }
            }
            "--plugin-root" => {
                if let Some(v) = it.next() {
                    plugin_roots.push(PathBuf::from(v));
                }
            }
            "--scan-skills" => scan_skills = true,
            "--scan-plugins" => scan_plugins = true,
            "--help" | "-h" => {
                println!("usage as in module docs");
                std::process::exit(0);
            }
            _ => {}
        }
    }

    let mut obj = serde_json::Map::new();
    if scan_skills {
        let skills = discover_skills(&skill_roots);
        obj.insert(
            "skills".into(),
            serde_json::to_value(
                skills
                    .iter()
                    .map(|s| {
                        serde_json::json!({
                            "name": s.name,
                            "description": s.description,
                            "dir": s.dir.to_string_lossy(),
                        })
                    })
                    .collect::<Vec<_>>(),
            )
            .unwrap(),
        );
    }
    if scan_plugins {
        let plugins = discover_plugins(&plugin_roots);
        obj.insert(
            "plugins".into(),
            serde_json::to_value(
                plugins
                    .iter()
                    .map(|p| {
                        serde_json::json!({
                            "id": p.id,
                            "name": p.name,
                            "description": p.description,
                            "dir": p.dir.to_string_lossy(),
                        })
                    })
                    .collect::<Vec<_>>(),
            )
            .unwrap(),
        );
    }
    println!("{}", serde_json::Value::Object(obj));
}