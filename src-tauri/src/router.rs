//! T11 模型路由后端：按任务类型/上下文长度/成本/敏感度给出模型决策。
//!
//! 路由目录来自 [`harness_router::default_catalog`]（与前端预设一致），
//! 决策供线程创建/切换使用。

use harness_router::{RouteDecision, RouteRequest};
use harness_router::TaskType;

/// 解析路由决策。`task_type` 可选（为空自动识别）。
#[tauri::command]
pub async fn router_resolve(
    prompt: String,
    task_type: Option<String>,
    estimated_context_tokens: u64,
    sensitive: bool,
    max_cost: Option<f64>,
) -> Result<RouteDecision, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let t = task_type
            .filter(|s| !s.is_empty())
            .and_then(|s| serde_json::from_value::<TaskType>(serde_json::json!(s)).ok());
        let req = RouteRequest {
            prompt,
            task_type: t,
            estimated_context_tokens,
            sensitive,
            max_cost,
        };
        Ok::<RouteDecision, String>(harness_router::resolve(&harness_router::default_catalog(), &req))
    })
    .await
    .map_err(|e| e.to_string())?
}