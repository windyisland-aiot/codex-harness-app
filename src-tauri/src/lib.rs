//! Harness Tauri 后端。
//!
//! v0.3.0 架构：codex app-server 作为子进程（由 `harness-appserver` crate 管理），
//! 前端通过 JSON-RPC + 通知轮询对话。LLM API key 存于 `<codex_home>/.env-provider`，
//! 在 appserver_start 时按 config.toml 里 provider 的 `env_key` 自动注入 codex 子进程。
//!
//! 配置/会话/MCP 全部默认放在**安装目录**（`.exe` 同级 `data/`），
//! 也可通过环境变量 `HARNESS_DATA_DIR=<path>` 覆盖，便于便携部署和避免权限冲突。

mod appserver;
mod approval_feishu;
mod base;
mod cloud_bridge;
mod config;
mod feishu;
mod fs;
mod oauth;
mod plugins;
mod rag;
mod router;
mod search;
mod sessions;

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[tauri::command]
fn greet(name: &str) -> String {
    format!("你好，{name}（Rust 后端连通）")
}

/// 前端需要运行时路径。v0.3.0 起**默认存安装目录**（便携部署）。
///
/// 解析顺序：
/// 1. `HARNESS_DATA_DIR` 环境变量（显式覆盖）
/// 2. `<exe所在目录>/data/` （便携，MSI/绿色版通用，用户期望的安装目录存储）
/// 3. 回退 `<app_data_dir>/codex-home/` （兜底，权限写不了安装目录时）
///
/// 返回：
/// - `codexHome`: 上面解析到的目录（创建 codex-home 子目录）
/// - `codexBin`：资源目录 codex.exe > `HARNESS_CODEX_BIN` > PATH
/// - `defaultCwd`: `<codexHome>/workspace`
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedPaths {
    codex_home: PathBuf,
    codex_bin: PathBuf,
    default_cwd: PathBuf,
}

fn first_writable_dir(candidates: &[PathBuf]) -> Option<PathBuf> {
    for d in candidates {
        if let Some(parent) = d.parent() {
            if let Err(_) = std::fs::create_dir_all(parent) { continue; }
            match std::fs::create_dir_all(d) {
                Ok(()) => {
                    // 可写性探针：写一个临时文件测试实际权限
                    let probe = d.join(".harness-write-test");
                    match std::fs::write(&probe, "ok").and_then(|_| std::fs::remove_file(&probe)) {
                        Ok(()) => return Some(d.clone()),
                        Err(_) => { let _ = std::fs::remove_file(&probe); continue; }
                    }
                }
                Err(_) => continue,
            }
        }
    }
    None
}

#[tauri::command]
fn harness_resolve_paths(app: AppHandle) -> Result<ResolvedPaths, String> {
    let fn_ensure = |dir: &Path| -> Result<PathBuf, String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("mkdir {:?}: {e}", dir))?;
        Ok(dir.to_path_buf())
    };

    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()));

    let app_data_dir = app
        .path()
        .app_data_dir()
        .ok();

    // ---- 候选 1：显式 HARNESS_DATA_DIR ----
    let forced = std::env::var("HARNESS_DATA_DIR").ok().map(PathBuf::from);

    // ---- 候选 2：exe 同级 data/ ----
    let portable = exe_dir.as_ref().map(|d| d.join("data"));

    // ---- 候选 3：Tauri app_data_dir/codex-home ----
    let fallback = app_data_dir.as_ref().map(|d| d.join("codex-home"));

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(p) = forced { candidates.push(p); }
    if let Some(p) = portable { candidates.push(p); }
    if let Some(p) = fallback { candidates.push(p); }

    let base = first_writable_dir(&candidates)
        .unwrap_or_else(|| candidates.first().cloned().unwrap_or_else(|| PathBuf::from("./data")));

    let codex_home = fn_ensure(&base)?;
    let default_cwd = fn_ensure(&codex_home.join("workspace"))?;

    // codex 二进制：资源目录 > HARNESS_CODEX_BIN > PATH
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resolve resource_dir: {e}"))?;
    let bin_name = if cfg!(windows) { "codex.exe" } else { "codex" };
    let bin_candidate = resource_dir.join(bin_name);
    let codex_bin = if bin_candidate.is_file() {
        bin_candidate
    } else if let Ok(env_bin) = std::env::var("HARNESS_CODEX_BIN") {
        PathBuf::from(env_bin)
    } else {
        PathBuf::from(bin_name)
    };

    Ok(ResolvedPaths {
        codex_home,
        codex_bin,
        default_cwd,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .manage(appserver::managed_state())
        .manage(cloud_bridge::managed_state())
        .setup(|_app| Ok(()))
        .invoke_handler(tauri::generate_handler![
            greet,
            appserver::appserver_start,
            appserver::appserver_thread_start,
            appserver::appserver_turn_start,
            appserver::appserver_turn_interrupt,
            appserver::appserver_thread_resume,
            appserver::appserver_thread_read,
            appserver::appserver_poll_events,
            appserver::appserver_poll_approvals,
            appserver::appserver_respond_approval,
            appserver::appserver_stop,
            appserver::harness_creds_read,
            appserver::harness_creds_write,
            config::config_read,
            config::config_write,
            router::router_resolve,
            feishu::feishu_register_mcp,
            feishu::feishu_status,
            oauth::feishu_oauth_app_token,
            oauth::feishu_oauth_authorize_url,
            oauth::feishu_oauth_exchange,
            oauth::feishu_oauth_refresh,
            plugins::plugins_list,
            plugins::plugins_apply,
            plugins::plugins_add_skill_dir,
            // v0.6.0 云端市场 & 本地导入
            plugins::plugins_cloud_health,
            plugins::plugins_cloud_list,
            plugins::plugins_cloud_install,
            plugins::plugins_import_local,
            search::search_execute,
            search::search_register_mcp,
            search::search_status,
            rag::rag_register,
            rag::rag_status,
            rag::rag_health,
            rag::rag_search,
            base::base_register_mcp,
            base::base_status,
            base::base_health,
            approval_feishu::approval_send_to_feishu,
            sessions::session_save,
            sessions::session_list,
            sessions::session_search,
            sessions::session_get,
            sessions::session_rename,
            sessions::session_delete,
            fs::fs_list_dir,
            fs::fs_read_file,
            fs::fs_write_file,
            fs::fs_write_file_b64,
            harness_resolve_paths,
            // B2 云端 codex 执行桥
            cloud_bridge::cloud_login,
            cloud_bridge::cloud_mode_set,
            cloud_bridge::cloud_mode_get,
            cloud_bridge::cloud_health,
            cloud_bridge::cloud_skills_sync,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
