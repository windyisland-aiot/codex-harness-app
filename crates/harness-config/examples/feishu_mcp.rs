//! T12 飞书 MCP 注册命令行示例：把 `lark-openapi-mcp`（或给定命令）注册到
//! `[mcp_servers.feishu]`，输出 JSON；供黑盒 e2e 复用。
//! 用法：
//!   --home <codex_home> --command <cmd> [--arg x] [--env K=V] [--env-var NAME]
//!   --home <codex_home> --status      # 只回读注册状态

use harness_config::McpServerConfig;

#[derive(Default)]
struct Args {
    home: String,
    command: String,
    args: Vec<String>,
    env: Vec<String>,
    env_vars: Vec<String>,
    status: bool,
}

fn main() {
    let mut a = Args::default();
    let mut it = std::env::args().skip(1);
    while let Some(x) = it.next() {
        match x.as_str() {
            "--home" => a.home = it.next().unwrap_or_default(),
            "--command" => a.command = it.next().unwrap_or_default(),
            "--arg" => {
                if let Some(v) = it.next() {
                    a.args.push(v);
                }
            }
            "--env" => {
                if let Some(v) = it.next() {
                    a.env.push(v);
                }
            }
            "--env-var" => {
                if let Some(v) = it.next() {
                    a.env_vars.push(v);
                }
            }
            "--status" => a.status = true,
            _ => {}
        }
    }
    if a.home.is_empty() {
        eprintln!("--home required");
        std::process::exit(2);
    }

    if a.status {
        let cfg = harness_config::read(&a.home).expect("read config");
        let hit = cfg.mcp_servers.iter().find(|m| m.id == "feishu");
        match hit {
            Some(s) => println!(
                "{}",
                serde_json::json!({
                    "registered": true,
                    "command": s.command,
                    "args": s.args,
                    "env": s.env,
                    "env_vars": s.env_vars,
                    "enabled": s.enabled,
                })
            ),
            None => println!("{}", serde_json::json!({ "registered": false })),
        }
        return;
    }

    let mut cfg = harness_config::read(&a.home).expect("read config");
    cfg.mcp_servers.retain(|m| m.id != "feishu");
    cfg.mcp_servers.push(McpServerConfig {
        id: "feishu".into(),
        command: a.command,
        args: a.args,
        env: a.env,
        env_vars: a.env_vars,
        enabled: true,
    });
    harness_config::write(&a.home, &cfg).expect("write config");
    let back = &cfg.mcp_servers[cfg.mcp_servers.len() - 1];
    println!(
        "{}",
        serde_json::json!({
            "id": back.id,
            "command": back.command,
            "args": back.args,
            "env": back.env,
            "env_vars": back.env_vars,
            "enabled": back.enabled,
        })
    );
}