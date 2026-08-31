//! T22 · 审批直连飞书审批。
//!
//! 纯 HTTP：通过 `lark-openapi-mcp` 提供的 `POST /open-apis/approval/v4/instances`
//! 创建审批实例；真实执行需要用户已配置飞书审批定义（definition_code）。
//! 测试阶段全部走 mock server（不要求真实 AppId/Secret/DefinitionCode）。

use std::time::Duration;

#[derive(serde::Deserialize)]
struct ApprovalResp {
    code: Option<i64>,
    msg: Option<String>,
    data: Option<ApprovalRespData>,
}
#[derive(serde::Deserialize)]
struct ApprovalRespData {
    #[serde(rename = "instanceCode")]
    instance_code: Option<String>,
    #[serde(rename = "instance_id")]
    instance_id: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalFeishuResult {
    /// 审批定义 code（若调用方未传，则返回空字符串，mock 下也为空）。
    pub approval_code: String,
    /// 审批实例 code。
    pub instance_code: String,
    /// 飞书客户端跳转链接（拼装）。
    pub link: String,
    /// 原始响应中的 code，便于排查。
    pub upstream_code: Option<i64>,
    pub upstream_msg: Option<String>,
}

/// 发起飞书审批。
///
/// - `definition_code` / `endpoint` 若为空，会退化为默认值并可能在 mock 测试里直接命中；
///   生产环境建议显式传入。
/// - `form_data` 透传为审批表单字段（按 Approval.create API 要求）。
#[tauri::command]
pub async fn approval_send_to_feishu(
    approval_id: String,
    summary: String,
    approver_open_ids: Vec<String>,
    dept_id: Option<String>,
    form_data: Option<serde_json::Value>,
    definition_code: Option<String>,
    endpoint: Option<String>,
    tenant_access_token: Option<String>,
) -> Result<ApprovalFeishuResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let endpoint = endpoint
            .unwrap_or_else(|| "https://open.feishu.cn/open-apis/approval/v4/instances".into());
        let definition_code = definition_code.unwrap_or_default();

        let payload = serde_json::json!({
            "approval_code": definition_code,
            "uuid": approval_id,
            "description": summary,
            "start_method": "API",
            "origin_detail": {
                "platform": "Harness Desktop",
                "version": "0.5.2",
            },
            "approver_open_ids": approver_open_ids,
            "dept_id": dept_id,
            "form": form_data.unwrap_or(serde_json::Value::Null),
        });

        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(15))
            .build();
        let mut req = agent
            .post(&endpoint)
            .set("Content-Type", "application/json");
        if let Some(t) = tenant_access_token.as_deref() {
            if !t.trim().is_empty() {
                req = req.set("Authorization", &format!("Bearer {t}"));
            }
        }
        let resp = req.send_json(payload).map_err(|e| {
            let s = sanitize(e.to_string());
            format!("approval_send_to_feishu 调用失败：{s}")
        })?;

        let status = resp.status();
        let raw_body = resp.into_string().unwrap_or_default();
        let body = sanitize(raw_body);
        let parsed: ApprovalResp =
            serde_json::from_str(&body).unwrap_or_else(|_| ApprovalResp {
                code: Some(status as i64),
                msg: Some(format!("无法解析审批响应（HTTP {status}）")),
                data: None,
            });
        // instance_code 优先级：data.instance_code > data.instance_id > 生成的占位。
        let instance_code = parsed
            .data
            .as_ref()
            .and_then(|d| d.instance_code.clone())
            .or_else(|| parsed.data.as_ref().and_then(|d| d.instance_id.clone()))
            .unwrap_or_else(|| format!("LOCAL-{approval_id}"));
        let link = format!(
            "https://applink.feishu.cn/client/approval/detail?instance_code={}",
            urlencode(&instance_code)
        );
        // 业务错误：飞书 code != 0 时，仍返回 result 但把 upstream_code 带上，前端负责展示。
        Ok(ApprovalFeishuResult {
            approval_code: definition_code,
            instance_code,
            link,
            upstream_code: parsed.code,
            upstream_msg: parsed.msg,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        let safe = ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '~');
        if safe {
            out.push(ch);
        } else {
            for b in ch.to_string().as_bytes() {
                out.push_str(&format!("%{:02X}", b));
            }
        }
    }
    out
}

fn sanitize(body: String) -> String {
    use regex::Regex;
    use std::sync::LazyLock;
    static R1: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)(Bearer|Basic)\s+[A-Za-z0-9\-._~+/=]+").unwrap());
    static R2: LazyLock<Regex> = LazyLock::new(|| {
        let q34: char = 34u8 as char;
        let q39: char = 39u8 as char;
        let pat = format!(
            r"(?i)(token|api[_-]?key|secret|access[_-]?token|refresh[_-]?token)\s*[:=]\s*[{q34}{q39}]?[A-Za-z0-9\-._~+/]+[{q34}{q39}]?"
        );
        Regex::new(&pat).unwrap()
    });
    let s = R1.replace_all(&body, "${1} [REDACTED]").into_owned();
    R2.replace_all(&s, "${1}=[REDACTED]").into_owned()
}
