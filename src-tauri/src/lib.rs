//! Harness Tauri 后端。
//!
//! T04 骨架已接通；T05 起接入 `codex app-server` stdio 客户端（`appserver` 模块）。

mod appserver;
mod ark_gateway;
mod config;
mod feishu;
mod oauth;
mod plugins;
mod router;
mod search;
mod sessions;

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// 前端调用的最小命令，用于验证前后端 IPC 连通（T04）。
#[tauri::command]
fn greet(name: &str) -> String {
    format!("你好，{name}（Rust 后端连通）")
}

/// 前端需要运行时路径：避免硬编码 `/workspace/...` 导致 Windows 上路径不存在。
///
/// 返回：
/// - `codexHome`: `<appDataDir>/codex-home`（每用户独立，Tauri 会自动保证存在）
/// - `codexBin`：优先 `<resourceDir>/codex.exe`（随 MSI 打包），否则回退到环境变量
///   `HARNESS_CODEX_BIN`，再退化为 `codex`（PATH 查找）
/// - `defaultCwd`: `<appDataDir>/workspace`（Codex 的 exec_command 沙箱默认工作目录）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedPaths {
    codex_home: PathBuf,
    codex_bin: PathBuf,
    default_cwd: PathBuf,
}

#[tauri::command]
fn harness_resolve_paths(app: AppHandle) -> Result<ResolvedPaths, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir: {e}"))?;

    fn ensure(dir: &Path) -> Result<PathBuf, String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("mkdir {:?}: {e}", dir))?;
        Ok(dir.to_path_buf())
    }

    let codex_home = ensure(&app_data_dir.join("codex-home"))?;
    let default_cwd = ensure(&app_data_dir.join("workspace"))?;

    // codex 二进制：资源目录 > 环境变量 > PATH
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
        .setup(|_app| Ok(()))
        .invoke_handler(tauri::generate_handler![
            greet,
            appserver::appserver_start,
            appserver::appserver_thread_start,
            appserver::appserver_turn_start,
            appserver::appserver_thread_set_model,
            appserver::appserver_poll_events,
            appserver::appserver_poll_approvals,
            appserver::appserver_respond_approval,
            appserver::appserver_stop,
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
            search::search_execute,
            search::search_register_mcp,
            search::search_status,
            sessions::session_save,
            sessions::session_list,
            sessions::session_search,
            sessions::session_get,
            sessions::session_rename,
            sessions::session_delete,
            harness_resolve_paths,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}