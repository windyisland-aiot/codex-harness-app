//! 内嵌 Ark 网关：把 `codex app-server` 的 Responses SSE 请求转发到火山方舟 Ark，
//! 并做协议翻译，解决「codex <-> Ark 协议不兼容」导致的无法对话：
//!
//! 架构（双向翻译）：
//!   [codex (wire_api=responses)]
//!       ↓ POST http://127.0.0.1:18762/v1/responses (Responses JSON)
//!   [本 网 关 - 翻译层]
//!       ↓ POST https://ark...volces.com/api/coding/v3/chat/completions (Chat JSON)
//!   [火山方舟 Ark]
//!       ↑ 返回 Chat Completions SSE
//!   [本 网 关 - 翻译层]
//!       ↑ 返回 Responses SSE
//!   [codex (正常消费 streaming)]
//!
//! 具体翻译内容：
//! 1. 请求: Responses { model, input:[{role,content:[{text}]}] }
//!       → Chat  { model, messages:[{role, content: text}] }
//! 2. 响应 SSE (Chat → Responses):
//!    Chat: choices[0].delta.content / reasoning_content
//!    Responses: response.created → output_item.added(message,content:[])
//!               → content_part.added(text)
//!               → output_text.delta / done
//!               → content_part.done
//!               → output_item.done → response.completed
//! 3. reasoning_content 不向下游 codex 泄露（过滤思考过程，只返回最终 content）。
//!
//! 端口可被 appserver_start 通过环境变量 HARNESS_ARK_GW_PORT 重写，默认 18762。

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

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

    if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)) {
        let cfg2 = cfg.clone();
        thread::spawn(move || accept_loop(listener, cfg2));
        Ok(port)
    } else {
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
    stream.set_read_timeout(Some(Duration::from_secs(120)))?;
    // --- 修复 writer-closed：给 write 方向也设置大超时（600s），避免 codex 长对话提前关 socket ---
    stream.set_write_timeout(Some(Duration::from_secs(600)))?;

    // --- 读取请求头 ---
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

    if method != "POST" || !path.ends_with("/responses") {
        let _ = write_simple(&mut stream, 404, "Not Found", "not found");
        return Ok(());
    }

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

    let payload = String::from_utf8_lossy(&body).to_string();

    // --- 判断请求是否需要流式（看 stream 字段），决定走哪条路径 ---
    let want_stream: bool = {
        serde_json::from_str::<serde_json::Value>(&payload)
            .ok()
            .and_then(|v| v.get("stream").and_then(|s| s.as_bool()))
            .unwrap_or(false)
    };

    if want_stream {
        // --- 修复：边读上游 SSE 边写客户端（chunked streaming），避免全量缓冲写超时 ---
        match forward_streaming(&cfg, &payload, &mut stream) {
            Ok(()) => Ok(()),
            Err(e) => {
                // 5xx/网络错误：sanitize，不泄漏 api key
                let msg = sanitize_upstream_error(&e);
                let _ = write_simple(&mut stream, 502, "Bad Gateway", &msg);
                Ok(())
            }
        }
    } else {
        // 非流式：原逻辑（全量缓冲可接受，因为非流式通常响应小）
        let resp = forward_buffered(&cfg, &payload);
        let status: u16;
        let body_bytes: Vec<u8>;
        match resp {
            Ok((st, bytes)) => {
                status = st;
                body_bytes = bytes;
            }
            Err(e) => {
                let msg = sanitize_upstream_error(&e);
                let _ = write_simple(&mut stream, 502, "Bad Gateway", &msg);
                return Ok(());
            }
        }
        if status != 200 {
            // 5xx 上游错误：sanitize body（避免把 ureq::Error debug print 含 api key 返回下游）
            let safe_msg = if (500..600).contains(&status) {
                format!("Ark upstream error (HTTP {status})")
            } else {
                String::from_utf8_lossy(&body_bytes).to_string()
            };
            let _ = write_simple(&mut stream, status, "Bad Gateway", &safe_msg);
            return Ok(());
        }
        let translated = translate_non_streaming(&body_bytes);
        let text = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            translated.len(),
            translated
        );
        write_all_safe(&mut stream, text.as_bytes())?;
        stream.flush().ok();
        Ok(())
    }
}

/// 写入数据：对 BrokenPipe/ConnectionReset 静默吞掉（返回 Ok），其他错误原样返回。
fn write_all_safe(stream: &mut TcpStream, data: &[u8]) -> std::io::Result<()> {
    use std::io::ErrorKind::{BrokenPipe, ConnectionReset, ConnectionAborted};
    match stream.write_all(data) {
        Ok(()) => Ok(()),
        Err(e) => match e.kind() {
            BrokenPipe | ConnectionReset | ConnectionAborted => {
                // 客户端/codex 已关 writer：静默退出，不 panic 传播
                Ok(())
            }
            _ => Err(e),
        },
    }
}

fn write_simple(stream: &mut TcpStream, status: u16, reason: &str, body: &str) -> std::io::Result<()> {
    let text = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    // --- 修复：write_simple 里对 BrokenPipe/ConnectionReset 静默吞掉 ---
    write_all_safe(stream, text.as_bytes())?;
    let _ = stream.flush();
    Ok(())
}

/// 对 upstream 错误字符串做 sanitize：不泄漏 api key、不打印 ureq::Error 的完整 debug。
fn sanitize_upstream_error(e: &str) -> String {
    // 任何含 api key 的内容都替换掉；同时统一为 warn! 风格的短消息
    if e.contains("ark-") || e.contains("Bearer") || e.contains("Authorization") {
        return "Ark upstream error (connection/auth issue)".to_string();
    }
    if e.contains("timed out") || e.contains("timeout") {
        return "Ark upstream timeout".to_string();
    }
    if e.contains("connection") || e.contains("Connection") {
        return "Ark upstream connection failed".to_string();
    }
    // 兜底：取前 80 字符，避免 ureq::Error 的大 debug dump
    let s: String = e.chars().take(80).collect();
    format!("Ark upstream error: {}", s)
}

// ============================================================================
// 请求翻译：Responses JSON → Chat Completions JSON
// ============================================================================
fn translate_request_to_chat(payload: &str) -> Result<String, String> {
    let mut v: serde_json::Value =
        serde_json::from_str(payload).map_err(|e| format!("invalid request JSON: {e}"))?;
    let obj = v
        .as_object_mut()
        .ok_or_else(|| "request body must be JSON object".to_string())?;

    let model = obj
        .get("model")
        .cloned()
        .unwrap_or(serde_json::json!("ark-code-latest"));
    let stream = obj.get("stream").cloned().unwrap_or(serde_json::json!(false));

    // max_output_tokens → max_tokens
    let max_tokens = obj
        .remove("max_output_tokens")
        .or_else(|| obj.remove("max_tokens"))
        .unwrap_or(serde_json::json!(4096));

    // Extract messages from input
    let input = obj
        .remove("input")
        .ok_or_else(|| "Responses request missing 'input' field".to_string())?;

    let mut messages = Vec::<serde_json::Value>::new();
    if let Some(arr) = input.as_array() {
        for item in arr {
            let role = item
                .get("role")
                .and_then(|r| r.as_str())
                .unwrap_or("user")
                .to_string();
            // content 可能是字符串，也可能是数组 [{type:"input_text", text:"..."}]
            let mut text_parts: Vec<String> = Vec::new();
            if let Some(s) = item.get("content").and_then(|c| c.as_str()) {
                text_parts.push(s.to_string());
            } else if let Some(arr) = item.get("content").and_then(|c| c.as_array()) {
                for part in arr {
                    if let Some(t) = part.get("text").and_then(|x| x.as_str()) {
                        text_parts.push(t.to_string());
                    }
                }
            }
            if !text_parts.is_empty() {
                messages.push(serde_json::json!({
                    "role": role,
                    "content": text_parts.concat(),
                }));
            }
        }
    }

    if messages.is_empty() {
        return Err("Responses request: no messages extracted".to_string());
    }

    let chat = serde_json::json!({
        "model": model,
        "messages": messages,
        "stream": stream,
        "max_tokens": max_tokens,
    });
    Ok(chat.to_string())
}

// ============================================================================
// 响应翻译（非流式）：Chat Completions JSON → Responses JSON
// ============================================================================
fn translate_non_streaming(bytes: &[u8]) -> String {
    let s = String::from_utf8_lossy(bytes);
    if let Ok(chat) = serde_json::from_str::<serde_json::Value>(&s) {
        if let Some(err) = chat.get("error") {
            return serde_json::json!({ "error": err }).to_string();
        }
        let resp_id = chat
            .get("id")
            .and_then(|x| x.as_str())
            .unwrap_or("resp_0")
            .to_string();
        let model = chat
            .get("model")
            .cloned()
            .unwrap_or(serde_json::json!("ark-code-latest"));
        let usage = chat.get("usage").cloned().unwrap_or(serde_json::json!({}));
        let mut content_text = String::new();
        if let Some(choices) = chat.get("choices").and_then(|c| c.as_array()) {
            for ch in choices {
                if let Some(msg) = ch.get("message") {
                    if let Some(c) = msg.get("content").and_then(|x| x.as_str()) {
                        content_text.push_str(c);
                    }
                }
            }
        }
        let out = serde_json::json!({
            "id": resp_id,
            "object": "response",
            "model": model,
            "usage": usage,
            "output": [{
                "type": "message",
                "id": format!("{resp_id}_m0"),
                "role": "assistant",
                "content": [{
                    "type": "output_text",
                    "text": content_text,
                }],
            }],
            "status": "completed",
        });
        return out.to_string();
    }
    s.to_string()
}

// ============================================================================
// SSE 流状态翻译：Chat Completions SSE → Responses SSE
// ============================================================================
struct ChatSseToResponses {
    started: bool,
    item_added: bool,
    content_part_added: bool,
    emitted_any_delta: bool,
    /// 是否已经观察到上游发来过 delta.content（最终答案）。
    /// 一旦出现过 true，则后续 reasoning_content 不再"冒充"content 下发。
    seen_any_content: bool,
    resp_id: String,
    item_id: String,
    content_part_id: String,
}

impl ChatSseToResponses {
    fn new() -> Self {
        let rid = format!("resp_{}", rand_id());
        Self {
            started: false,
            item_added: false,
            content_part_added: false,
            emitted_any_delta: false,
            seen_any_content: false,
            item_id: format!("{rid}_m0"),
            content_part_id: format!("{rid}_c0"),
            resp_id: rid,
        }
    }

    /// 喂一行 SSE（末尾自带换行或不带均可），返回 0..N 行 Responses SSE 事件。
    fn feed_line(&mut self, raw_line: &str) -> Vec<String> {
        let trimmed = raw_line.trim_end_matches(&['\n', '\r'][..]);
        if trimmed.is_empty() {
            return vec!["\n".to_string()];
        }
        if !trimmed.starts_with("data:") {
            // event: / 空注释行 → 原样保留（加换行）
            return vec![format!("{trimmed}\n")];
        }
        let json_str = trimmed["data:".len()..].trim();
        if json_str.is_empty() {
            return vec!["\n".to_string()];
        }
        if json_str == "[DONE]" {
            return self.finish();
        }
        let mut out: Vec<String> = Vec::new();

        // 若有 id 字段，使用上游 id 覆盖我们的 resp_id
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(json_str) {
            if let Some(up_id) = v.get("id").and_then(|x| x.as_str()) {
                if !self.started {
                    self.resp_id = up_id.to_string();
                    self.item_id = format!("{}_m0", self.resp_id);
                    self.content_part_id = format!("{}_c0", self.resp_id);
                }
            }
        }

        // 1) response.created（首个 data 事件触发）
        if !self.started {
            self.started = true;
            let ev_created = serde_json::json!({
                "type": "response.created",
                "response": {
                    "id": self.resp_id,
                    "object": "response",
                    "model": "ark-code-latest",
                    "output": [],
                    "status": "in_progress",
                }
            });
            out.push(format!("data:{}\n", ev_created.to_string()));
        }

        // 2) 解析 choices delta
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(json_str) {
            if let Some(choices) = v.get("choices").and_then(|c| c.as_array()) {
                for ch in choices {
                    let delta = ch.get("delta").and_then(|d| d.as_object());
                    let Some(delta) = delta else { continue };

                    // —— 文本增量选择策略 ——
                    // 优先级：delta.content（最终答案，一旦出现永久锁定）
                    //       > delta.reasoning_content（思考过程，仅在 content 从未出现时兜底）
                    // 原因：火山方舟 ark-code-latest 等模型会先输出 reasoning_content，
                    //       数秒/数十秒后才真正开始 delta.content。若直接丢弃 reasoning，
                    //       用户前端会长时间"无任何输出"；若 token 限制截断在 reasoning
                    //       阶段，codex 甚至会拿到一个空回答 turn。
                    let text_delta: Option<&str> = {
                        let content = delta.get("content").and_then(|x| x.as_str());
                        let reasoning = delta.get("reasoning_content").and_then(|x| x.as_str());
                        match (content, reasoning) {
                            (Some(c), _) if !c.is_empty() => {
                                self.seen_any_content = true;
                                Some(c)
                            }
                            (None, Some(r)) if !r.is_empty() && !self.seen_any_content => Some(r),
                            _ => None,
                        }
                    };

                    if let Some(text) = text_delta {
                        // 2a) output_item.added (message, content:[])
                        if !self.item_added {
                            self.item_added = true;
                            let ev = serde_json::json!({
                                "type": "response.output_item.added",
                                "item": {
                                    "type": "message",
                                    "id": self.item_id,
                                    "role": "assistant",
                                    "content": [],
                                },
                                "output_index": 0,
                            });
                            out.push(format!("data:{}\n", ev.to_string()));
                        }
                        // 2b) content_part.added (type=output_text, text="")
                        if !self.content_part_added {
                            self.content_part_added = true;
                            let ev = serde_json::json!({
                                "type": "response.content_part.added",
                                "item_id": self.item_id,
                                "output_index": 0,
                                "content_index": 0,
                                "part": {
                                    "type": "output_text",
                                    "text": "",
                                    "annotations": [],
                                },
                            });
                            out.push(format!("data:{}\n", ev.to_string()));
                        }
                        // 2c) output_text.delta
                        self.emitted_any_delta = true;
                        let ev = serde_json::json!({
                            "type": "response.output_text.delta",
                            "item_id": self.item_id,
                            "output_index": 0,
                            "content_index": 0,
                            "delta": text,
                        });
                        out.push(format!("data:{}\n", ev.to_string()));
                    }

                    // 其他字段（refusal / tool_calls 等）：暂不处理，后续可扩展
                }
            }
        }
        out
    }

    /// 流结束：收尾事件（done/completed）
    fn finish(&mut self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        if !self.started {
            // 没收到任何 data 就结束了：发一个空响应
            self.started = true;
            let ev_created = serde_json::json!({
                "type": "response.created",
                "response": {
                    "id": self.resp_id,
                    "object": "response",
                    "model": "ark-code-latest",
                    "output": [],
                    "status": "in_progress",
                }
            });
            out.push(format!("data:{}\n", ev_created.to_string()));
        }
        if !self.item_added {
            // 空回复也补一条 message item，保证 codex turn 能闭合
            self.item_added = true;
            self.content_part_added = true;
            let ev_item = serde_json::json!({
                "type": "response.output_item.added",
                "item": {
                    "type": "message",
                    "id": self.item_id,
                    "role": "assistant",
                    "content": [],
                },
                "output_index": 0,
            });
            out.push(format!("data:{}\n", ev_item.to_string()));
            let ev_part = serde_json::json!({
                "type": "response.content_part.added",
                "item_id": self.item_id,
                "output_index": 0,
                "content_index": 0,
                "part": {
                    "type": "output_text",
                    "text": "",
                    "annotations": [],
                },
            });
            out.push(format!("data:{}\n", ev_part.to_string()));
        }
        if self.content_part_added {
            // output_text.done
            let ev_done_text = serde_json::json!({
                "type": "response.output_text.done",
                "item_id": self.item_id,
                "output_index": 0,
                "content_index": 0,
                "text": "",
            });
            out.push(format!("data:{}\n", ev_done_text.to_string()));
            // content_part.done
            let ev_part_done = serde_json::json!({
                "type": "response.content_part.done",
                "item_id": self.item_id,
                "output_index": 0,
                "content_index": 0,
                "part": {
                    "type": "output_text",
                    "text": "",
                },
            });
            out.push(format!("data:{}\n", ev_part_done.to_string()));
        }
        if self.item_added {
            let ev_item_done = serde_json::json!({
                "type": "response.output_item.done",
                "item_id": self.item_id,
                "output_index": 0,
                "content": if self.emitted_any_delta || !self.content_part_added {
                    serde_json::json!([{
                        "type": "output_text",
                        "text": "",
                    }])
                } else {
                    serde_json::json!([{
                        "type": "output_text",
                        "text": "",
                    }])
                },
            });
            out.push(format!("data:{}\n", ev_item_done.to_string()));
        }
        let ev_completed = serde_json::json!({
            "type": "response.completed",
            "response": {
                "id": self.resp_id,
                "object": "response",
                "model": "ark-code-latest",
                "output": [],
                "usage": {"input_tokens":0,"output_tokens":0,"total_tokens":0},
                "status": "completed",
            },
        });
        out.push(format!("data:{}\n", ev_completed.to_string()));
        out.push("data:[DONE]\n\n".to_string());
        out
    }
}

fn rand_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ns = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    // 混入一点栈熵即可，id 只需唯一不需要加密安全
    let stack_addr = std::ptr::addr_of!(ns) as u64;
    let r = (ns as u64)
        .wrapping_mul(1103515245)
        .wrapping_add(12345)
        ^ stack_addr;
    format!("{:x}{:016x}", (ns as u64) & 0xffffffff, r)
}

// ============================================================================
// chunked encode：把字节串包装成 HTTP/1.1 chunked 片段
// ============================================================================
fn chunked_encode(bytes: &[u8]) -> Vec<u8> {
    if bytes.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(bytes.len() + 16);
    out.extend_from_slice(format!("{:X}\r\n", bytes.len()).as_bytes());
    out.extend_from_slice(bytes);
    out.extend_from_slice(b"\r\n");
    out
}

fn chunked_final() -> Vec<u8> {
    b"0\r\n\r\n".to_vec()
}

// ============================================================================
// upstream 转发：流式路径（SSE 场景） —— 边读边写，每 256ms flush 一次
// ============================================================================
fn forward_streaming(
    cfg: &GatewayConfig,
    responses_payload: &str,
    client_stream: &mut TcpStream,
) -> Result<(), String> {
    let chat_payload = translate_request_to_chat(responses_payload)?;
    let url = format!("{}/chat/completions", cfg.upstream);
    let resp = ureq::post(&url)
        .set("Content-Type", "application/json")
        .set("Authorization", &format!("Bearer {}", cfg.api_key))
        .timeout(Duration::from_secs(600))
        .send_string(&chat_payload)
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let content_type = resp
        .header("Content-Type")
        .unwrap_or("application/json")
        .to_string();
    let is_sse = content_type.contains("event-stream");

    if status != 200 {
        // 5xx 上游错误：sanitize body，绝不泄漏 key
        let safe_msg = if (500..600).contains(&status) {
            format!("Ark upstream error (HTTP {status})")
        } else {
            // 非 200 非 5xx：尝试读 body 并取前 120 字符
            let mut dump = Vec::new();
            let _ = resp.into_reader().take(1024).read_to_end(&mut dump);
            let raw = String::from_utf8_lossy(&dump).to_string();
            let s: String = raw.chars().take(120).collect();
            if s.contains("ark-") || s.contains("Bearer") {
                format!("Ark upstream error (HTTP {status})")
            } else {
                format!("Ark upstream error (HTTP {status}): {}", s)
            }
        };
        return Err(safe_msg);
    }

    if !is_sse {
        // 上游返回非 SSE（例如 stream=false 但我们走了 streaming 分支，或上游降级）
        let mut body = Vec::new();
        resp.into_reader()
            .take(64 * 1024 * 1024)
            .read_to_end(&mut body)
            .map_err(|e| e.to_string())?;
        let translated = translate_non_streaming(&body);
        let header = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            translated.len()
        );
        write_all_safe(client_stream, header.as_bytes()).map_err(|e| e.to_string())?;
        write_all_safe(client_stream, translated.as_bytes()).map_err(|e| e.to_string())?;
        let _ = client_stream.flush();
        return Ok(());
    }

    // --- SSE chunked streaming：写 Transfer-Encoding: chunked 头 ---
    let resp_header = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n";
    write_all_safe(client_stream, resp_header.as_bytes()).map_err(|e| e.to_string())?;

    let mut upstream_reader = BufReader::new(resp.into_reader());
    let mut xlator = ChatSseToResponses::new();
    let mut line = String::new();
    let mut out_buf = String::new();
    let mut last_flush = Instant::now();
    let flush_interval = Duration::from_millis(256);

    loop {
        line.clear();
        let n = upstream_reader
            .read_line(&mut line)
            .map_err(|e| format!("upstream read error: {}", sanitize_upstream_error(&e.to_string())))?;
        if n == 0 {
            // EOF：补 finish
            for ev in xlator.finish() {
                out_buf.push_str(&ev);
            }
            // flush 剩余
            if !out_buf.is_empty() {
                let chunk = chunked_encode(out_buf.as_bytes());
                if write_all_safe(client_stream, &chunk).is_err() {
                    return Ok(()); // BrokenPipe: early return
                }
                out_buf.clear();
            }
            // 写 chunked terminator
            let final_chunk = chunked_final();
            let _ = write_all_safe(client_stream, &final_chunk);
            let _ = client_stream.flush();
            return Ok(());
        }

        for ev in xlator.feed_line(&line) {
            out_buf.push_str(&ev);
        }

        // 每 256ms 或 buf >= 4KB flush 一次
        let now = Instant::now();
        if out_buf.len() >= 4096 || now.duration_since(last_flush) >= flush_interval {
            if !out_buf.is_empty() {
                let chunk = chunked_encode(out_buf.as_bytes());
                if write_all_safe(client_stream, &chunk).is_err() {
                    return Ok(()); // BrokenPipe: early return
                }
                if client_stream.flush().is_err() {
                    return Ok(());
                }
                out_buf.clear();
            }
            last_flush = now;
        }
    }
}

// ============================================================================
// upstream 转发：缓冲路径（非流式场景） —— 保留原 forward 语义
// ============================================================================
fn forward_buffered(
    cfg: &GatewayConfig,
    responses_payload: &str,
) -> Result<(u16, Vec<u8>), String> {
    let chat_payload = translate_request_to_chat(responses_payload)?;
    let url = format!("{}/chat/completions", cfg.upstream);
    let resp = ureq::post(&url)
        .set("Content-Type", "application/json")
        .set("Authorization", &format!("Bearer {}", cfg.api_key))
        .timeout(Duration::from_secs(120))
        .send_string(&chat_payload)
        .map_err(|e| sanitize_upstream_error(&e.to_string()))?;
    let status = resp.status();
    let mut body = Vec::new();
    resp.into_reader()
        .take(64 * 1024 * 1024)
        .read_to_end(&mut body)
        .map_err(|e| sanitize_upstream_error(&e.to_string()))?;
    Ok((status, body))
}

// ============================================================================
// Tests
// ============================================================================
#[cfg(test)]
mod tests {
    use super::*;

    // --- 请求翻译 ---
    #[test]
    fn translates_responses_request_to_chat() {
        let req = serde_json::json!({
            "model": "ark-code-latest",
            "input": [
                {"type":"message","role":"system","content":[{"type":"input_text","text":"你是助手"}]},
                {"type":"message","role":"user","content":[{"type":"input_text","text":"你好"}]}
            ],
            "stream": true,
            "max_output_tokens": 256,
        });
        let chat_json = translate_request_to_chat(&req.to_string()).unwrap();
        let chat: serde_json::Value = serde_json::from_str(&chat_json).unwrap();
        assert_eq!(chat["model"], "ark-code-latest");
        assert_eq!(chat["stream"], true);
        assert_eq!(chat["max_tokens"], 256);
        let msgs = chat["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[0]["content"], "你是助手");
        assert_eq!(msgs[1]["role"], "user");
        assert_eq!(msgs[1]["content"], "你好");
    }

    // --- 流式 SSE 翻译 ---
    #[test]
    fn chat_sse_to_responses_basic() {
        let fixture = "\
data: {\"id\":\"chat_abc\",\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"Hello\"}}]}

data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"思考内容，应该被过滤\"}}]}

data: {\"choices\":[{\"delta\":{\"content\":\" World\"}}]}

data: [DONE]
";
        let mut x = ChatSseToResponses::new();
        let mut all = String::new();
        for line in fixture.lines() {
            for ev in x.feed_line(&format!("{line}\n")) {
                all.push_str(&ev);
            }
        }
        for ev in x.finish() {
            all.push_str(&ev);
        }
        // 必须包含 response.created
        assert!(all.contains("response.created"), "missing created: {all}");
        // 必须包含 response.output_item.added
        assert!(
            all.contains("response.output_item.added") && all.contains("\"content\":[]"),
            "missing item.added with empty content"
        );
        // 必须包含 output_text.delta = Hello 和 World
        assert!(all.contains("Hello") && all.contains("World"), "missing content delta: {all}");
        // 不能包含任何 reasoning
        assert!(
            !all.contains("思考内容"),
            "reasoning content leaked into downstream: {all}"
        );
        // 必须有 response.completed 和 [DONE]
        assert!(all.contains("response.completed"), "missing completed");
        assert!(all.contains("data:[DONE]"), "missing [DONE]");
    }

    #[test]
    fn chat_sse_handles_empty_stream() {
        let mut x = ChatSseToResponses::new();
        let evs = x.finish();
        let all: String = evs.concat();
        // created + item.added + completed 都必须有
        assert!(all.contains("response.created"));
        assert!(all.contains("response.output_item.added"));
        assert!(all.contains("response.completed"));
        assert!(all.contains("data:[DONE]"));
    }

    // --- chunked encode 自检 ---
    #[test]
    fn chunked_simple() {
        let b = b"hello";
        let enc = chunked_encode(b);
        assert_eq!(enc, b"5\r\nhello\r\n");
        assert_eq!(chunked_final(), b"0\r\n\r\n");
    }

    // --- sanitize 自检 ---
    #[test]
    fn sanitize_hides_key() {
        let msg1 = sanitize_upstream_error("Bearer ark-9219d6e8-xxx bad auth");
        assert!(!msg1.contains("ark-9219"));
        let msg2 = sanitize_upstream_error("tcp connect timed out after 30s");
        assert_eq!(msg2, "Ark upstream timeout");
    }
}
