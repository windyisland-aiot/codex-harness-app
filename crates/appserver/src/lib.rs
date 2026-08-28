//! # harness-appserver
//!
//! T05：`codex app-server` 的 stdio JSON-RPC 客户端。
//!
//! 以子进程方式拉起 `codex app-server --listen stdio://`，通过行分隔 JSONL
//! 在 stdio 上交换消息（JSON-RPC 2.0）。提供一个统一的读线程：
//! - 响应（带 id + result/error）按 id 分发给对应的 [`AppServerClient::call`] 调用方；
//! - 服务器主动请求（带 id + method，如审批 `item/commandExecution/requestApproval`）
//!   交给 [`AppServerConfig::on_server_request`]，其返回值会自动写回（返回 `None` 则不回包）；
//! - 通知（method 无 id，如 `thread/started`、`turn/completed`）交给
//!   [`AppServerConfig::on_notification`]。
//!
//! 便捷方法：`initialize` / `thread_start` / `turn_start`。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;

use serde_json::{Map, Value};

/// JSON-RPC 通信错误。
#[derive(Debug)]
pub enum AppServerError {
    Spawn(String),
    Io(String),
    Closed,
    Timeout(String),
    Rpc { code: i64, message: String },
    Protocol(String),
}

impl std::fmt::Display for AppServerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AppServerError::Spawn(m) => write!(f, "spawn failed: {m}"),
            AppServerError::Io(m) => write!(f, "io: {m}"),
            AppServerError::Closed => write!(f, "app-server process closed"),
            AppServerError::Timeout(m) => write!(f, "timeout waiting for {m}"),
            AppServerError::Rpc { code, message } => write!(f, "rpc error {code}: {message}"),
            AppServerError::Protocol(m) => write!(f, "protocol: {m}"),
        }
    }
}

impl std::error::Error for AppServerError {}

pub type Result<T> = std::result::Result<T, AppServerError>;

/// 服务器主动请求回调：入参 `(request_id, method, params)`，返回要写回的结果（`None` 则不回包）。
pub type ServerRequestHandler =
    Box<dyn Fn(u64, &str, &Map<String, Value>) -> Option<Value> + Send + Sync + 'static>;
/// 通知回调：入参 `(method, params)`。
pub type NotificationHandler = Box<dyn Fn(&str, &Map<String, Value>) + Send + Sync + 'static>;

/// 启动配置。
pub struct AppServerConfig {
    /// `codex` 可执行文件路径。
    pub codex_bin: String,
    /// 额外环境变量（如 `MOCK_KEY`、`CODEX_HOME`）。
    pub env: Option<HashMap<String, String>>,
    /// 工作目录。
    pub cwd: Option<String>,
    /// 单次 `call` 的默认超时（毫秒）。
    pub default_timeout_ms: u64,
    /// 服务器主动请求回调。
    pub on_server_request: Option<ServerRequestHandler>,
    /// 服务器通知回调。
    pub on_notification: Option<NotificationHandler>,
}

impl Default for AppServerConfig {
    fn default() -> Self {
        Self {
            codex_bin: "codex".to_string(),
            env: None,
            cwd: None,
            default_timeout_ms: 30_000,
            on_server_request: None,
            on_notification: None,
        }
    }
}

/// 到 `codex app-server` 的连接。
pub struct AppServerClient {
    child: Option<Child>,
    writer: Box<dyn Write + Send>,
    pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>>,
    next_id: AtomicU64,
    default_timeout_ms: u64,
}

impl AppServerClient {
    /// 启动子进程并建立 stdio 通道。
    pub fn new(cfg: AppServerConfig) -> Result<Self> {
        let mut cmd = Command::new(&cfg.codex_bin);
        cmd.arg("app-server").arg("--listen").arg("stdio://");
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        if let Some(env) = &cfg.env {
            for (k, v) in env {
                cmd.env(k, v);
            }
        }
        if let Some(cwd) = &cfg.cwd {
            cmd.current_dir(cwd);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| AppServerError::Spawn(format!("{e}")))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AppServerError::Spawn("no stdin".into()))?;
        let stdout = match child.stdout.take() {
            Some(o) => o,
            None => return Err(AppServerError::Spawn("no stdout".into())),
        };

        let (writer, tx_write) = spawn_writer(stdin);

        let pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let p2 = pending.clone();
        let p3 = pending.clone();

        let req_handler = cfg.on_server_request;
        let notif_handler = cfg.on_notification;
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };
                if line.trim().is_empty() {
                    continue;
                }
                let v: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let obj = match v.as_object() {
                    Some(o) => o,
                    None => continue,
                };
                if let Some(id) = obj.get("id").and_then(|x| x.as_u64()) {
                    if obj.contains_key("result") || obj.contains_key("error") {
                        if let Some(tx) = { p2.lock().unwrap().remove(&id) } {
                            let _ = tx.send(v);
                        }
                        continue;
                    }
                }
                let method = match obj.get("method").and_then(|x| x.as_str()) {
                    Some(m) => m,
                    None => continue,
                };
                let params = obj
                    .get("params")
                    .and_then(|x| x.as_object())
                    .cloned()
                    .unwrap_or_default();
                if obj.contains_key("id") {
                    // 服务器主动请求
                    let req_id = obj.get("id").and_then(|x| x.as_u64()).unwrap_or(0);
                    if let Some(h) = &req_handler {
                        if let Some(reply) = h(req_id, method, &params) {
                            let out = serde_json::json!({
                                "jsonrpc": "2.0",
                                "id": obj["id"],
                                "result": reply,
                            });
                            let _ = tx_write.send(out.to_string().into_bytes());
                        }
                    }
                } else if let Some(h) = &notif_handler {
                    h(method, &params);
                }
            }
            // 子进程结束：唤醒所有 pending
            for (_id, tx) in p3.lock().unwrap().drain() {
                let _ = tx.send(Value::Null);
            }
        });

        Ok(AppServerClient {
            child: Some(child),
            writer: Box::new(writer),
            pending,
            next_id: AtomicU64::new(1),
            default_timeout_ms: cfg.default_timeout_ms,
        })
    }

    /// `initialize` 握手。
    pub fn initialize(&mut self, name: &str, version: &str) -> Result<Value> {
        let params = serde_json::json!({
            "protocolVersion": 1,
            "clientInfo": { "name": name, "version": version },
        });
        self.call("initialize", params, None)
    }

    /// 发起 JSON-RPC 请求，阻塞到返回或超时。
    pub fn call(&mut self, method: &str, params: Value, timeout_ms: Option<u64>) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel::<Value>();
        self.pending.lock().unwrap().insert(id, tx);
        let req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        self.writer
            .write_all(req.to_string().as_bytes())
            .and_then(|_| self.writer.write_all(b"\n"))
            .and_then(|_| self.writer.flush())
            .map_err(|e| {
                self.pending.lock().unwrap().remove(&id);
                AppServerError::Io(e.to_string())
            })?;
        let timeout = timeout_ms.unwrap_or(self.default_timeout_ms);
        let msg = rx
            .recv_timeout(std::time::Duration::from_millis(timeout))
            .map_err(|_| AppServerError::Timeout(method.to_string()))?;
        self.pending.lock().unwrap().remove(&id);
        if msg.is_null() {
            return Err(AppServerError::Closed);
        }
        if let Some(err) = msg.get("error") {
            return Err(AppServerError::Rpc {
                code: err["code"].as_i64().unwrap_or(-1),
                message: err["message"].as_str().unwrap_or("rpc error").to_string(),
            });
        }
        Ok(msg.get("result").cloned().unwrap_or(Value::Null))
    }

    /// 创建新会话（thread），返回 thread id。
    pub fn thread_start(
        &mut self,
        model: &str,
        model_provider: &str,
        cwd: &str,
    ) -> Result<String> {
        let params = serde_json::json!({
            "model": model,
            "modelProvider": model_provider,
            "cwd": cwd,
        });
        let res = self.call("thread/start", params, None)?;
        res["thread"]["id"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| AppServerError::Protocol("thread/start missing thread.id".into()))
    }

    /// 开启一轮对话。
    pub fn turn_start(&mut self, thread_id: &str, cwd: &str, text: &str) -> Result<Value> {
        let params = serde_json::json!({
            "threadId": thread_id,
            "cwd": cwd,
            "input": [{ "type": "text", "text": text, "text_elements": [] }],
        });
        self.call("turn/start", params, None)
    }

    /// 关闭子进程。
    pub fn shutdown(&mut self) {
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

impl Drop for AppServerClient {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// 写入子进程 stdin 的通道 writer + 后台写线程。
fn spawn_writer(stdin: ChildStdin) -> (ChannelWriter, mpsc::Sender<Vec<u8>>) {
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    thread::spawn(move || {
        let mut stdin = stdin;
        while let Ok(bytes) = rx.recv() {
            if stdin.write_all(&bytes).is_err() | stdin.flush().is_err() {
                break;
            }
        }
        let _ = stdin;
    });
    (ChannelWriter { tx: tx.clone() }, tx)
}

/// 把 `Write` 调用转成发送到写线程的字节。
struct ChannelWriter {
    tx: mpsc::Sender<Vec<u8>>,
}

impl Write for ChannelWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let n = buf.len();
        self.tx
            .send(buf.to_vec())
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "writer closed"))?;
        Ok(n)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}