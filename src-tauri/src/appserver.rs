//! T05/T06：把 `codex app-server` 的 stdio 客户端接入 Tauri 后端。
//!
//! 全局状态 `CodexState` 保存：
//! - `client`：可选的 `AppServerClient`；
//! - `events`：后端从 app-server 收到的全部通知（供前端轮询渲染，如
//!   `item/agentMessage/delta`、`turn/completed`）；
//! - `approvals`：后端收到的审批请求（`item/commandExecution/requestApproval`
//!   / `execCommandApproval`），T08 审批面板消费。
//!
//! 命令均经 `spawn_blocking` 执行，避免阻塞主线程/UI。

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use harness_appserver::{AppServerClient, AppServerConfig};
use serde_json::Value;
use tauri::State;

/// 全局托管的 app-server 状态。
pub struct CodexState {
    pub client: Mutex<Option<AppServerClient>>,
    /// 通知事件缓冲：(method, params)。前端调用 [`appserver_poll_events`] 取走。
    pub events: Mutex<VecDeque<(String, Value)>>,
    /// 审批请求缓冲：(jsonrpc_id, method, params)。T08 消费。
    pub approvals: Mutex<VecDeque<(u64, String, Value)>>,
}

pub type CodexHandle = Arc<CodexState>;

/// 注册为 Tauri 托管状态。
pub fn managed_state() -> CodexHandle {
    Arc::new(CodexState {
        client: Mutex::new(None),
        events: Mutex::new(VecDeque::new()),
        approvals: Mutex::new(VecDeque::new()),
    })
}

/// 启动 `codex app-server` 子进程并完成 `initialize` 握手。
///
/// `env` 为注入到 codex 子进程的额外环境变量（如 provider 的 API key，
/// `OPENAI_API_KEY`/自定义 `env_key`），值不写入 config.toml（T07 安全传递）。
#[tauri::command]
pub async fn appserver_start(
    state: State<'_, CodexHandle>,
    codex_bin: String,
    codex_home: String,
    env: Option<HashMap<String, String>>,
) -> Result<String, String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut child_env = HashMap::new();
        child_env.insert("CODEX_HOME".to_string(), codex_home);
        if let Some(extra) = env {
            child_env.extend(extra);
        }
        // 兼容老测试：透传 MOCK_KEY（若有）。
        if let Ok(m) = std::env::var("MOCK_KEY") {
            child_env.entry("MOCK_KEY".to_string()).or_insert(m);
        }
        let st_notif = st.clone();
        let st_req = st.clone();
        let cfg = AppServerConfig {
            codex_bin,
            env: Some(child_env),
            cwd: None,
            default_timeout_ms: 90_000,
            on_notification: Some(Box::new(move |method, params| {
                let mut g = st_notif.events.lock().unwrap();
                if g.len() > 100_000 {
                    g.pop_front();
                }
                g.push_back((method.to_string(), Value::Object(params.clone())));
            })),
            on_server_request: Some(Box::new(move |req_id, method, params| {
                // 审批请求先在缓冲中登记，交由 T08 审批面板决定回包；
                // 此层不自动回包（返回 None 表示稍后由业务侧回包）。
                let mut g = st_req.approvals.lock().unwrap();
                g.push_back((req_id, method.to_string(), Value::Object(params.clone())));
                None
            })),
            ..Default::default()
        };
        let mut client = AppServerClient::new(cfg).map_err(|e| e.to_string())?;
        let init = client.initialize("harness-app", "0.1.0").map_err(|e| e.to_string())?;
        let user_agent = init["userAgent"].as_str().unwrap_or("harness").to_string();
        *st.client.lock().map_err(|e| e.to_string())? = Some(client);
        Ok::<String, String>(user_agent)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 创建新会话线程，返回 thread id。
///
/// `model`/`model_provider` 为空串时交给 codex 从 `config.toml` 解析
/// （T07 单模型配置驱动）。
#[tauri::command]
pub async fn appserver_thread_start(
    state: State<'_, CodexHandle>,
    model: String,
    model_provider: String,
    cwd: String,
) -> Result<String, String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = st.client.lock().map_err(|e| e.to_string())?;
        let client = guard.as_mut().ok_or("app-server 未启动")?;
        let m = if model.is_empty() { None } else { Some(model.as_str()) };
        let p = if model_provider.is_empty() { None } else { Some(model_provider.as_str()) };
        client.thread_start(m, p, &cwd).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 开启一轮对话，返回 turn/start 响应。
#[tauri::command]
pub async fn appserver_turn_start(
    state: State<'_, CodexHandle>,
    thread_id: String,
    cwd: String,
    text: String,
) -> Result<Value, String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = st.client.lock().map_err(|e| e.to_string())?;
        let client = guard.as_mut().ok_or("app-server 未启动")?;
        client.turn_start(&thread_id, &cwd, &text).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 轮询并取走自上次以来缓冲的通知（`[{method, params}, ...]`）。
#[tauri::command]
pub async fn appserver_poll_events(state: State<'_, CodexHandle>) -> Result<Vec<Value>, String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut g = st.events.lock().map_err(|e| e.to_string())?;
        let out: Vec<Value> = g
            .drain(..)
            .map(|(method, params)| serde_json::json!({ "method": method, "params": params }))
            .collect();
        Ok::<Vec<Value>, String>(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 停止 app-server 子进程。
#[tauri::command]
pub async fn appserver_stop(state: State<'_, CodexHandle>) -> Result<(), String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = st.client.lock().map_err(|e| e.to_string())?;
        if let Some(mut c) = guard.take() {
            c.shutdown();
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}