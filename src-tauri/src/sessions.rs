//! T16 会话持久化：Tauri 命令层。
//!
//! 历史会话以 SQLite 落在 `<codex_home>/sessions.sqlite`。命令：
//! - `session_list` / `session_search` / `session_get`：浏览与恢复。
//! - `session_save`：整会话保存（create + upsert 消息 + provider/model + 标题）。
//! - `session_rename` / `session_delete`。

use std::path::Path;

use harness_sessions::{SessionDetail, SessionMeta, SessionStore};

fn db_for(codex_home: &str) -> String {
    Path::new(codex_home).join("sessions.sqlite").to_string_lossy().to_string()
}

fn open(codex_home: &str) -> Result<SessionStore, String> {
    SessionStore::open(db_for(codex_home)).map_err(|e| e.to_string())
}

/// 保存整会话。`messages`: [{seq, role, text}]。
#[tauri::command]
pub async fn session_save(
    codex_home: String,
    id: String,
    title: String,
    provider: String,
    model: String,
    cwd: String,
    messages: Vec<serde_json::Value>,
) -> Result<SessionDetail, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut st = open(&codex_home)?;
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
pub async fn session_list(codex_home: String) -> Result<Vec<SessionMeta>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        open(&codex_home)?.list_sessions().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 按关键词搜索会话（标题或消息内容）。
#[tauri::command]
pub async fn session_search(
    codex_home: String,
    keyword: String,
) -> Result<Vec<SessionMeta>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        open(&codex_home)?
            .search_sessions(&keyword)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 读取会话详情（含按序消息），用于恢复。
#[tauri::command]
pub async fn session_get(codex_home: String, id: String) -> Result<SessionDetail, String> {
    tauri::async_runtime::spawn_blocking(move || {
        open(&codex_home)?.get_session(&id).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 重命名会话。
#[tauri::command]
pub async fn session_rename(
    codex_home: String,
    id: String,
    title: String,
) -> Result<SessionMeta, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut st = open(&codex_home)?;
        st.rename(&id, &title).map_err(|e| e.to_string())?;
        let d = st.get_session(&id).map_err(|e| e.to_string())?;
        Ok::<SessionMeta, String>(d.meta)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 删除会话。
#[tauri::command]
pub async fn session_delete(codex_home: String, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        open(&codex_home)?
            .delete_session(&id)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}