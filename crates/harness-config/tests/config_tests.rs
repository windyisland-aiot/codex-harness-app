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
        env: vec!["FEISHU_APP_ID=cli_abc".into(), "FEISHU_APP_SECRET=s3cret".into()],
        env_vars: vec!["LARK_TOKEN".into()],
        enabled: true,
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
    assert!(raw.contains("FEISHU_APP_ID"), "feishu env entry lost: {raw}");
    assert!(raw.contains("LARK_TOKEN"), "feishu env_vars lost: {raw}");

    // 重新读回，验证一致性。
    let back = harness_config::read(home).unwrap();
    assert_eq!(back.model, "gpt-4.1");
    assert_eq!(back.model_provider, "deepseek");
    assert_eq!(back.model_providers.len(), 2);
    assert_eq!(back.mcp_servers.len(), 2);
    assert_eq!(back.approval_policy, "on-request");

    let _ = fs::remove_dir_all(&dir);
}

/// T12：`[mcp_servers.feishu]` 序列化为 codex 期望的表格式 env / env_vars 数组。
#[test]
fn feishu_mcp_env_serializes_as_table() {
    let dir = std::env::temp_dir().join(format!("harness-cfg-feishu-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let home = dir.to_str().unwrap();

    harness_config::write(
        home,
        &AppConfig {
            mcp_servers: vec![McpServerConfig {
                id: "feishu".into(),
                command: "lark-openapi-mcp".into(),
                args: vec!["--mode=stdio".into()],
                env: vec!["FEISHU_APP_ID=cli_x1y2".into(), "FEISHU_APP_SECRET=zzqq".into()],
                env_vars: vec!["LARK_USER_TOKEN".into(), "LARK_API_TOKEN".into()],
                enabled: true,
            }],
            ..AppConfig::default()
        },
    )
    .unwrap();

    let raw = fs::read_to_string(format!("{home}/config.toml")).unwrap();
    // env 必须写成表（键值对），而非字符串。
    assert!(
        raw.contains("FEISHU_APP_ID = \"cli_x1y2\"") || raw.contains("FEISHU_APP_ID=\"cli_x1y2\""),
        "env 未写成表: {raw}"
    );
    assert!(raw.contains("\"LARK_USER_TOKEN\""), "env_vars 不在: {raw}");

    let back = harness_config::read(home).unwrap();
    assert_eq!(back.mcp_servers.len(), 1);
    let f = &back.mcp_servers[0];
    assert_eq!(f.command, "lark-openapi-mcp");
    assert!(f.env.contains(&"FEISHU_APP_ID=cli_x1y2".to_string()));
    assert_eq!(f.env_vars, vec!["LARK_USER_TOKEN".to_string(), "LARK_API_TOKEN".to_string()]);
    assert!(f.enabled);
    let _ = fs::remove_dir_all(&dir);
}

/// T12：`enabled = false` 的 MCP server 会被保留为禁用状态。
#[test]
fn feishu_mcp_disabled_flag_roundtrips() {
    let dir = std::env::temp_dir().join(format!("harness-cfg-feishu-off-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let home = dir.to_str().unwrap();

    harness_config::write(
        home,
        &AppConfig {
            mcp_servers: vec![McpServerConfig {
                id: "feishu".into(),
                command: "lark-openapi-mcp".into(),
                args: vec![],
                env: vec![],
                env_vars: vec![],
                enabled: false,
            }],
            ..AppConfig::default()
        },
    )
    .unwrap();

    let raw = fs::read_to_string(format!("{home}/config.toml")).unwrap();
    assert!(raw.contains("enabled = false"), "enabled=false 未写入: {raw}");
    let back = harness_config::read(home).unwrap();
    assert!(!back.mcp_servers[0].enabled);
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

/// T14：`[skills]`（bundled/include_instructions/config）与 `[plugins.<id>]` 读写往返。
#[test]
fn skills_and_plugins_roundtrip() {
    use harness_config::{PluginRule, SkillRule};

    let dir = std::env::temp_dir().join(format!("harness-cfg-plugins-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let home = dir.to_str().unwrap();
    let cfg = AppConfig {
        bundled_skills_enabled: Some(false),
        skills_include_instructions: Some(false),
        skills: vec![
            SkillRule {
                name: "code-review".into(),
                path: String::new(),
                enabled: false,
            },
            SkillRule {
                name: String::new(),
                path: "/opt/skills/git-help".into(),
                enabled: true,
            },
        ],
        plugins: vec![
            PluginRule { id: "audit".into(), enabled: false },
            PluginRule { id: "notify".into(), enabled: true },
        ],
        ..Default::default()
    };
    harness_config::write(home, &cfg).unwrap();
    let raw = fs::read_to_string(format!("{home}/config.toml")).unwrap();
    assert!(raw.contains("include_instructions = false"), "{raw}");
    assert!(raw.contains("[skills.bundled]"), "{raw}");
    assert!(raw.contains("enabled = false"), "{raw}");
    assert!(raw.contains("[plugins.audit]"), "{raw}");
    assert!(raw.contains("[plugins.notify]"), "{raw}");
    // enabled=true 的插件默认不写 enabled 字段，但仍应有节存在。

    let back = harness_config::read(home).unwrap();
    assert_eq!(back.bundled_skills_enabled, Some(false));
    assert_eq!(back.skills_include_instructions, Some(false));
    assert_eq!(back.skills.len(), 2);
    assert_eq!(back.skills[0].name, "code-review");
    assert!(!back.skills[0].enabled);
    assert_eq!(back.skills[1].path, "/opt/skills/git-help");
    assert!(back.skills[1].enabled);
    assert_eq!(back.plugins.len(), 2);
    assert_eq!(back.plugins[0].id, "audit");
    assert!(!back.plugins[0].enabled);
    assert_eq!(back.plugins[1].id, "notify");
    assert!(back.plugins[1].enabled);
    let _ = fs::remove_dir_all(&dir);
}