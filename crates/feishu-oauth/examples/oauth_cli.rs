//! T13 飞书 OAuth 命令行示例：app_access_token / 授权链接 / exchange / refresh。
//! 每个子命令输出 JSON 便于黑盒 e2e 复用。
//!
//! 用法：
//!   --app-id <id> --app-secret <secret> [--base-url <url>] [--redirect-uri <uri>] <cmd> [args]
//!   cmd:
//!     app-token           取 app_access_token
//!     auth-url [--state s]  生成授权链接
//!     exchange <code>      用授权码换 token（输出完整 bundle）
//!     refresh <refresh-token>  刷新 token

use harness_feishu_oauth::{FeishuOAuth, FeishuOAuthConfig};

#[derive(Default)]
struct Args {
    app_id: String,
    app_secret: String,
    base_url: String,
    redirect_uri: String,
    cmd: String,
    positional: Vec<String>,
    state: String,
}

fn main() {
    let mut a = Args::default();
    let mut it = std::env::args().skip(1);
    while let Some(x) = it.next() {
        match x.as_str() {
            "--app-id" => a.app_id = it.next().unwrap_or_default(),
            "--app-secret" => a.app_secret = it.next().unwrap_or_default(),
            "--base-url" => a.base_url = it.next().unwrap_or_default(),
            "--redirect-uri" => a.redirect_uri = it.next().unwrap_or_default(),
            "--state" => a.state = it.next().unwrap_or_default(),
            _ => {
                if a.cmd.is_empty() {
                    a.cmd = x;
                } else {
                    a.positional.push(x);
                }
            }
        }
    }
    if a.app_id.is_empty() || a.app_secret.is_empty() {
        eprintln!("--app-id and --app-secret required");
        std::process::exit(2);
    }

    let cfg = FeishuOAuthConfig {
        app_id: a.app_id,
        app_secret: a.app_secret,
        redirect_uri: a.redirect_uri,
        base_url: if a.base_url.is_empty() {
            harness_feishu_oauth::FEISHU_OPEN_BASE.to_string()
        } else {
            a.base_url
        },
        ..Default::default()
    };
    let client = FeishuOAuth::new(cfg);

    match a.cmd.as_str() {
        "app-token" => {
            match client.app_access_token() {
                Ok(t) => println!(
                    "{}",
                    serde_json::json!({
                        "ok": true,
                        "code": t.code,
                        "token": t.token,
                        "expire": t.expire,
                    })
                ),
                Err(e) => {
                    eprintln!("error: {e}");
                    std::process::exit(1);
                }
            }
        }
        "auth-url" => {
            let state = a.state;
            println!("{}", serde_json::json!({ "ok": true, "url": client.authorize_url(&state) }));
        }
        "exchange" => {
            let code = a.positional.first().map(String::as_str).unwrap_or("");
            match client.exchange_code(code) {
                Ok(b) => println!("{}", serde_json::to_string(&b).unwrap()),
                Err(e) => {
                    eprintln!("error: {e}");
                    std::process::exit(1);
                }
            }
        }
        "refresh" => {
            let tok = a.positional.first().map(String::as_str).unwrap_or("");
            match client.refresh(tok) {
                Ok(b) => println!("{}", serde_json::to_string(&b).unwrap()),
                Err(e) => {
                    eprintln!("error: {e}");
                    std::process::exit(1);
                }
            }
        }
        other => {
            eprintln!("unknown cmd: {other}");
            std::process::exit(2);
        }
    }
}