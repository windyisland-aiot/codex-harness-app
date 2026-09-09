//! T05/T06：把 `codex app-server` 的 stdio 客户端接入 Tauri 后端。
//!
//! 全局状态 `CodexState` 保存：
//! - `client`：可选的 `AppServerClient`；
//! - `events`：后端从 app-server 收到的全部通知（供前端轮询渲染）；
//! - `approvals`：后端收到的审批请求。
//!
//! 命令均经 `spawn_blocking` 执行，避免阻塞主线程/UI。

use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use harness_appserver::{AppServerClient, AppServerConfig};
use serde_json::Value;
use tauri::State;

/// 简易时间戳（YYYY-MM-DD HH:MM:SS.mmm），不依赖 chrono crate。
fn chrono_like_now() -> String {
    let dur = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default();
    let secs = dur.as_secs() as i64;
    let ms = dur.subsec_millis();
    let t = libc_time_t_to_tuple(secs);
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}",
        t.tm_year, t.tm_mon, t.tm_mday,
        t.tm_hour, t.tm_min, t.tm_sec,
        ms
    )
}

/// 把 Unix timestamp 转 UTC tm（不依赖 chrono）。
fn libc_time_t_to_tuple(secs: i64) -> TmCompat {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let tm_sec = (rem % 60) as u32;
    let rem = rem / 60;
    let tm_min = (rem % 60) as u32;
    let tm_hour = (rem / 60) as u32;
    let (tm_year, tm_mon, tm_mday) = days_to_ymd(days);
    TmCompat { tm_year, tm_mon, tm_mday, tm_hour, tm_min, tm_sec }
}

fn days_to_ymd(days: i64) -> (i32, u32, u32) {
    // 简化算法（UTC，不考虑时区）
    // 1970-01-01 为 day 0
    let mut d = days;
    let mut year: i32 = 1970;
    loop {
        let y_days = if is_leap(year) { 366 } else { 365 };
        if d >= y_days {
            d -= y_days;
            year += 1;
        } else {
            break;
        }
    }
    let month_days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut mon = 1u32;
    let leap_extra = if is_leap(year) { 1 } else { 0 };
    for (i, md) in month_days.iter().enumerate() {
        let actual = *md + if i == 1 { leap_extra } else { 0 };
        if d >= actual {
            d -= actual;
            mon += 1;
        } else {
            break;
        }
    }
    (year, mon, (d + 1) as u32)
}

fn is_leap(y: i32) -> bool {
    (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0)
}

/// 简易 tm 结构（避免依赖 chrono crate；Rust 标准库 Tm 不稳定）。
#[derive(Default, Clone, Copy)]
struct TmCompat {
    tm_year: i32,
    tm_mon: u32,
    tm_mday: u32,
    tm_hour: u32,
    tm_min: u32,
    tm_sec: u32,
}

pub struct CodexState {
    pub client: Mutex<Option<AppServerClient>>,
    pub events: Mutex<VecDeque<(String, Value)>>,
    pub approvals: Mutex<VecDeque<(u64, String, Value)>>,
}

pub type CodexHandle = Arc<CodexState>;

pub fn managed_state() -> CodexHandle {
    Arc::new(CodexState {
        client: Mutex::new(None),
        events: Mutex::new(VecDeque::new()),
        approvals: Mutex::new(VecDeque::new()),
    })
}

/// 从 `<codex_home>/.env-provider` 读取 key=value 行，返回 env 名→值映射。
/// 此文件是凭据存储（纯文本，桌面单机应用可接受），与 codex config.toml 分离，
/// 避免把 API key 误提交 / 误同步到任何仓库。
fn load_provider_env(codex_home: &str) -> HashMap<String, String> {
    let path = std::path::PathBuf::from(codex_home).join(".env-provider");
    let mut out = HashMap::new();
    if let Ok(s) = std::fs::read_to_string(&path) {
        for raw in s.lines() {
            let line = raw.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((k, v)) = line.split_once('=') {
                out.insert(k.trim().to_string(), v.trim().trim_matches('"').to_string());
            }
        }
    }
    out
}

/// 服务端 LLM 代理的兜底地址（登录态里没有 api_base 时用）。
const DEFAULT_LLM_PROXY: &str = "http://118.31.107.214/api/v1/llm";

/// 启动 `codex app-server` 子进程并完成 `initialize` 握手。
///
/// 模型链路（v0.7.0）：codex（本地）→ 服务端 `/api/v1/llm/*` 代理 → 真实模型上游。
///
/// 客户端不再内置任何模型密钥：以登录 token 作 Bearer 请求服务端代理，服务端校验
/// 登录态后换成管理员在后台配置的 base_url / api_key 转发。因此 codex 保留完整的
/// 本地读写文件、执行命令、MCP（飞书/影刀）能力，只有「模型推理」这一步走服务端。
#[tauri::command]
pub async fn appserver_start(
    app: tauri::AppHandle,
    state: State<'_, CodexHandle>,
    cloud: State<'_, crate::cloud_bridge::CloudHandle>,
    codex_bin: String,
    codex_home: String,
    env: Option<HashMap<String, String>>,
) -> Result<String, String> {
    let st = state.inner().clone();
    let codex_home_log = codex_home.clone();
    // 模型鉴权与上游地址全部来自登录态：登录 token 作 Bearer，
    // 真实模型 base_url / api_key 只存在服务端（管理员在后台配置）。
    let (cloud_token, llm_proxy_url, bibike_api_base) = {
        let cfg = cloud.lock().map_err(|_| "cloud state poisoned")?;
        let base = cfg.api_base.trim().trim_end_matches('/').to_string();
        let url = if base.is_empty() { None } else { Some(format!("{base}/api/v1/llm")) };
        let bibike = if base.is_empty() { None } else { Some(format!("{base}/api/v1")) };
        (cfg.token.clone().unwrap_or_default(), url, bibike)
    };
    tauri::async_runtime::spawn_blocking(move || {
        // 初始化日志文件（便于用户在生产环境排查问题）
        let _ = std::fs::create_dir_all(&codex_home_log);
        let log_path = std::path::Path::new(&codex_home_log).join("harness.log");
        let log_f = std::fs::OpenOptions::new()
            .create(true).append(true).open(&log_path)
            .ok();
        let mut log = |msg: &str| {
            let line = format!("[{}] {msg}\n", chrono_like_now());
            eprint!("{}", line);
            if let Some(mut f) = log_f.as_ref() {
                let _ = std::io::Write::write_all(&mut f, line.as_bytes());
            }
        };

        log(&format!("▶ appserver_start: bin={codex_bin}, home={codex_home_log}"));

        // --- v0.5.4：同步内置 skills 到 <codex_home>/skills/ ---
        // codex 子进程只扫 $CODEX_HOME/skills；安装包资源路径是动态的，
        // 必须物理拷贝过去才能让 codex 进程原生读到（feishu-bot 等）。
        // 失败不阻断启动（skill 缺失只影响对应能力，对话本身照常）。
        match crate::plugins::sync_bundled_skills(&app, &codex_home_log) {
            Ok(n) if n > 0 => log(&format!("  ✅ 内置 skills 已同步到 $CODEX_HOME/skills（{n} 个）")),
            Ok(_) => log("  内置 skills：无（跳过同步）"),
            Err(e) => log(&format!("  ⚠️ 内置 skills 同步失败：{e}")),
        }

        // 读 config（会自动迁移 wire_api/base_url/provider_type 等）
        let cfg = harness_config::read(&codex_home_log)
            .map_err(|e| format!("config 迁移失败: {e}"))?;

        // --- v0.7.0：base_url 指向服务端 LLM 代理，wire_api 保持 responses ---
        //
        // 直连 Responses：实测上游原生支持该协议且完整回传 function_call。曾经的
        // 本地 Responses→Chat 翻译网关会丢弃 tool_calls，等于砍掉 codex 读写文件 /
        // 执行命令 / MCP（飞书·影刀）的能力，故已移除。若日后上游换成只讲 Chat
        // Completions 的网关，翻译应加在服务端代理里，而不是退回客户端。
        let gateway_base_url = llm_proxy_url
            .clone()
            .unwrap_or_else(|| DEFAULT_LLM_PROXY.to_string());
        log(&format!("  模型上游（服务端代理）= {gateway_base_url}"));
        let cfg_mutated = {
            let mut c = cfg.clone();
            let mut changed = false;
            for p in &mut c.model_providers {
                if p.base_url != gateway_base_url {
                    log(&format!("  ⚠️ provider {} base_url={} → 强制覆盖为 {}",
                        p.id, p.base_url, gateway_base_url));
                    p.base_url = gateway_base_url.to_string();
                    changed = true;
                }
                // 确保 env_key 正确
                if p.env_key != "VOLCENGINE_ARK_API_KEY" {
                    p.env_key = "VOLCENGINE_ARK_API_KEY".to_string();
                    changed = true;
                }
                // 确保 wire_api 为 responses
                if !p.wire_api.is_empty() && p.wire_api != "responses" {
                    p.wire_api = "responses".to_string();
                    changed = true;
                }
            }
            if changed {
                let _ = harness_config::write(&codex_home_log, &c)
                    .map_err(|e| log(&format!("  ⚠️ config 写回失败: {e}")));
                log("  ✅ config.toml base_url/env_key/wire_api 已强制对齐 v0.6.0 规范");
            }
            c
        };
        // cfg_mutated 用于后续读取
        let cfg = cfg_mutated;

        log(&format!("  config: model={}, modelProvider={}, providers={}",
            cfg.model, cfg.model_provider, cfg.model_providers.len()));
        for p in &cfg.model_providers {
            log(&format!("    - id={}, env_key={}, base_url={}", p.id, p.env_key, p.base_url));
        }

        let mut child_env = HashMap::new();
        child_env.insert("CODEX_HOME".to_string(), codex_home_log.clone());

        // talk-script 等本地 skill 访问服务端知识库（/api/v1/retrieve 免鉴权）
        if let Some(bibike) = &bibike_api_base {
            child_env.insert("BIBIKE_API_BASE".to_string(), bibike.clone());
            log(&format!("  ✅ 注入 BIBIKE_API_BASE={bibike}"));
        }

        // --- Harness 固定注入：飞书企业机器人凭据 ---
        // 硬编码 App ID/Secret，随应用启动自动写入 .env-provider + 子进程 env。
        // 用户不需要在 UI 里手动填任何飞书凭据。
        const FEISHU_APP_ID: &str = "cli_aa0eb9626ae29bda";
        const FEISHU_APP_SECRET: &str = "6ytcKVZLLnRkk854P3PcqbbFnzPsnK21";

        child_env.insert("FEISHU_APP_ID".to_string(), FEISHU_APP_ID.to_string());
        child_env.insert("FEISHU_APP_SECRET".to_string(), FEISHU_APP_SECRET.to_string());
        log(&format!("  ✅ 注入 FEISHU_APP_ID (len={}), FEISHU_APP_SECRET (len={})",
            FEISHU_APP_ID.len(), FEISHU_APP_SECRET.len()));

        // 同时写入 .env-provider，方便 lark-openapi-mcp 读取
        {
            let env_path = std::path::Path::new(&codex_home_log).join(".env-provider");
            let mut existing = std::fs::read_to_string(&env_path).unwrap_or_default();
            for (key, val) in [
                ("FEISHU_APP_ID", FEISHU_APP_ID),
                ("FEISHU_APP_SECRET", FEISHU_APP_SECRET),
            ] {
                let line = format!("{key}={val}");
                if existing.contains(&format!("{key}=")) {
                    // 替换已有行
                    let new_lines: Vec<String> = existing
                        .lines()
                        .map(|l| if l.starts_with(&format!("{key}=")) { line.clone() } else { l.to_string() })
                        .collect();
                    existing = new_lines.join("\n");
                } else if !existing.is_empty() && !existing.ends_with('\n') {
                    existing.push('\n');
                    existing.push_str(&line);
                } else {
                    existing.push_str(&line);
                }
                existing.push('\n');
            }
            let _ = std::fs::write(&env_path, &existing);
            log(&format!("  ✅ 飞书凭据已写入 {}", env_path.display()));
        }

        // --- 模型鉴权：注入登录 token，由本地网关透传给服务端 LLM 代理 ---
        // 客户端不再内置任何模型密钥；上游 base_url / api_key 由管理员在服务端配置。
        child_env.insert("VOLCENGINE_ARK_API_KEY".to_string(), cloud_token.clone());
        if cloud_token.is_empty() {
            log("  ⚠️ 未提供登录 token，模型请求将被服务端拒绝（请先登录）");
        } else {
            log(&format!("  ✅ 注入登录 token 作模型鉴权 (len={})", cloud_token.len()));
        }

        // 前端传的额外 env
        if let Some(extra) = env {
            for (k, v) in extra {
                child_env.entry(k).or_insert(v);
            }
        }

        if let Ok(m) = std::env::var("MOCK_KEY") {
            child_env.entry("MOCK_KEY".to_string()).or_insert(m);
        }

        log(&format!("  最终注入子进程 env: {} 项", child_env.len()));

        let st_notif = st.clone();
        let st_req = st.clone();
        let app_cfg = AppServerConfig {
            codex_bin,
            env: Some(child_env),
            cwd: None,
            default_timeout_ms: 180_000,
            on_notification: Some(Box::new(move |method, params| {
                // 只把重要通知写到 harness.log，避免刷屏
                let is_important = matches!(method, "turn/completed" | "thread/started" | "error" | "warning" | "turn/started");
                if is_important {
                    eprintln!("[notif] {method}");
                }
                let mut g = st_notif.events.lock().unwrap();
                if g.len() > 200_000 {
                    g.pop_front();
                }
                g.push_back((method.to_string(), Value::Object(params.clone())));
            })),
            on_server_request: Some(Box::new(move |req_id, method, params| {
                eprintln!("[srv-req] #{req_id} {method}");
                let mut g = st_req.approvals.lock().unwrap();
                g.push_back((req_id, method.to_string(), Value::Object(params.clone())));
                None
            })),
            ..Default::default()
        };

        log("▶ 启动 codex app-server 子进程…");
        let mut client = AppServerClient::new(app_cfg)
            .map_err(|e| format!("codex 子进程启动失败: {e}"))?;

        log("▶ 执行 initialize 握手…");
        let init = client.initialize("harness-app", "0.3.0")
            .map_err(|e| format!("codex initialize 失败: {e}"))?;
        let user_agent = init["userAgent"].as_str().unwrap_or("harness").to_string();
        log(&format!("✅ codex app-server 就绪: {user_agent}"));

        *st.client.lock().map_err(|e| e.to_string())? = Some(client);
        Ok::<String, String>(user_agent)
    })
    .await
    .map_err(|e| e.to_string())?
}

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

#[tauri::command]
pub async fn appserver_turn_start(
    state: State<'_, CodexHandle>,
    thread_id: String,
    cwd: String,
    text: String,
    images: Option<Vec<String>>,
    model: Option<String>,
) -> Result<Value, String> {
    let st = state.inner().clone();
    let images = images.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = st.client.lock().map_err(|e| e.to_string())?;
        let client = guard.as_mut().ok_or("app-server 未启动")?;
        let m = model.as_deref().map(str::trim).filter(|m| !m.is_empty());
        client
            .turn_start(&thread_id, &cwd, &text, &images, m)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 恢复磁盘上的历史线程（应用重启后旧会话直接发消息会报 -32600 thread not found）。
#[tauri::command]
pub async fn appserver_thread_resume(
    state: State<'_, CodexHandle>,
    thread_id: String,
) -> Result<Value, String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = st.client.lock().map_err(|e| e.to_string())?;
        let client = guard.as_mut().ok_or("app-server 未启动")?;
        client.thread_resume(&thread_id).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 打断正在运行的 turn（对话打断按钮）。
#[tauri::command]
pub async fn appserver_turn_interrupt(
    state: State<'_, CodexHandle>,
    thread_id: String,
    turn_id: String,
) -> Result<(), String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = st.client.lock().map_err(|e| e.to_string())?;
        let client = guard.as_mut().ok_or("app-server 未启动")?;
        client.turn_interrupt(&thread_id, &turn_id).map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

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

#[tauri::command]
pub async fn appserver_poll_approvals(state: State<'_, CodexHandle>) -> Result<Vec<Value>, String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut g = st.approvals.lock().map_err(|e| e.to_string())?;
        let out: Vec<Value> = g
            .drain(..)
            .map(|(req_id, method, params)| {
                serde_json::json!({ "id": req_id, "method": method, "params": params })
            })
            .collect();
        Ok::<Vec<Value>, String>(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn appserver_respond_approval(
    state: State<'_, CodexHandle>,
    request_id: u64,
    decision: String,
) -> Result<(), String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = st.client.lock().map_err(|e| e.to_string())?;
        let client = guard.as_mut().ok_or("app-server 未启动")?;
        let result = serde_json::json!({ "decision": decision });
        client.respond(request_id, result).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

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

// ---------- 凭据读写：<codex_home>/.env-provider ----------

#[tauri::command]
pub fn harness_creds_read(codex_home: String) -> HashMap<String, String> {
    load_provider_env(&codex_home)
}

/// 写凭据：前端传一组 env_key → api_value。合并进现有文件（保留未列出的其他 key）。
#[tauri::command]
pub fn harness_creds_write(codex_home: String, creds: HashMap<String, String>) -> Result<(), String> {
    let path = std::path::PathBuf::from(&codex_home).join(".env-provider");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // 读现有，保留注释
    let mut lines: Vec<String> = Vec::new();
    if let Ok(s) = std::fs::read_to_string(&path) {
        for raw in s.lines() {
            let line = raw.to_string();
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                lines.push(line);
                continue;
            }
            if let Some((k, _)) = trimmed.split_once('=') {
                if creds.contains_key(k.trim()) {
                    // 覆盖稍后做
                    continue;
                }
                lines.push(line);
            } else {
                lines.push(line);
            }
        }
    }
    for (k, v) in &creds {
        if v.trim().is_empty() {
            continue;
        }
        lines.push(format!("{}={}", k.trim(), v.trim()));
    }
    std::fs::write(&path, lines.join("\n") + "\n").map_err(|e| e.to_string())?;
    Ok(())
}
