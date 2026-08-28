//! T09 配置面板后端：读写 codex `config.toml`。
//!
//! `config_read` 读取归一化配置供面板展示；`config_write` 把面板改动合并写回，
//! 保留 codex 未管理的其它配置。改动在下次启动 app-server 时生效。

use harness_config::AppConfig;

/// 读取当前 `CODEX_HOME` 下的配置。
#[tauri::command]
pub async fn config_read(codex_home: String) -> Result<AppConfig, String> {
    tauri::async_runtime::spawn_blocking(move || {
        harness_config::read(&codex_home).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 合并写回配置。
#[tauri::command]
pub async fn config_write(codex_home: String, config: AppConfig) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        harness_config::write(&codex_home, &config).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}