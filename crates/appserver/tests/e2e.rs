//! T05 端到端验证：真正的 `codex app-server` + mock Responses API。
//!
//! 前置（本沙箱已具备）：
//! - `codex` 已编译：默认 /workspace/codex/codex-rs/target/debug/codex（可用 CODEX_BIN 覆盖）
//! - python3 + scripts/mock_responses_server.py
//!
//! 覆盖：initialize -> thread/start -> turn/start -> turn/completed 完整链路。

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use harness_appserver::{AppServerClient, AppServerConfig};
use serde_json::Value;

const DEFAULT_CODEX: &str = "/workspace/codex/codex-rs/target/debug/codex";
const MOCK_SCRIPT: &str = "/workspace/codex-harness-app/scripts/mock_responses_server.py";
const MOCK_PORT: u16 = 8791;
const TFG_CONFIG: &str = "/workspace/codex-harness-app/.codex-test/config.toml";

fn env_or(k: &str, d: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| d.to_string())
}

/// 启动 mock Responses API 服务器，返回 (join 句柄, 是否就绪)。
fn spawn_mock() -> Option<std::process::Child> {
    let script = env_or("MOCK_SCRIPT", MOCK_SCRIPT);
    if !PathBuf::from(&script).exists() {
        eprintln!("skip: mock script not found: {script}");
        return None;
    }
    match Command::new("python3")
        .arg(&script)
        .arg(MOCK_PORT.to_string())
        .spawn()
    {
        Ok(c) => {
            // 等待端口就绪
            for _ in 0..40 {
                if std::net::TcpStream::connect(("127.0.0.1", MOCK_PORT)).is_ok() {
                    return Some(c);
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            Some(c)
        }
        Err(e) => {
            eprintln!("skip: cannot start mock server: {e}");
            None
        }
    }
}

#[test]
fn full_turn_roundtrip_via_stdlib() {
    let codex = env_or("CODEX_BIN", DEFAULT_CODEX);
    if !PathBuf::from(&codex).exists() {
        eprintln!("SKIP: codex binary not found at {codex}");
        return;
    }
    let mut mock = match spawn_mock() {
        Some(m) => m,
        None => return,
    };

    // 临时 CODEX_HOME，放入指向 mock 的 config.toml
    let home = std::env::temp_dir().join(format!("harness-e2e-{}", std::process::id()));
    fs::create_dir_all(&home).unwrap();
    fs::copy(TFG_CONFIG, home.join("config.toml")).unwrap();

    let mut env = HashMap::new();
    env.insert("MOCK_KEY".to_string(), "mock".to_string());
    env.insert("CODEX_HOME".to_string(), home.to_string_lossy().to_string());

    let notifications: Arc<Mutex<Vec<(String, Value)>>> = Arc::new(Mutex::new(Vec::new()));
    let notifs2 = notifications.clone();
    let cfg = AppServerConfig {
        codex_bin: codex,
        env: Some(env),
        cwd: Some(home.to_string_lossy().to_string()),
        default_timeout_ms: 60_000,
        on_notification: Some(Box::new(move |m, p| {
            notifs2.lock().unwrap().push((m.to_string(), Value::Object(p.clone())));
        })),
        ..Default::default()
    };

    let mut client = match AppServerClient::new(cfg) {
        Ok(c) => c,
        Err(e) => {
            let _ = mock.kill();
            panic!("AppServerClient::new failed: {e}");
        }
    };

    // initialize 已在 new() 中自动完成，这里再显式确认一次不冲突
    let _init = client
        .initialize("harness-e2e", "0.1.0")
        .expect("initialize failed");
    let cwd = home.to_string_lossy().to_string();
    let tid = client
        .thread_start("mock-model", "mock", &cwd)
        .expect("thread/start failed");
    assert!(!tid.is_empty(), "thread id should not be empty");

    client
        .turn_start(&tid, &cwd, "你好，请回复一句话。")
        .expect("turn/start failed");

    // 等待 turn/completed
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut completed = false;
    let mut status = String::new();
    let mut seen: Vec<(String, Value)> = Vec::new();
    while Instant::now() < deadline {
        seen = notifications.lock().unwrap().clone();
        if let Some((_, p)) = seen.iter().find(|(m, _)| m == "turn/completed") {
            status = p["turn"]["status"].as_str().unwrap_or("").to_string();
            completed = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }

    client.shutdown();
    let _ = mock.kill();

    assert!(completed, "turn/completed not received in time; got notifications: {seen:?}");
    // codex 的不同构建对终态命名可能有差异（success / completed），二者都表示一轮正常结束。
    assert!(
        status == "completed" || status == "success",
        "turn status should be terminal, got {status}"
    );
    let _ = mock; // mock 可能复用已运行实例（端口占用时不作清理）
}

#[test]
fn client_rejects_missing_binary() {
    let cfg = AppServerConfig {
        codex_bin: "/nonexistent/codex-binary".to_string(),
        ..Default::default()
    };
    assert!(AppServerClient::new(cfg).is_err());
}