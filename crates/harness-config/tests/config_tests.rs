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
        provider_type: "Custom".into(),
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
    // codex 要求：每个自定义 provider 子表必须含 type = "Custom"，否则 codex
    // 按内置 provider id 查找，报 "Model provider 'deepseek' not found"
    assert!(raw.contains("type = \"Custom\""), "provider type (Custom) 缺失: {raw}");
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
    // 缺失 config.toml 时不再返回纯空结构，而是回落到「火山方舟 Ark」默认提供商，
    // 以保证首次启动即可出能力（P0 阶段 Ark 集成要求）。
    // 并且：默认配置必须**写回磁盘**，防止随后启动的 codex 二进制回退到内置废弃默认值。
    let dir = std::env::temp_dir().join(format!("harness-cfg-missing-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let home = dir.to_str().unwrap();
    let cfg = harness_config::read(home).unwrap();
    assert_eq!(cfg.model, "ark-code-latest");
    assert_eq!(cfg.model_provider, "volcengine-ark");
    assert_eq!(cfg.approval_policy, "on-request");
    assert_eq!(cfg.model_providers.len(), 1);
    assert_eq!(cfg.model_providers[0].id, "volcengine-ark");
    assert_eq!(cfg.model_providers[0].env_key, "VOLCENGINE_ARK_API_KEY");
    // base_url 指向 Coding Plan 企业版 Responses 兼容端点（2026-08-30 起只有 /api/coding/v3
    // 识别 ark-code-latest 别名；普通大模型 /api/v3 会报 "endpoint does not exist 404"）。
    assert_eq!(
        cfg.model_providers[0].base_url,
        "https://ark.cn-beijing.volces.com/api/coding/v3"
    );
    assert_eq!(cfg.model_providers[0].wire_api, "responses");

    // 关键：read() 必须已把默认配置写到磁盘，codex 二进制才能读到。
    let raw = fs::read_to_string(format!("{home}/config.toml"))
        .expect("read() 应对缺失文件把 default_ark_config() 写回磁盘");
    assert!(raw.contains("wire_api = \"responses\""), "缺失默认写入: {raw}");
    assert!(raw.contains("ark-code-latest"), "缺失默认模型写入: {raw}");
    assert!(raw.contains("ark.cn-beijing.volces.com/api/coding/v3"),
        "缺失 Coding Plan 企业版 Responses 端点写入: {raw}"
    );
    let _ = fs::remove_dir_all(&dir);
}

/// 回归测试（2026-08）：用户既有 config.toml 中 wire_api="chat"（已被 codex 废弃），
/// 必须在 read() 时自动改成 "responses"，并把修正结果写回磁盘（保证 codex 读到）。
#[test]
fn migration_fixes_chat_wire_api_on_disk() {
    let dir = std::env::temp_dir().join(format!("harness-cfg-chat-mig-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let home = dir.to_str().unwrap();

    // 模拟用户旧 config（典型场景：默认 Ark，但 wire_api 还是 chat）。
    fs::write(
        format!("{home}/config.toml"),
        r#"
model = "ark-code-latest"
model_provider = "volcengine-ark"

[model_providers.volcengine-ark]
name = "火山方舟 Ark Code"
base_url = "https://ark.cn-beijing.volces.com/api/coding/v3"
env_key = ""
wire_api = "chat"
"#,
    )
    .unwrap();

    let cfg = harness_config::read(home).unwrap();
    // 内存结构必须已修正。
    assert_eq!(cfg.model_providers[0].wire_api, "responses");
    // 2026-08-30 起：base_url 归一化到 Coding Plan 企业版 Responses 端点 /api/coding/v3
    assert_eq!(cfg.model_providers[0].base_url, "https://ark.cn-beijing.volces.com/api/coding/v3");
    assert_eq!(cfg.model_providers[0].env_key, "VOLCENGINE_ARK_API_KEY");

    // 磁盘上的真实文件必须同步修改（此条才是让 codex 正常的关键）。
    let raw = fs::read_to_string(format!("{home}/config.toml")).unwrap();
    assert!(
        !raw.contains("wire_api = \"chat\""),
        "wire_api=chat 仍留在磁盘上! file:\n{raw}"
    );
    assert!(raw.contains("wire_api = \"responses\""), "磁盘缺 responses: {raw}");
    assert!(
        raw.contains("ark.cn-beijing.volces.com/api/coding/v3"),
        "磁盘缺 Coding Plan 企业版端点 base_url: {raw}"
    );
    assert!(raw.contains("VOLCENGINE_ARK_API_KEY"), "磁盘缺 env_key: {raw}");
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

// ================ T19 + T18 · MCP register 幂等（retain + push 语义） ================

fn push_server(home: &str, server: McpServerConfig) {
    let mut cfg = harness_config::read(home).unwrap();
    cfg.mcp_servers.retain(|m| m.id != server.id);
    cfg.mcp_servers.push(server);
    harness_config::write(home, &cfg).unwrap();
}

fn base_server() -> McpServerConfig {
    McpServerConfig {
        id: "base".into(),
        command: "lark-openapi-mcp".into(),
        args: vec!["--mode=stdio".into(), "--enable-bitable".into()],
        env: Vec::new(),
        env_vars: vec![
            "FEISHU_USER_ACCESS_TOKEN".into(),
            "FEISHU_APP_ID".into(),
            "FEISHU_APP_SECRET".into(),
        ],
        enabled: true,
    }
}
fn rag_server() -> McpServerConfig {
    McpServerConfig {
        id: "rag".into(),
        command: "./harness-rag-mcp".into(),
        args: vec![
            "--base-url".into(),
            "http://127.0.0.1:18763".into(),
            "--default-collection".into(),
            "harness_default".into(),
        ],
        env: Vec::new(),
        env_vars: vec![
            "CHROMA_SERVER_AUTHN_CREDENTIALS".into(),
            "CHROMA_SERVER_AUTHN_PROVIDER".into(),
        ],
        enabled: true,
    }
}

#[test]
fn base_register_mcp_is_idempotent_no_duplicates() {
    let dir = std::env::temp_dir().join(format!("harness-cfg-base-idem-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let home = dir.to_str().unwrap();

    // 先预置一条 rag 再连续 3 次 push base，保证只产生 rag/base 各 1 条。
    push_server(home, rag_server());
    for _ in 0..3 {
        push_server(home, base_server());
    }
    let cfg = harness_config::read(home).unwrap();
    let count_rag = cfg.mcp_servers.iter().filter(|m| m.id == "rag").count();
    let count_base = cfg.mcp_servers.iter().filter(|m| m.id == "base").count();
    assert_eq!(count_rag, 1, "rag 重复: total={}", cfg.mcp_servers.len());
    assert_eq!(count_base, 1, "base 重复: total={}", cfg.mcp_servers.len());
    assert_eq!(cfg.mcp_servers.len(), 2);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn rag_register_mcp_is_idempotent_no_duplicates() {
    let dir = std::env::temp_dir().join(format!("harness-cfg-rag-idem-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let home = dir.to_str().unwrap();

    push_server(home, base_server());
    for _ in 0..3 {
        push_server(home, rag_server());
    }
    let cfg = harness_config::read(home).unwrap();
    assert_eq!(cfg.mcp_servers.iter().filter(|m| m.id == "rag").count(), 1);
    assert_eq!(cfg.mcp_servers.iter().filter(|m| m.id == "base").count(), 1);
    let _ = fs::remove_dir_all(&dir);
}