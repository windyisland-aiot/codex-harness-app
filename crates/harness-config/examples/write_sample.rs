//! 演练示例：用 harness-config 写入一份 config.toml，随后 codex app-server 据此解析默认模型。
//!
//! ```sh
//! CODEX_HOME=/tmp/cfg-e2e-home cargo run -p harness-config --example write_sample
//! ```

use harness_config::{AppConfig, ProviderConfig};

fn main() {
    let home = std::env::var("CODEX_HOME").expect("set CODEX_HOME");
    let cfg = AppConfig {
        model: "mock-model".into(),
        model_provider: "mock".into(),
        approval_policy: "on-request".into(),
        model_providers: vec![ProviderConfig {
            id: "mock".into(),
            name: "mock".into(),
            base_url: "http://127.0.0.1:8791/v1".into(),
            env_key: "MOCK_KEY".into(),
            wire_api: "responses".into(),
        }],
        mcp_servers: Vec::new(),
        ..Default::default()
    };
    harness_config::write(&home, &cfg).expect("write config");
    println!("wrote config.toml to {home}");
    println!("{}", std::fs::read_to_string(harness_config::config_path(&home)).unwrap());
}