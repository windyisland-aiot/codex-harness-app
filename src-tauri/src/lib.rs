//! Harness Tauri 后端。
//!
//! T04 骨架阶段：
//! - 暴露 `greet` 命令，供前端校验 Tauri IPC 已接通；
//! - 初始化 tauri-plugin-shell（T05 将用它在后端启动 `codex app-server` 子进程）；
//! 后续 T02 登录 / T05 app-server stdio / T08 审批 在此层接入。

/// 前端调用的最小命令，用于验证前后端 IPC 连通。
#[tauri::command]
fn greet(name: &str) -> String {
    format!("你好，{name}（Rust 后端连通）")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let _ = app; // 预留：后续在此装载 auth 服务与 codex 子进程管理器。
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}