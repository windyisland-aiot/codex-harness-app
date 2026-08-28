//! `sessions_cli`：驱动 harness-sessions 的命令行示例（T16 会话持久化）。
//!
//! 子命令（第一个位置参数为 db 路径，用于隔离不同环境）：
//! - `add <db> <id> <title> [provider] [model] [cwd]`
//! - `append <db> <id> <role> <text>`
//! - `upsert <db> <id> <seq> <role> <text>`
//! - `rename <db> <id> <title>`
//! - `list <db>`
//! - `search <db> <keyword>`
//! - `get <db> <id>`
//! - `delete <db> <id>`
//!
//! 用法示例：
//! ```text
//! cargo run -p harness-sessions --example sessions_cli -- add /tmp/h.sqlite s1 "hello"
//! cargo run -p harness-sessions --example sessions_cli -- append /tmp/h.sqlite s1 user "hi"
//! ```

use std::process::ExitCode;

use harness_sessions::SessionStore;

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.len() < 2 {
        eprintln!("用法: sessions_cli <cmd> <db> [args...]");
        return ExitCode::from(2);
    }
    let cmd = &argv[0];
    let db = &argv[1];
    let rest = &argv[2..];

    let mut st = match SessionStore::open(db) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("打开失败: {e}");
            return ExitCode::FAILURE;
        }
    };

    let result: Result<(), String> = match cmd.as_str() {
        "add" => {
            let (id, title) = (argv[2].as_str(), argv[3].as_str());
            let provider = rest.get(2).map(|s| s.as_str()).unwrap_or("");
            let model = rest.get(3).map(|s| s.as_str()).unwrap_or("");
            let cwd = rest.get(4).map(|s| s.as_str()).unwrap_or("");
            st.create_session(id, title, provider, model, cwd).map(|_| ()).map_err(|e| e.to_string())
        }
        "append" => st.append_message(&argv[2], &argv[3], &argv[4]).map(|_| ()).map_err(|e| e.to_string()),
        "upsert" => st.upsert_message(&argv[2], argv[3].parse().unwrap_or(0), &argv[4], &argv[5]).map_err(|e| e.to_string()),
        "rename" => st.rename(&argv[2], &argv[3]).map_err(|e| e.to_string()),
        "list" => st.list_sessions().map(|v| println!("{}", serde_json::to_string_pretty(&v).unwrap())).map_err(|e| e.to_string()),
        "search" => st.search_sessions(&argv[2]).map(|v| println!("{}", serde_json::to_string_pretty(&v).unwrap())).map_err(|e| e.to_string()),
        "get" => st.get_session(&argv[2]).map(|d| println!("{}", serde_json::to_string_pretty(&d).unwrap())).map_err(|e| e.to_string()),
        "delete" => st.delete_session(&argv[2]).map_err(|e| e.to_string()),
        other => Err(format!("未知命令: {other}")),
    };

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            println!("__ERROR__ {e}");
            ExitCode::from(40)
        }
    }
}