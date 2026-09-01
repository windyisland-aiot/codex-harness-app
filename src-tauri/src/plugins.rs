//! T14 插件与 Skill 系统：Tauri 命令层。
//!
//! - `plugins_list`：扫描磁盘上的 skills（SKILL.md）与插件（plugin.toml），并结合
//!   当前 `config.toml` 中 `[skills.config]` / `[plugins.<id>]` 的开关，返回清单。
//! - `plugins_apply`：把面板编辑后的 skills 规则与插件开关合并写回 config.toml
//!   （复用 harness-config 的合并语义），供 codex 下一进程加载。
//! - v0.6.0 新增：云端服务器健康检查 / 云端市场列表 / 云端安装 / 本地文件导入。

use std::path::{Path, PathBuf};
use std::time::Instant;

use harness_config::{AppConfig, PluginRule, SkillRule};
use harness_plugins::{discover_plugins, discover_skills};
use tauri::Manager;

/// 默认云端服务器（用户提供：bibike 服务端）。
const DEFAULT_CLOUD_BASE: &str = "http://118.31.107.214";

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

// ============== v0.6.0 云端市场 & 本地导入 ==============

fn cloud_base(user_supplied: Option<&str>) -> String {
    let s = user_supplied
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty());
    s.unwrap_or_else(|| DEFAULT_CLOUD_BASE.to_string())
}

/// 云端服务器健康检查。先 TCP 连通性 + /api/v1/health HTTP。
#[tauri::command]
pub async fn plugins_cloud_health(base_url: Option<String>) -> Result<serde_json::Value, String> {
    let base = cloud_base(base_url.as_deref());
    let start = Instant::now();
    let url = format!("{}/api/v1/health", base);
    tauri::async_runtime::spawn_blocking(move || {
        let resp = ureq::get(&url).timeout(std::time::Duration::from_secs(5)).call();
        let latency = start.elapsed().as_millis() as u64;
        match resp {
            Ok(r) => {
                let ok = r.status() >= 200 && r.status() < 300;
                let body_text = r.into_string().unwrap_or_default();
                Ok::<serde_json::Value, String>(serde_json::json!({
                    "ok": ok,
                    "baseUrl": base,
                    "message": if ok { format!("云端服务器连接正常 (HTTP {} · {}ms)", 200, latency) }
                               else { format!("服务器返回异常状态: {}", body_text.chars().take(120).collect::<String>()) },
                    "latencyMs": latency,
                }))
            }
            Err(e) => Ok(serde_json::json!({
                "ok": false,
                "baseUrl": base,
                "message": format!("无法连接云端服务器 ({}): {}", base, e),
                "latencyMs": latency,
            })),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 拉取云端市场可下载的插件/skill 列表。
/// 当前 bibike 服务端尚未暴露 /api/v1/market 端点（404），这里先请求；
/// 失败时返回空列表并标注「服务端尚未开启市场」，前端 UI 仍可正常渲染。
#[tauri::command]
pub async fn plugins_cloud_list(base_url: Option<String>) -> Result<serde_json::Value, String> {
    let base = cloud_base(base_url.as_deref());
    tauri::async_runtime::spawn_blocking(move || {
        // 尝试 1) /api/v1/market 2) /api/v1/plugins 3) /api/v1/admin/plugins
        let candidates = [
            ("market", format!("{}/api/v1/market", base)),
            ("plugins", format!("{}/api/v1/plugins", base)),
            ("marketplace", format!("{}/api/v1/marketplace", base)),
            ("skills", format!("{}/api/v1/skills", base)),
        ];
        let mut last_err: Option<String> = None;
        for (tag, url) in &candidates {
            match ureq::get(url).timeout(std::time::Duration::from_secs(5)).call() {
                Ok(r) if r.status() >= 200 && r.status() < 300 => {
                    match r.into_json::<serde_json::Value>() {
                        Ok(v) => {
                            // 规范化：兼容 { data: { items: [...] } } 或 { items: [...] } 或 [ ... ]
                            let items = extract_items(&v);
                            return Ok::<serde_json::Value, String>(serde_json::json!({
                                "ok": true,
                                "items": items,
                                "message": format!("从 /api/v1/{} 拉取成功，共 {} 项", tag, items.len()),
                            }));
                        }
                        Err(e) => last_err = Some(format!("解析 JSON 失败: {}", e)),
                    }
                }
                Ok(r) => last_err = Some(format!("HTTP {}: {}", r.status(), r.into_string().unwrap_or_default().chars().take(100).collect::<String>())),
                Err(e) => last_err = Some(e.to_string()),
            }
        }
        // 所有端点都不可用 → 返回空清单但 ok=true（UI 正常工作）
        Ok(serde_json::json!({
            "ok": true,
            "items": [],
            "message": format!(
                "服务端暂未开放插件市场 ({}); 请在 bibike 后台启用插件市场功能后刷新。{}",
                base,
                last_err.map(|s| format!(" 最近一次错误: {}", s)).unwrap_or_default()
            ),
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn extract_items(v: &serde_json::Value) -> Vec<serde_json::Value> {
    // 兼容多种返回结构
    if let Some(arr) = v.as_array() { return arr.clone(); }
    if let Some(obj) = v.as_object() {
        if let Some(items) = obj.get("items").and_then(|x| x.as_array()) { return items.clone(); }
        if let Some(data) = obj.get("data") {
            if let Some(arr) = data.as_array() { return arr.clone(); }
            if let Some(obj2) = data.as_object() {
                if let Some(items) = obj2.get("items").and_then(|x| x.as_array()) { return items.clone(); }
            }
        }
    }
    Vec::new()
}

/// 从云端下载并安装单个插件/skill。
/// 由于云端下载端点暂不可用（404），会返回错误并提示"请稍后"；
/// 一旦服务端提供下载，该端点按规范从 downloadUrl 拉取 ZIP 并解压到
/// `<codex_home>/skills/` 或 `<codex_home>/plugins/`。
#[tauri::command]
pub async fn plugins_cloud_install(
    codex_home: String,
    item_id: String,
    base_url: Option<String>,
) -> Result<serde_json::Value, String> {
    let base = cloud_base(base_url.as_deref());
    let item_id = item_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // 下载端点格式：GET /api/v1/market/{item_id}/download → 返回 ZIP
        let download_url = format!("{}/api/v1/market/{}/download", base, item_id);
        let resp = ureq::get(&download_url)
            .timeout(std::time::Duration::from_secs(60))
            .call();
        let resp = match resp {
            Ok(r) if r.status() >= 200 && r.status() < 300 => r,
            Ok(r) => return Ok(serde_json::json!({
                "ok": false,
                "installedDir": "",
                "message": format!("下载失败 (HTTP {}): {}", r.status(), r.into_string().unwrap_or_default().chars().take(150).collect::<String>()),
            })),
            Err(e) => return Ok(serde_json::json!({
                "ok": false,
                "installedDir": "",
                "message": format!("下载端点不可用，请先在服务端 118.31.107.214 启用插件市场下载接口。错误: {}", e),
            })),
        };

        // 读取二进制流 → 临时 ZIP → 解压
        let tmp = std::env::temp_dir().join(format!("harness-cloud-{}.zip", std::process::id()));
        let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let mut reader = resp.into_reader();
        std::io::copy(&mut reader, &mut f).map_err(|e| e.to_string())?;
        drop(f);

        let installed = install_from_zip(&tmp, &codex_home)?;
        let _ = std::fs::remove_file(&tmp);

        Ok::<serde_json::Value, String>(serde_json::json!({
            "ok": true,
            "installedDir": installed,
            "message": "安装成功，点击刷新后可在「已安装」页看到",
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 本地导入：把用户选择的目录（含 SKILL.md 或 plugin.toml）拷贝到 codex_home 对应子目录，
/// 并写入 config.toml 启用规则。source_path 为空时返回错误（前端应先让用户填写/选择路径）。
#[tauri::command]
pub async fn plugins_import_local(
    app: tauri::AppHandle,
    codex_home: String,
    source_path: Option<String>,
    kind: Option<String>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let src = match source_path {
            Some(s) if !s.trim().is_empty() => PathBuf::from(s.trim()),
            _ => return Ok(serde_json::json!({
                "ok": false,
                "installedDir": "",
                "message": "请填写插件/skill 的本地目录完整路径，或先打包为 ZIP 后选择文件。",
            })),
        };
        if !src.exists() {
            return Ok(serde_json::json!({
                "ok": false,
                "installedDir": "",
                "message": format!("路径不存在: {}", src.display()),
            }));
        }

        // 自动判断类型
        let k = match kind.as_deref() {
            Some("skill") => "skill",
            Some("plugin") => "plugin",
            _ => auto_detect_kind(&src),
        };

        // ZIP → 解压到临时目录再安装
        let (final_src, _tmp_cleanup) = if src.is_file() && src.extension().and_then(|e| e.to_str()) == Some("zip") {
            let tmp = std::env::temp_dir().join(format!("harness-import-{}-{}", std::process::id(), rand_suffix()));
            std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
            let extracted = extract_zip_to(&src, &tmp)?;
            let k_extracted = auto_detect_kind(&extracted);
            (extracted, Some((tmp, k_extracted)))
        } else {
            (src.clone(), None)
        };

        let k: &str = match &_tmp_cleanup {
            Some((_, stored_k)) => stored_k,
            None => k,
        };
        let installed = install_from_dir(&final_src, &codex_home, k)?;

        // 写回启用规则
        let mut cfg = harness_config::read(&codex_home).map_err(|e| e.to_string())?;
        let dir_str = installed.to_string_lossy().to_string();
        if k == "skill" {
            if !cfg.skills.iter().any(|r| r.path == dir_str) {
                cfg.skills.push(SkillRule { name: String::new(), path: dir_str.clone(), enabled: true });
            }
        } else {
            // plugin: 读取 id（基于目录名或 plugin.toml）
            let pid = plugin_id_from(&installed);
            if !cfg.plugins.iter().any(|r| r.id == pid) {
                cfg.plugins.push(PluginRule { id: pid, enabled: true });
            }
        }
        harness_config::write(&codex_home, &cfg).map_err(|e| e.to_string())?;

        // 清理 ZIP 解压临时目录
        if let Some((tmp, _)) = _tmp_cleanup {
            let _ = std::fs::remove_dir_all(&tmp);
        }

        Ok::<serde_json::Value, String>(serde_json::json!({
            "ok": true,
            "installedDir": dir_str,
            "message": format!("本地导入成功 ({}), 已自动启用。", if k == "skill" { "skill" } else { "插件" }),
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ============== helpers ==============

fn auto_detect_kind(p: &Path) -> &'static str {
    if p.is_dir() {
        if p.join("SKILL.md").is_file() { return "skill"; }
        if p.join("plugin.toml").is_file() { return "plugin"; }
        // 兜底：看是否只含子目录（ZIP 打包时外层多加了一层目录）
        if let Ok(rd) = std::fs::read_dir(p) {
            for e in rd.flatten() {
                let ep = e.path();
                if ep.is_dir() {
                    if ep.join("SKILL.md").is_file() { return "skill"; }
                    if ep.join("plugin.toml").is_file() { return "plugin"; }
                }
            }
        }
    }
    "skill" // 无法判断时默认 skill
}

fn install_from_dir(src: &Path, codex_home: &str, kind: &str) -> Result<PathBuf, String> {
    let name = src.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("imported-{}", rand_suffix()));
    let target_root = PathBuf::from(codex_home).join(if kind == "plugin" { "plugins" } else { "skills" });
    let target = target_root.join(sanitize_name(&name));
    copy_dir_recursive(src, &target)?;
    Ok(target)
}

fn install_from_zip(zip_path: &Path, codex_home: &str) -> Result<String, String> {
    let tmp = std::env::temp_dir().join(format!("harness-cloud-install-{}-{}", std::process::id(), rand_suffix()));
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let extracted = extract_zip_to(zip_path, &tmp)?;
    let kind = auto_detect_kind(&extracted);
    let installed = install_from_dir(&extracted, codex_home, kind)?;
    let _ = std::fs::remove_dir_all(&tmp);
    Ok(installed.to_string_lossy().to_string())
}

fn extract_zip_to(zip_path: &Path, dst: &Path) -> Result<PathBuf, String> {
    use std::io::Read;
    let file = std::fs::File::open(zip_path).map_err(|e| format!("open zip: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("read zip: {e}"))?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("zip entry: {e}"))?;
        let ep = entry.enclosed_name().ok_or_else(|| "invalid zip path".to_string())?.to_path_buf();
        let target = dst.join(&ep);
        if entry.is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| format!("mkdir: {e}"))?;
        } else {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("mkdir parent: {e}"))?;
            }
            let mut out = std::fs::File::create(&target).map_err(|e| format!("create: {e}"))?;
            std::io::copy(&mut entry, &mut out).map_err(|e| format!("write: {e}"))?;
        }
    }
    // 若压缩包内仅一个顶层目录则进入
    let mut dirs: Vec<PathBuf> = Vec::new();
    for e in std::fs::read_dir(dst).map_err(|e| e.to_string())? {
        let ep = e.map_err(|e| e.to_string())?.path();
        if ep.is_dir() { dirs.push(ep); } else {
            // 存在散文件 → 直接返回 dst
            return Ok(dst.to_path_buf());
        }
    }
    if dirs.len() == 1 { Ok(dirs.swap_remove(0)) } else { Ok(dst.to_path_buf()) }
}

fn plugin_id_from(dir: &Path) -> String {
    // 优先读 plugin.toml 的 id
    if let Ok(txt) = std::fs::read_to_string(dir.join("plugin.toml")) {
        for line in txt.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("id") {
                let rest = rest.trim_start_matches(' ').trim_start_matches('=').trim();
                let v = rest.trim_matches('"').trim_matches('\'');
                if !v.is_empty() { return v.to_string(); }
            }
        }
    }
    dir.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "unknown-plugin".into())
}

fn sanitize_name(name: &str) -> String {
    let mut s = String::new();
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' { s.push(ch); }
        else { s.push('_'); }
    }
    if s.is_empty() { s.push_str("imported"); }
    s
}

fn rand_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{:x}", nanos & 0xffff_ffff)
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
