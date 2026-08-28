//! T05：把 `codex app-server` 的 stdio 客户端接入 Tauri 后端。
//!
//! 以 `Arc<Mutex<Option<AppServerClient>>>` 为全局状态，命令均经
//! `tauri::async_runtime::spawn_blocking` 执行，避免阻塞主线程/UI。
//! 前端可通过这些命令启动 codex、创建会话、发起对话（T06 在此之上叠加流式 UI）。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use harness_appserver::{AppServerClient, AppServerConfig};
use serde_json::Value;
use tauri::State;

/// 全局持有的（可选）app-server 连接。
pub type CodexHandle = Arc<Mutex<Option<AppServerClient>>>;

/// 注册为 Tauri 托管状态。
pub fn managed_state() -> CodexHandle {
    Arc::new(Mutex::new(None))
}

/// 启动 `codex app-server` 子进程并完成 `initialize` 握手。
///
/// `codex_home` 用作 `CODEX_HOME` 环境变量；也可从后端环境透传 `MOCK_KEY`
///（本地 stub 测试用）。返回 `initialize` 响应的 `userAgent`。
#[tauri::command]
pub async fn appserver_start(
    state: State<'_, CodexHandle>,
    codex_bin: String,
    codex_home: String,
) -> Result<String, String> {
    let state = state.inner().clone();
    let codex_bin2 = codex_bin.clone();
    let home = codex_home.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut env = HashMap::new();
        env.insert("CODEX_HOME".to_string(), home);
        if let Ok(m) = std::env::var("MOCK_KEY") {
            env.insert("MOCK_KEY".to_string(), m);
        }
        let cfg = AppServerConfig {
            codex_bin: codex_bin2,
            env: Some(env),
            cwd: None,
            default_timeout_ms: 90_000,
            ..Default::default()
        };
        let mut client = AppServerClient::new(cfg).map_err(|e| e.to_string())?;
        let init = client.initialize("harness-app", "0.1.0").map_err(|e| e.to_string())?;
        let user_agent = init["userAgent"].as_str().unwrap_or("harness").to_string();
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        *guard = Some(client);
        Ok::<String, String>(user_agent)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 创建新会话线程，返回 thread id。
#[tauri::command]
pub async fn appserver_thread_start(
    state: State<'_, CodexHandle>,
    model: String,
    model_provider: String,
    cwd: String,
) -> Result<String, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        let client = guard.as_mut().ok_or("app-server not started")?;
        client.thread_start(&model, &model_provider, &cwd).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 开启一轮对话，返回 turn/start 的响应（含 turn 信息）。
#[tauri::command]
pub async fn appserver_turn_start(
    state: State<'_, CodexHandle>,
    thread_id: String,
    cwd: String,
    text: String,
) -> Result<Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        let client = guard.as_mut().ok_or("app-server not started")?;
        client.turn_start(&thread_id, &cwd, &text).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 停止 app-server 子进程。
#[tauri::command]
pub async fn appserver_stop(state: State<'_, CodexHandle>) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        if let Some(mut c) = guard.take() {
            c.shutdown();
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}