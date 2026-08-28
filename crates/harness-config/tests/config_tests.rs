//! harness-config 读写与合并语义单元测试。

use std::fs;

use harness_config::{McpServerConfig, ProviderConfig, AppConfig};

#[test]
fn read_roundtrip_preserves_unknown_keys() {
    let dir = std::env::temp_dir().join(format!("harness-cfg-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let home = dir.to_str().unwrap();

    // 预置一份含“未管理”字段的配置（experimental / 其它顶层键）。
    fs::write(
        format!("{home}/config.toml"),
        r#"
model = "mock-model"
model_provider = "mock"
approval_policy = "on-request"
experimental_realtime_ws_base_url = "wss://example.com"

[model_providers.mock]
name = "mock"
base_url = "http://127.0.0.1:8791/v1"
env_key = "MOCK_KEY"
wire_api = "responses"

[mcp_servers.fs]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem"]
"#,
    )
    .unwrap();

    let cfg = harness_config::read(home).unwrap();
    assert_eq!(cfg.model, "mock-model");
    assert_eq!(cfg.model_provider, "mock");
    assert_eq!(cfg.approval_policy, "on-request");
    assert_eq!(cfg.model_providers.len(), 1);
    assert_eq!(cfg.model_providers[0].id, "mock");
    assert_eq!(cfg.model_providers[0].env_key, "MOCK_KEY");
    assert_eq!(cfg.mcp_servers.len(), 1);
    assert_eq!(cfg.mcp_servers[0].id, "fs");
    assert_eq!(cfg.mcp_servers[0].args, vec!["-y", "@modelcontextprotocol/server-filesystem"]);

    // 修改一部分再写回。
    let mut edited = cfg.clone();
    edited.model = "gpt-4.1".to_string();
    edited.model_provider = "deepseek".to_string();
    edited.model_providers.push(ProviderConfig {
        id: "deepseek".into(),
        name: "DeepSeek".into(),
        base_url: "https://api.deepseek.com/v1".into(),
        env_key: "DEEPSEEK_API_KEY".into(),
        wire_api: "chat".into(),
    });
    edited.mcp_servers.push(McpServerConfig {
        id: "feishu".into(),
        command: "lark-openapi-mcp".into(),
        args: vec!["--listen".into()],
        env: String::new(),
    });
    harness_config::write(home, &edited).unwrap();

    let raw = fs::read_to_string(format!("{home}/config.toml")).unwrap();
    // 未管理字段必须保留
    assert!(raw.contains("experimental_realtime_ws_base_url"), "unknown key lost: {raw}");
    // 更新后的字段生效
    assert!(raw.contains("model = \"gpt-4.1\""));
    assert!(raw.contains("model_provider = \"deepseek\""));
    assert!(raw.contains("DEEPSEEK_API_KEY"));
    assert!(raw.contains("[mcp_servers.feishu]"));

    // 重新读回，验证一致性。
    let back = harness_config::read(home).unwrap();
    assert_eq!(back.model, "gpt-4.1");
    assert_eq!(back.model_provider, "deepseek");
    assert_eq!(back.model_providers.len(), 2);
    assert_eq!(back.mcp_servers.len(), 2);
    assert_eq!(back.approval_policy, "on-request");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn read_missing_file_returns_defaults() {
    let dir = std::env::temp_dir().join(format!("harness-cfg-missing-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let cfg = harness_config::read(dir.to_str().unwrap()).unwrap();
    assert_eq!(cfg.model, "");
    assert!(cfg.model_providers.is_empty());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn write_creates_file_when_absent() {
    let dir = std::env::temp_dir().join(format!("harness-cfg-new-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let home = dir.to_str().unwrap();
    let mut cfg = AppConfig::default();
    cfg.model = "grok".into();
    cfg.model_provider = "xai".into();
    harness_config::write(home, &cfg).unwrap();
    let raw = fs::read_to_string(format!("{home}/config.toml")).unwrap();
    assert!(raw.contains("model = \"grok\""));
    let _ = fs::remove_dir_all(&dir);
}