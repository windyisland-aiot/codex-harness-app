//! Harness Tauri 后端。
//!
//! T04 骨架已接通；T05 起接入 `codex app-server` stdio 客户端（`appserver` 模块）。

mod appserver;
mod config;
mod feishu;
mod oauth;
mod plugins;
mod router;
mod search;
mod sessions;

/// 前端调用的最小命令，用于验证前后端 IPC 连通（T04）。
#[tauri::command]
fn greet(name: &str) -> String {
    format!("你好，{name}（Rust 后端连通）")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}