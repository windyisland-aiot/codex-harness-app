//! B2 云端 codex 执行桥客户端 — 替代本地 codex 子进程。
//!
//! 架构：
//!   前端 → Tauri IPC → cloud_turn_start() → POST /api/v1/codex/chat (SSE)
//!   后台线程逐行解析 SSE 事件，推入 CodexState.events 队列供前端轮询。
//!
//! 事件命名约定：cloud/{event_type}（与本地 codex 的 item/xxx 区分）。
//!
//! 对应文档：HARNESS_MIGRATION.md 阶段 B2。

use std::io::{BufRead, BufReader};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::State;

use crate::appserver::CodexHandle;

/// 云端桥配置（运行时状态）。
#[derive(Default, Clone)]
pub struct CloudConfig {
    /// bibike API 基地址，如 `http://118.31.107.214:8000/api/v1`。
    pub api_base: String,
    /// 登录后的 Bearer token。
    pub token: Option<String>,
    /// 当前会话 ID（云端 session_id）。
    pub session_id: Option<String>,
    /// 是否已启用云端模式。
    pub enabled: bool,
}

pub type CloudHandle = Arc<Mutex<CloudConfig>>;

pub fn managed_state() -> CloudHandle {
    Arc::new(Mutex::new(CloudConfig {
        api_base: "http://118.31.107.214:8000/api/v1".to_string(),
        ..Default::default()
    }))
}

/// 默认超时（SSE 长连接不设上限，但 login/health 用短超时）。
const SHORT_TIMEOUT: Duration = Duration::from_secs(10);

// ==================== Tauri 命令 ====================

/// 登录 bibike，获取 Bearer token。
#[tauri::command]
pub async fn cloud_login(
    state: State<'_, CloudHandle>,
    api_base: Option<String>,
    username: String,
    password: String,
) -> Result<Value, String> {
    let base = {
        let cfg = state.inner().lock().map_err(|e| e.to_string())?;
        api_base.unwrap_or_else(|| cfg.api_base.clone())
    };

    let url = format!("{}/auth/login", base.trim_end_matches('/'));
    let body = json!({ "username": username, "password": password });

    let resp = ureq::post(&url)
        .timeout(SHORT_TIMEOUT)
        .set("Content-Type", "application/json")
        .send_string(body.to_string())
        .map_err(|e| format!("登录请求失败: {e}"))?;

    let body: Value = resp.into_json().map_err(|e| format!("解析登录响应失败: {e}"))?;

    // 从 data.user.token 提取 token
    let token = body
        .get("data")
        .and_then(|d| d.get("user"))
        .and_then(|u| u.get("token"))
        .and_then(|t| t.as_str());

    if let Some(t) = token {
        let mut cfg = state.inner().lock().map_err(|e| e.to_string())?;
        cfg.api_base = base;
        cfg.token = Some(t.to_string());
        cfg.enabled = true;
    }

    Ok(body)
}

/// 设置云端模式开关（不登录也可切换，但 chat 需要 token）。
#[tauri::command]
pub async fn cloud_mode_set(
    state: State<'_, CloudHandle>,
    enabled: bool,
) -> Result<(), String> {
    let mut cfg = state.inner().lock().map_err(|e| e.to_string())?;
    cfg.enabled = enabled;
    Ok(())
}

/// 读取当前云端模式状态。
#[tauri::command]
pub async fn cloud_mode_get(state: State<'_, CloudHandle>) -> Result<Value, String> {
    let cfg = state.inner().lock().map_err(|e| e.to_string())?;
    Ok(json!({
        "enabled": cfg.enabled,
        "hasToken": cfg.token.is_some(),
        "apiBase": cfg.api_base,
        "sessionId": cfg.session_id,
    }))
}

/// 云端健康检查。
#[tauri::command]
pub async fn cloud_health(state: State<'_, CloudHandle>) -> Result<Value, String> {
    let (base, token) = {
        let cfg = state.inner().lock().map_err(|e| e.to_string())?;
        (cfg.api_base.clone(), cfg.token.clone())
    };

    let url = format!("{}/codex/health", base.trim_end_matches('/'));
    let mut req = ureq::get(&url).timeout(SHORT_TIMEOUT);
    if let Some(ref t) = token {
        req = req.set("Authorization", &format!("Bearer {t}"));
    }

    let start = std::time::Instant::now();
    match req.call() {
        Ok(resp) => {
            let latency = start.elapsed().as_millis();
            let body: Value = resp.into_json().unwrap_or(json!({"status": "ok"}));
            Ok(json!({
                "ok": true,
                "reachable": true,
                "latencyMs": latency,
                "data": body,
            }))
        }
        Err(e) => Ok(json!({
            "ok": false,
            "reachable": false,
            "message": format!("{e}"),
        })),
    }
}

/// 创建云端会话（生成 UUID 作为 session_id）。
#[tauri::command]
pub async fn cloud_thread_start(
    state: State<'_, CloudHandle>,
) -> Result<String, String> {
    let session_id = format!(
        "h-{:04x}{:04x}-{:04x}-{:04x}-{:04x}-{:04x}{:04x}{:04x}",
        rand_u16(), rand_u16(), rand_u16(), rand_u16(),
        rand_u16(), rand_u16(), rand_u16(), rand_u16(),
    );
    let mut cfg = state.inner().lock().map_err(|e| e.to_string())?;
    cfg.session_id = Some(session_id.clone());
    Ok(session_id)
}

/// 发送消息到云端 codex 桥，SSE 流在后台线程消费。
///
/// 事件推入 CodexState.events 队列，method 前缀 `cloud/`：
/// - `cloud/status`        → {"stage": "intake|retrieving|generating|guard"}
/// - `cloud/intake_question` → {"question": "...", "reason": "..."}
/// - `cloud/result`        → {"script", "creative_notes", ...}
/// - `cloud/turn_completed`→ 表示本轮结束
/// - `cloud/error`         → {"message": "..."}
#[tauri::command]
pub async fn cloud_turn_start(
    cloud_state: State<'_, CloudHandle>,
    codex_state: State<'_, CodexHandle>,
    session_id: String,
    text: String,
    brief: Option<Value>,
) -> Result<(), String> {
    let (base, token) = {
        let cfg = cloud_state.inner().lock().map_err(|e| e.to_string())?;
        (cfg.api_base.clone(), cfg.token.clone())
    };

    let token = token.ok_or("未登录：请先调 cloud_login")?;
    let url = format!("{}/codex/chat", base.trim_end_matches('/'));

    let body = json!({
        "session_id": session_id,
        "messages": [{ "role": "user", "content": text }],
        "brief": brief.unwrap_or(json!({})),
    });

    let codex_st = codex_state.inner().clone();

    // 后台线程消费 SSE 流
    tauri::async_runtime::spawn_blocking(move || {
        let log = |msg: &str| eprintln!("[cloud_bridge] {msg}");

        log(&format!("→ POST {} session={}", url, session_id));

        let resp = ureq::post(&url)
            .set("Authorization", &format!("Bearer {token}"))
            .set("Content-Type", "application/json")
            .set("Accept", "text/event-stream")
            .timeout(Duration::from_secs(300)) // SSE 长连接
            .send_string(body.to_string());

        let resp = match resp {
            Ok(r) => r,
            Err(e) => {
                let msg = format!("SSE 连接失败: {e}");
                log(&msg);
                push_event(&codex_st, "cloud/error", json!({ "message": msg }));
                push_event(&codex_st, "cloud/turn_completed", json!({}));
                return;
            }
        };

        log(&format!("← SSE 流开始 (status={})", resp.status()));

        let reader = BufReader::new(resp.into_reader());
        let mut current_event = String::new();
        let mut current_data = String::new();

        for line_result in reader.lines() {
            let line = match line_result {
                Ok(l) => l,
                Err(e) => {
                    log(&format!("SSE 读行结束: {e}"));
                    break;
                }
            };

            let trimmed = line.trim();

            // SSE 协议解析
            if trimmed.is_empty() {
                // 空行 = 事件边界，派发当前事件
                if !current_data.is_empty() {
                    dispatch_sse_event(&codex_st, &current_event, &current_data, &log);
                    current_event.clear();
                    current_data.clear();
                }
                continue;
            }

            if let Some(val) = trimmed.strip_prefix("event:") {
                current_event = val.trim().to_string();
            } else if let Some(val) = trimmed.strip_prefix("data:") {
                let data_part = val.trim();
                if current_data.is_empty() {
                    current_data = data_part.to_string();
                } else {
                    current_data.push('\n');
                    current_data.push_str(data_part);
                }
            }
            // 忽略其他 SSE 字段（id:, retry:, 注释 :）
        }

        // 流结束后派发最后一个事件
        if !current_data.is_empty() {
            dispatch_sse_event(&codex_st, &current_event, &current_data, &log);
        }

        log("SSE 流结束");
        push_event(&codex_st, "cloud/turn_completed", json!({}));
    })
    .await
    .map_err(|e| format!("后台任务启动失败: {e}"))?;

    Ok(())
}

/// 从云端同步 skill 列表。
#[tauri::command]
pub async fn cloud_skills_sync(
    state: State<'_, CloudHandle>,
) -> Result<Value, String> {
    let (base, token) = {
        let cfg = state.inner().lock().map_err(|e| e.to_string())?;
        (cfg.api_base.clone(), cfg.token.clone())
    };

    let token = token.ok_or("未登录")?;
    let url = format!("{}/plugins/sync", base.trim_end_matches('/'));

    let resp = ureq::get(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(SHORT_TIMEOUT)
        .call()
        .map_err(|e| format!("skill 同步失败: {e}"))?;

    let body: Value = resp.into_json().map_err(|e| format!("解析响应失败: {e}"))?;
    Ok(body)
}

// ==================== 内部工具 ====================

fn push_event(st: &CodexHandle, method: &str, params: Value) {
    let mut g = st.events.lock().unwrap();
    if g.len() > 200_000 {
        g.pop_front();
    }
    g.push_back((method.to_string(), params));
}

fn dispatch_sse_event(
    st: &CodexHandle,
    event: &str,
    data: &str,
    log: &impl Fn(&str),
) {
    // 尝试解析 JSON data
    let params: Value = serde_json::from_str(data)
        .unwrap_or_else(|_| json!({ "raw": data }));

    let method = match event {
        "status" => "cloud/status",
        "intake_question" => "cloud/intake_question",
        "result" => "cloud/result",
        other => {
            // 未知事件也推入，用 cloud/ 前缀
            log(&format!("  未知 SSE 事件: {other}"));
            // 如果 data 包含 stage 字段，可能是 status
            "cloud/unknown"
        }
    };

    log(&format!("  事件: {method}"));
    push_event(st, method, params);
}

/// 简易随机 u16（不依赖 rand crate）。
fn rand_u16() -> u16 {
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let nanos = dur.subsec_nanos() as u64;
    let secs = dur.as_secs();
    // 混合秒+纳秒生成伪随机
    let mixed = secs.wrapping_mul(nanos).wrapping_add(0x9E37_79B9_7F4A_7C15);
    (mixed >> 48) as u16
}
