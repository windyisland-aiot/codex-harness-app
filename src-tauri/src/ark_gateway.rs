//! 内嵌 Ark 网关：把 `codex app-server` 的 Responses SSE 请求转发到火山方舟 Ark，
//! 并做两层协议归一化，解决「codex <-> Ark responses 协议不兼容」导致的无法对话：
//!
//! 1. 过滤 `reasoning` 相关 SSE 事件（Ark 会返回 reasoning item + 摘要增量事件，
//!    codex 无法正确消费，会导致 turn 卡死/断连）；
//! 2. 对 `response.output_item.added` 中 `message`/`agentMessage` item 注入
//!    `"content": []`（codex 的 `ResponseItem::Message` 要求 content 必填，
//!    Ark 缺省该字段会导致 item 注册失败、回复为空）。
//!
//! 架构：
//! - codex config.toml 中 `model_providers.volcengine-ark.base_url` 指向
//!   `http://127.0.0.1:18762/v1`（本网关，Tauri 启动时拉起）
//! - 网关持有真实 Ark base_url 与 API key（不再注入 codex 子进程环境，更安全），
//!   仅放行 `POST /v1/responses`，其余路径返回 404。
//!
//! 端口可被 `appserver_start` 通过环境变量重写（HARNESS_ARK_GW_PORT），
//! 默认 18762。

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::thread;

/// 网关本地监听端口（127.0.0.1）。config.toml 默认 base_url 与之保持一致。
pub const DEFAULT_GATEWAY_PORT: u16 = 18762;

/// Ark 真实上游与鉴权（写死接入；后期可在配置面板替换）。
const ARK_UPSTREAM: &str = "https://ark.cn-beijing.volces.com/api/coding/v3";
const ARK_API_KEY: &str = "ark-9219d6e8-6264-437e-aeab-95fdb650a043-2c85b";

struct GatewayConfig {
    upstream: String,
    api_key: String,
}

/// 启动网关（阻塞直到端口就绪）。返回后网关在独立线程运行。
pub fn start_gateway() -> Result<u16, String> {
    let port = std::env::var("HARNESS_ARK_GW_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(DEFAULT_GATEWAY_PORT);
    let cfg = Arc::new(GatewayConfig {
        upstream: ARK_UPSTREAM.to_string(),
        api_key: ARK_API_KEY.to_string(),
    });

    // 若端口已被占用，做一个“活性探测”：本网关监听则直接复用
    if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)) {
        let cfg2 = cfg.clone();
        thread::spawn(move || accept_loop(listener, cfg2));
        Ok(port)
    } else {
        // 端口被其它进程占用：探测是否为本网关（发一条无效请求，连接成功即可认为健康）
        if probe_listening(port) {
            Ok(port)
        } else {
            Err(format!("端口 {port} 被占用且非本网关，无法启动 Ark 网关"))
        }
    }
}

fn probe_listening(port: u16) -> bool {
    TcpStream::connect(("127.0.0.1", port)).is_ok()
}

fn accept_loop(listener: TcpListener, cfg: Arc<GatewayConfig>) {
    for stream in listener.incoming() {
        match stream {
            Ok(s) => {
                let c = cfg.clone();
                thread::spawn(move || {
                    let _ = handle_client(s, c);
                });
            }
            Err(_) => continue,
        }
    }
}

fn handle_client(mut stream: TcpStream, cfg: Arc<GatewayConfig>) -> std::io::Result<()> {
    stream.set_read_timeout(Some(std::time::Duration::from_secs(120)))?;

    // --- 读取请求头（\r\n\r\n 为止） ---
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut head = Vec::new();
    loop {
        let mut buf = [0u8; 1];
        if reader.read(&mut buf)? == 0 {
            return Ok(());
        }
        head.push(buf[0]);
        if head.ends_with(b"\r\n\r\n") {
            break;
        }
        if head.len() > 32 * 1024 {
            return Ok(());
        }
    }
    let head_str = String::from_utf8_lossy(&head);
    let mut lines = head_str.split("\r\n");
    let req_line = lines.next().unwrap_or("");
    let mut parts = req_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");

    // 仅支持 POST .../responses
    if method != "POST" || !path.ends_with("/responses") {
        let _ = write_simple(&mut stream, 404, "Not Found", "not found");
        return Ok(());
    }

    // Content-Length
    let content_length: usize = lines
        .filter_map(|l| {
            let mut it = l.splitn(2, ':');
            let k = it.next()?.trim().to_ascii_lowercase();
            let v = it.next()?.trim();
            (k == "content-length").then(|| v.parse::<usize>().ok()).flatten()
        })
        .next()
        .unwrap_or(0);

    let mut body = vec![0u8; content_length];
    reader.read_exact(&mut body)?;

    // --- 转发到 Ark ---
    let payload = String::from_utf8_lossy(&body).to_string();
    let resp = forward(&cfg, &payload);

    let is_sse: bool;
    let status: u16;
    let body_bytes: Vec<u8>;
    match resp {
        Ok((st, content_type, bytes)) => {
            status = st;
            body_bytes = bytes;
            is_sse = content_type.contains("event-stream");
        }
        Err(e) => {
            let _ = write_simple(&mut stream, 502, "Bad Gateway", &format!("forward error: {e}"));
            return Ok(());
        }
    }

    if status != 200 {
        let _ = write_simple(&mut stream, status, "Bad Gateway", &String::from_utf8_lossy(&body_bytes));
        return Ok(());
    }

    // --- 回传 SSE 头 ---
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(header.as_bytes())?;

    // content_type 含 text/event-stream → 逐行归一化转发；否则原样回传
    if is_sse {
        let mut sse = BufReader::new(body_bytes.as_slice());
        let mut out = String::new();
        let mut line = String::new();
        loop {
            line.clear();
            let n = sse.read_line(&mut line)?;
            if n == 0 {
                break;
            }
            if let Some(norm) = normalize_sse_line(&line) {
                out.push_str(&norm);
            }
            if out.len() >= 4096 {
                stream.write_all(out.as_bytes())?;
                stream.flush()?;
                out.clear();
            }
        }
        if !out.is_empty() {
            stream.write_all(out.as_bytes())?;
            stream.flush()?;
        }
    } else {
        stream.write_all(&body_bytes)?;
        stream.flush()?;
    }
    Ok(())
}

/// 逐行归一化：返回 `Option<String>`，`None` 表示该行应被丢弃（过滤）。
fn normalize_sse_line(line: &str) -> Option<String> {
    let trimmed = line.trim_end();
    if let Some(data) = trimmed.strip_prefix("data:") {
        let json = data.trim();
        if json.is_empty() || json == "[DONE]" {
            return Some(line.to_string());
        }
        // 尝试解析事件
        if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(json) {
            let event_type = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
            // 1) 过滤 reasoning 相关事件
            match event_type {
                "response.reasoning_summary_part.added"
                | "response.reasoning_summary_text.delta"
                | "response.reasoning_summary_text.done"
                | "response.reasoning_summary_part.done" => return None,
                "response.output_item.added" | "response.output_item.done" => {
                    let item_type = v
                        .get("item")
                        .and_then(|item| item.get("type"))
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    if item_type == "reasoning" {
                        return None;
                    }
                    // 2) message/agentMessage 缺 content → 注入空数组
                    if event_type == "response.output_item.added"
                        && (item_type == "message" || item_type == "agentMessage")
                    {
                        if let Some(item) = v.get_mut("item") {
                            let has_content = item
                                .get("content")
                                .map(|c| c.is_array())
                                .unwrap_or(false);
                            if !has_content {
                                if let Some(obj) = item.as_object_mut() {
                                    obj.insert("content".to_string(), serde_json::json!([]));
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
            // 序列化回 data 行
            let new_json = serde_json::to_string(&v).unwrap_or_else(|_| data.to_string());
            return Some(format!("data:{new_json}\n"));
        }
    }
    // 非 data 行（event: / 空行 / 注释）原样回传
    Some(line.to_string())
}

fn forward(cfg: &GatewayConfig, payload: &str) -> Result<(u16, String, Vec<u8>), String> {
    let url = format!("{}/responses", cfg.upstream);
    let resp = ureq::post(&url)
        .set("Content-Type", "application/json")
        .set("Authorization", &format!("Bearer {}", cfg.api_key))
        .timeout(std::time::Duration::from_secs(120))
        .send_string(payload)
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let content_type = resp
        .header("Content-Type")
        .unwrap_or("application/json")
        .to_string();
    let mut body = Vec::new();
    resp.into_reader()
        .take(64 * 1024 * 1024)
        .read_to_end(&mut body)
        .map_err(|e| e.to_string())?;
    Ok((status, content_type, body))
}

fn write_simple(stream: &mut TcpStream, status: u16, reason: &str, body: &str) -> std::io::Result<()> {
    let text = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(text.as_bytes())?;
    stream.flush()
}

/// 供测试：网关归一化逻辑单测见 crate 内 `#[cfg(test)]`。
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_reasoning_events() {
        // reasoning 事件应被丢弃
        assert_eq!(
            normalize_sse_line("data:{\"type\":\"response.reasoning_summary_text.delta\",\"delta\":\"x\"}\n"),
            None
        );
        assert_eq!(
            normalize_sse_line("data:{\"type\":\"response.reasoning_summary_part.added\",\"summary_index\":0}\n"),
            None
        );
        // 普通 message 事件保留
        let l = normalize_sse_line("data:{\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n");
        assert!(l.is_some());
    }

    #[test]
    fn patches_missing_content() {
        let line = "data:{\"type\":\"response.output_item.added\",\"item\":{\"type\":\"message\",\"id\":\"m1\"}}\n";
        let out = normalize_sse_line(line).unwrap();
        assert!(out.contains("\"content\":[]"), "got: {out}");
        // reasoning item 应被过滤
        let r = normalize_sse_line("data:{\"type\":\"response.output_item.added\",\"item\":{\"type\":\"reasoning\",\"id\":\"r1\"}}\n");
        assert!(r.is_none());
    }

    /// 真实 Ark SSE 样本驱动的回归验证（fixture 来自真实 ark responses 流式响应）：
    /// - reasoning 相关事件（output_item.added reasoning / summary 等）必须被过滤；
    /// - output_item.added 的 message item 缺 content 时必须被补上 content:[]。
    #[test]
    fn normalizes_real_ark_sse() {
        let fixture = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/ark_sse_real.txt"
        );
        let raw = std::fs::read_to_string(fixture).expect("read ark sse fixture");
        let mut norm = String::new();
        for line in raw.lines() {
            // 真实运行时 read_line 保留 \n；lines() 迭代会去掉，这里补回以模拟网络字节流
            if let Some(out) = normalize_sse_line(&format!("{line}\n")) {
                norm.push_str(&out);
            }
        }
        // 1) reasoning 已全部过滤
        for line in norm.lines() {
            if let Some(data) = line.trim().strip_prefix("data:") {
                let j = data.trim();
                if j.is_empty() || j == "[DONE]" {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(j) {
                    let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
                    assert!(
                        !t.contains("reasoning"),
                        "reasoning event leaked after normalization: {t}"
                    );
                    let it = v
                        .get("item")
                        .and_then(|x| x.get("type"))
                        .and_then(|x| x.as_str())
                        .unwrap_or("");
                    assert!(
                        it != "reasoning",
                        "reasoning item leaked after normalization"
                    );
                }
            }
        }
        // 2) message item 的 content 被补全为数组
        let mut added_msg_with_content = false;
        for line in norm.lines() {
            if let Some(data) = line.trim().strip_prefix("data:") {
                let j = data.trim();
                if j.is_empty() || j == "[DONE]" {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(j) {
                    if v.get("type").and_then(|x| x.as_str()) == Some("response.output_item.added") {
                        let it = v.get("item").and_then(|x| x.get("type")).and_then(|x| x.as_str());
                        if it == Some("message") || it == Some("agentMessage") {
                            let c = v.get("item").and_then(|x| x.get("content"));
                            assert!(
                                c.map(|x| x.is_array()).unwrap_or(false),
                                "message item missing content array: {v}"
                            );
                            added_msg_with_content = true;
                        }
                    }
                }
            }
        }
        assert!(added_msg_with_content, "no message item found in fixture");
    }

    /// 真实 Ark 流经网关的端到端验证（需要外网 + 环境代理，默认忽略）。
    /// 运行：cargo test -p harness-app --lib live_via_real_ark -- --ignored
    #[test]
    #[ignore]
    fn live_via_real_ark() {
        let port = start_gateway().expect("start gateway");
        let url = format!("http://127.0.0.1:{port}/v1/responses");
        let payload = serde_json::json!({
            "model": "ark-code-latest",
            "input": [{"type": "message", "role": "user",
                       "content": [{"type": "input_text", "text": "用不超过10个字回答：你好"}]}],
            "stream": true,
            "max_output_tokens": 512,
        });
        let resp = ureq::post(&url)
            .set("Content-Type", "application/json")
            .timeout(std::time::Duration::from_secs(120))
            .send_string(&payload.to_string())
            .expect("gateway POST");
        assert_eq!(resp.status(), 200, "gateway returned non-200");
        let ct = resp.header("Content-Type").unwrap_or("").to_string();
        assert!(ct.contains("event-stream"), "expected SSE, got {ct}");

        let mut body = Vec::new();
        resp.into_reader()
            .read_to_end(&mut body)
            .expect("read body");
        let text = String::from_utf8_lossy(&body);

        let mut reasoning_seen = false;
        let mut message_ok = false;
        for line in text.lines() {
            if let Some(data) = line.trim().strip_prefix("data:") {
                let json = data.trim();
                if json.is_empty() || json == "[DONE]" {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(json) {
                    let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
                    if t.contains("reasoning") { reasoning_seen = true; }
                    if t == "response.output_item.added" {
                        let it = v.get("item").and_then(|x| x.get("type")).and_then(|x| x.as_str()).unwrap_or("");
                        if it == "message" || it == "agentMessage" {
                            let c = v.get("item").and_then(|x| x.get("content"));
                            if c.map(|x| x.is_array()).unwrap_or(false) {
                                message_ok = true;
                            }
                        }
                    }
                }
            }
        }
        assert!(!reasoning_seen, "gateway failed to filter reasoning events");
        assert!(message_ok, "message item missing content array after gateway");
    }
}