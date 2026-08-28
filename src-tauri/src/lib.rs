//! Harness Tauri 后端。
//!
//! T04 骨架已接通；T05 起接入 `codex app-server` stdio 客户端（`appserver` 模块）。

mod appserver;

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
            appserver::appserver_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}