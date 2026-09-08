//! T16 会话持久化：Tauri 命令层。
//!
//! 历史会话以 SQLite 落在 `<codex_home>/sessions/<账号>.sqlite`。命令：
//! - `session_list` / `session_search` / `session_get`：浏览与恢复。
//! - `session_save`：整会话保存（create + upsert 消息 + provider/model + 标题）。
//! - `session_rename` / `session_delete`。
//!
//! **按账号隔离**：一台机器可能被多个编导轮流使用，共用一个库会让
//! A 看到 B 的历史。库文件名取登录用户名的安全化形式，未登录时落到
//! `_anonymous`；老版本的 `<codex_home>/sessions.sqlite` 首次访问时
//! 迁移给当前账号，避免升级后历史"消失"。

use std::path::{Path, PathBuf};

use harness_sessions::{SessionDetail, SessionMeta, SessionStore};

use crate::cloud_bridge::CloudHandle;

/// 用户名安全化：只保留字母数字与 `-_`，其余折成 `_`，避免路径穿越与非法文件名。
fn sanitize_account(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let trimmed = cleaned.trim_matches('_').to_string();
    if trimmed.is_empty() { "_anonymous".to_string() } else { trimmed }
}

/// 当前登录账号（未登录 → `_anonymous`）。
fn current_account(cloud: &CloudHandle) -> String {
    cloud
        .lock()
        .ok()
        .and_then(|cfg| cfg.username.clone())
        .map(|name| sanitize_account(&name))
        .unwrap_or_else(|| "_anonymous".to_string())
}

fn db_path(codex_home: &str, account: &str) -> PathBuf {
    Path::new(codex_home).join("sessions").join(format!("{account}.sqlite"))
}

/// 打开当前账号的会话库；必要时把 v0.6 的单库迁移过来。
fn open_for(codex_home: &str, account: &str) -> Result<SessionStore, String> {
    let path = db_path(codex_home, account);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建会话目录失败: {e}"))?;
    }

    // 一次性迁移：老版本所有账号共用 <codex_home>/sessions.sqlite。
    // 谁先登录谁继承，之后旧文件改名留档（不删，便于回滚排查）。
    let legacy = Path::new(codex_home).join("sessions.sqlite");
    if !path.exists() && legacy.is_file() {
        if std::fs::rename(&legacy, &path).is_err() {
            // 跨设备等 rename 失败的场景退化为拷贝
            let _ = std::fs::copy(&legacy, &path);
        }
    }

    SessionStore::open(path.to_string_lossy().to_string()).map_err(|e| e.to_string())
}

/// 保存整会话。`messages`: [{seq, role, text}]。
#[tauri::command]
pub async fn session_save(
    cloud: tauri::State<'_, CloudHandle>,
    codex_home: String,
    id: String,
    title: String,
    provider: String,
    model: String,
    cwd: String,
    messages: Vec<serde_json::Value>,
) -> Result<SessionDetail, String> {
    let account = current_account(cloud.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let mut st = open_for(&codex_home, &account)?;
        st.create_session(&id, &title, &provider, &model, &cwd)
            .map_err(|e| e.to_string())?;
        st.set_provider_model(&id, &provider, &model)
            .map_err(|e| e.to_string())?;
        for v in &messages {
            let seq = v.get("seq").and_then(|x| x.as_i64()).unwrap_or(0);
            let role = v.get("role").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let text = v.get("text").and_then(|x| x.as_str()).unwrap_or("").to_string();
            st.upsert_message(&id, seq, &role, &text)
                .map_err(|e| e.to_string())?;
        }
        st.get_session(&id).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 列出全部会话（按最近更新倒序）。
#[tauri::command]
pub async fn session_list(
    cloud: tauri::State<'_, CloudHandle>,
    codex_home: String,
) -> Result<Vec<SessionMeta>, String> {
    let account = current_account(cloud.inner());
    tauri::async_runtime::spawn_blocking(move || {
        open_for(&codex_home, &account)?.list_sessions().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 按关键词搜索会话（标题或消息内容）。
#[tauri::command]
pub async fn session_search(
    cloud: tauri::State<'_, CloudHandle>,
    codex_home: String,
    keyword: String,
) -> Result<Vec<SessionMeta>, String> {
    let account = current_account(cloud.inner());
    tauri::async_runtime::spawn_blocking(move || {
        open_for(&codex_home, &account)?
            .search_sessions(&keyword)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 读取会话详情（含按序消息），用于恢复。
#[tauri::command]
pub async fn session_get(
    cloud: tauri::State<'_, CloudHandle>,
    codex_home: String,
    id: String,
) -> Result<SessionDetail, String> {
    let account = current_account(cloud.inner());
    tauri::async_runtime::spawn_blocking(move || {
        open_for(&codex_home, &account)?.get_session(&id).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 重命名会话。
#[tauri::command]
pub async fn session_rename(
    cloud: tauri::State<'_, CloudHandle>,
    codex_home: String,
    id: String,
    title: String,
) -> Result<SessionMeta, String> {
    let account = current_account(cloud.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let mut st = open_for(&codex_home, &account)?;
        st.rename(&id, &title).map_err(|e| e.to_string())?;
        let d = st.get_session(&id).map_err(|e| e.to_string())?;
        Ok::<SessionMeta, String>(d.meta)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 删除会话。
#[tauri::command]
pub async fn session_delete(
    cloud: tauri::State<'_, CloudHandle>,
    codex_home: String,
    id: String,
) -> Result<(), String> {
    let account = current_account(cloud.inner());
    tauri::async_runtime::spawn_blocking(move || {
        open_for(&codex_home, &account)?
            .delete_session(&id)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}