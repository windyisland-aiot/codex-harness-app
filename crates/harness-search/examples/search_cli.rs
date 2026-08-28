//! `search_cli`：驱动 harness-search 的命令行示例（T15 联网搜索）。
//!
//! 子命令：
//! - `mcp-config <tavily|serper> [api_key]`：生成 codex `[mcp_servers.<id>]` 配置（JSON）。
//! - `execute <query> [--base-url <url>] [--key <key>] [--max <n>]`：执行一次搜索，
//!   `--base-url` 可指向本地 mock 服务，无需真实触网。
//!
//! 用法示例：
//! ```text
//! cargo run -p harness-search --example search_cli -- mcp-config tavily sek123
//! cargo run -p harness-search --example search_cli -- execute "rust sqlite" --base-url http://127.0.0.1:8800 --key k
//! ```

use std::process::ExitCode;

use harness_search::{SearchClient, SearchConfig, SearchMcpConfig, SearchProvider};

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let Some(cmd) = args.next() else {
        eprintln!("用法: search_cli <mcp-config|execute> ...");
        return ExitCode::from(2);
    };

    match cmd.as_str() {
        "mcp-config" => cmd_mcp_config(args),
        "execute" => cmd_execute(args),
        other => {
            eprintln!("未知命令: {other}");
            ExitCode::from(2)
        }
    }
}

/// 输出 `[mcp_servers.<id>]` 注册配置。
fn cmd_mcp_config(mut args: impl Iterator<Item = String>) -> ExitCode {
    let provider = args.next().unwrap_or_else(|| "tavily".to_string());
    let api_key = args.next();
    let prov = match provider.as_str() {
        "serper" => SearchProvider::Serper,
        _ => SearchProvider::Tavily,
    };
    let cfg = SearchMcpConfig::build(prov, api_key.as_deref());
    let out = serde_json::json!({
        "id": cfg.id,
        "command": cfg.command,
        "args": cfg.args,
        "env": cfg.env,
        "env_vars": cfg.env_vars,
    });
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
    ExitCode::SUCCESS
}

/// 执行一次搜索，输出规整后的结果与来源。
fn cmd_execute(args: impl Iterator<Item = String>) -> ExitCode {
    let mut query: Option<String> = None;
    let mut base_url: Option<String> = None;
    let mut api_key: Option<String> = None;
    let mut max = 5usize;
    let mut it = args;
    while let Some(tok) = it.next() {
        match tok.as_str() {
            "--base-url" => base_url = it.next(),
            "--key" => api_key = it.next(),
            "--max" => {
                max = it.next().and_then(|x| x.parse().ok()).unwrap_or(5);
            }
            other if query.is_none() => query = Some(other.to_string()),
            _ => {}
        }
    }
    let query = query.unwrap_or_default().trim().to_string();

    let cfg = SearchConfig {
        provider: SearchProvider::Tavily,
        base_url: base_url.unwrap_or_else(|| "https://api.tavily.com".to_string()),
        api_key: api_key.unwrap_or_default(),
        ..Default::default()
    };
    let client = SearchClient::new(cfg);
    match client.search(&query, max) {
        Ok(resp) => {
            let out = serde_json::json!({ "query": resp.query, "results": resp.results });
            println!("{}", serde_json::to_string_pretty(&out).unwrap());
            ExitCode::SUCCESS
        }
        Err(harness_search::SearchError::MissingApiKey(m)) => {
            eprintln!("缺少 API key: {m}");
            ExitCode::FAILURE
        }
        Err(harness_search::SearchError::Http(e)) => {
            // e2e 通过检索该前缀中的状态码断言错误处理。
            println!("__HTTP_ERROR__ {e}");
            ExitCode::from(50)
        }
        Err(harness_search::SearchError::Transport(e)) => {
            eprintln!("transport: {e}");
            ExitCode::FAILURE
        }
    }
}