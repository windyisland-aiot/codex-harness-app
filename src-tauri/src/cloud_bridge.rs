//! 云端登录与鉴权桥（v0.7.0）。
//!
//! codex 跑在本地，服务端只承担三件事：LLM 代理、知识库、账号。本模块负责登录
//! 拿到 token，并把 token + api_base 存在运行时状态里；`appserver_start` 启动
//! 本地 codex 时读取它们，把 base_url 指向服务端 `/api/v1/llm` 代理、并以登录
//! token 作 Bearer（真实模型 base_url / api_key 只存在服务端）。
//!
//! 云端 codex 执行桥（/codex/chat SSE）已随服务端容器一并移除。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::State;


/// 登录态（运行时状态）。
#[derive(Default, Clone)]
pub struct CloudConfig {
    /// bibike 服务端基地址（不带 /api/v1 前缀）。
    pub api_base: String,
    /// 登录后的 Bearer token。
    pub token: Option<String>,
    /// 登录用户名：会话库按账号分文件，避免多账号共用一台机器时历史串混。
    pub username: Option<String>,
    /// 是否已启用服务端链路（关闭则退化为纯本地、无模型可用）。
    pub enabled: bool,
}

pub type CloudHandle = Arc<Mutex<CloudConfig>>;

pub fn managed_state() -> CloudHandle {
    Arc::new(Mutex::new(CloudConfig {
        // base 不带 /api/v1 前缀（与 HARNESS_BACKEND_API.md §1 约定一致）：
        // auth/login、plugins/sync 直接拼；llm 代理与 market 自行拼 /api/v1。
        api_base: "http://118.31.107.214".to_string(),
        // 默认启用：首次启动引导登录，拿到 token 后本地 codex 才能用模型。
        enabled: true,
        ..Default::default()
    }))
}

/// login / health / plugins-sync 的短超时。
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
        .send_string(&body.to_string())
        .map_err(|e| format!("登录请求失败: {e}"))?;

    let body: Value = resp.into_json().map_err(|e| format!("解析登录响应失败: {e}"))?;

    // 从 data.user.token 提取 token
    let token = body
        .get("data")
        .and_then(|d| d.get("user"))
        .and_then(|u| u.get("token"))
        .and_then(|t| t.as_str());

    if let Some(t) = token {
        let login_name = body
            .get("data")
            .and_then(|d| d.get("user"))
            .and_then(|u| u.get("username"))
            .and_then(|u| u.as_str())
            .unwrap_or(&username)
            .to_string();
        let mut cfg = state.inner().lock().map_err(|e| e.to_string())?;
        cfg.api_base = base;
        cfg.token = Some(t.to_string());
        cfg.username = Some(login_name);
        cfg.enabled = true;
        // 返回前端期望的 CloudLoginResult 结构
        Ok(json!({
            "ok": true,
            "token": t,
            "user": {
                "id": body.get("data").and_then(|d| d.get("user")).and_then(|u| u.get("id")).cloned().unwrap_or(json!(null)),
                "username": body.get("data").and_then(|d| d.get("user")).and_then(|u| u.get("username")).and_then(|u| u.as_str()).unwrap_or(""),
                "role": body.get("data").and_then(|d| d.get("user")).and_then(|u| u.get("role")).and_then(|u| u.as_str()).unwrap_or(""),
            }
        }))
    } else {
        // token 缺失视为登录失败，把服务端的错误信息带回去便于排障
        let msg = body.get("detail")
            .map(|d| d.to_string())
            .or_else(|| body.get("message").and_then(|m| m.as_str()).map(String::from))
            .unwrap_or_else(|| format!("登录失败：响应中缺少 token，原始响应: {body}"));
        Err(msg)
    }
}

/// 设置服务端链路开关（不登录也可切换，但模型请求需要 token）。
#[tauri::command]
pub async fn cloud_mode_set(
    state: State<'_, CloudHandle>,
    enabled: bool,
) -> Result<(), String> {
    let mut cfg = state.inner().lock().map_err(|e| e.to_string())?;
    cfg.enabled = enabled;
    Ok(())
}

/// 读取当前登录态 / 服务端链路状态。
#[tauri::command]
pub async fn cloud_mode_get(state: State<'_, CloudHandle>) -> Result<Value, String> {
    let cfg = state.inner().lock().map_err(|e| e.to_string())?;
    Ok(json!({
        "enabled": cfg.enabled,
        "hasToken": cfg.token.is_some(),
        "apiBase": cfg.api_base,
        "username": cfg.username,
    }))
}

/// 服务端 LLM 代理连通性探测（上游是否可达、管理员是否已配置）。
#[tauri::command]
pub async fn cloud_health(state: State<'_, CloudHandle>) -> Result<Value, String> {
    let (base, token) = {
        let cfg = state.inner().lock().map_err(|e| e.to_string())?;
        (cfg.api_base.clone(), cfg.token.clone())
    };

    let url = format!("{}/api/v1/llm/health", base.trim_end_matches('/'));
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

/// 从云端同步 skill / 插件清单（`GET /plugins/sync`）。
///
/// 真正的落盘由 `plugins` 模块负责；这里只负责带登录态拿清单。
#[tauri::command]
pub async fn cloud_skills_sync(state: State<'_, CloudHandle>) -> Result<Value, String> {
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

    resp.into_json().map_err(|e| format!("解析响应失败: {e}"))
}

/// 影刀 RPA 任务列表（GET /api/v1/yingdao/tasks）。
#[tauri::command]
pub async fn yingdao_list_tasks(state: State<'_, CloudHandle>) -> Result<Value, String> {
    let (base, token) = {
        let cfg = state.inner().lock().map_err(|e| e.to_string())?;
        (cfg.api_base.clone(), cfg.token.clone())
    };
    let token = token.ok_or("未登录")?;
    let url = format!("{}/api/v1/yingdao/tasks", base.trim_end_matches('/'));

    let resp = ureq::get(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(SHORT_TIMEOUT)
        .call()
        .map_err(|e| format!("获取影刀任务失败: {e}"))?;

    resp.into_json().map_err(|e| format!("解析响应失败: {e}"))
}

/// 触发指定影刀任务（POST /api/v1/yingdao/tasks/{id}/trigger）。
#[tauri::command]
pub async fn yingdao_trigger_task(
    state: State<'_, CloudHandle>,
    task_id: u64,
    payload: Option<Value>,
) -> Result<Value, String> {
    let (base, token) = {
        let cfg = state.inner().lock().map_err(|e| e.to_string())?;
        (cfg.api_base.clone(), cfg.token.clone())
    };
    let token = token.ok_or("未登录")?;
    let url = format!("{}/api/v1/yingdao/tasks/{task_id}/trigger", base.trim_end_matches('/'));

    let body = payload.unwrap_or(json!({}));
    let resp = ureq::post(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Content-Type", "application/json")
        .timeout(Duration::from_secs(30))
        .send_string(&body.to_string())
        .map_err(|e| format!("触发影刀任务失败: {e}"))?;

    resp.into_json().map_err(|e| format!("解析响应失败: {e}"))
}
