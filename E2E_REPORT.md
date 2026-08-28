# End-to-End Smoke Test Report · Codex Harness v0.1.0-p3

- Timestamp: 2026-08-28T16:51:05Z
- Workspace: /workspace/codex-harness-app
- Default LLM: **Volcengine Ark** · base_url=https://ark.cn-beijing.volces.com/api/coding/v3 · model=`ark-code-latest`

## 测试矩阵
| 编号 | 模块 | 结果 | 备注 |
|---|---|---|---|
| T2 | 账号密码登录(auth_tests 9 条) | PASS | test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 6.46s |
| T03-T06 | 最小对话(appserver tests) | PASS | test summary: [mock] POST /v1/responses auth=Bearer mock model=mock-model has_input=True tools=10
[mock] has_tool_result=True n_input_items=5 input_types=['message', 'message', 'message', 'function_call', 'function_call_output']
test full_turn_roundtrip_via_stdlib ... ok

test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 2.49s |
| T07 | 审批面板(4 决策+2 kind 分支) | PASS | ApprovalPanel.tsx 要素全 |
| T09 | 配置面板 write/read | PASS | mock-model + MOCK_KEY 写入 config.toml |
| T10 | 多模型路由(编码/敏感/长文本) | PASS | coding→gpt-4.1 / sensitive→reasoner / long→deepseek |
| T12 | 飞书 MCP(env 表+env_vars 数组+enabled roundtrip) | PASS | env=table + env_vars=array; unit feishu_mcp* 2/2 ✓ |
| T13 | 飞书 OAuth(缺配置错误语义) | PASS | --app-id and --app-secret required| |
| T14 | 技能/插件(roundtrip+discover) | PASS | harness-config 1/1 + harness-plugins 3/3 ✓ |
| T15 | 联网搜索(MCP+缺 key 错误分支) | PASS | Tavily MCP ✓ + missing key 语义 ✓ |
| T16 | 会话持久化(CRUD+搜索 8 步) | PASS | SQLite add/append×2/list/search/get/rename/delete 全 OK |
| FRONTEND | 前端 TypeScript + Vite build | PASS | tsc 0 错误; [32m✓ built in 818ms[39m |
| RUST-WS | Rust workspace cargo check | PASS | [1m[92m    Finished[0m `dev` profile [unoptimized + debuginfo] target(s) in 0.70s |
| ARK-LIVE | 火山方舟 Ark API 真实联通 | PASS | 非流式文本='你好' model=deepseek-v4-flash / SSE data 行数=7 > 2 |

## 汇总
- 总用例: **13** ｜ ✅ 通过: **13** ｜ ❌ 失败: **0**
- 通过率: **100.0%**

## 附录 A. 前端 UI 改版 6 要素核验
1. 侧栏会话列表：新对话+搜索框+5 种状态徽章+用户/工作区信息 ✅ App.tsx#L656-L720 styles.css#L168-L316
2. 消息区：气泡对话+Markdown+快捷 Chips+Typing+错误卡片 ✅ App.tsx#L742-L835 styles.css#L364-L495
3. 审批面板：暖色预警卡+命令代码块+4 决策按钮 ✅ ApprovalPanel.tsx styles.css#L632-L713
4. 配置面板 modal：model/provider/approval/mcp/skills/plugins ✅ ConfigPanel.tsx styles.css#L714-L870
5. 首次引导：3 步 onboarding（Ark→账号→任务）+ localStorage 跳过 ✅ App.tsx#L960-L1052 styles.css#L910-L1023
6. 暗色 Codex Agent IDE 风配色+响应式断点(1100/720px) ✅ styles.css#L9-L31 L1059-L1068

## 附录 B. 火山方舟 Ark 接入 3 要素核验
1. Rust default_ark_config：model/provider/base_url/env_key/wire_api 全填充 ✅ crates/harness-config/src/lib.rs#L226-L246
2. 子进程 env 硬编码注入 VOLCENGINE_ARK_API_KEY ✅ src-tauri/src/appserver.rs#L62-L67
3. 前端 MODEL_PRESETS 首位 Ark，含 2 个 model，默认 ark-code-latest ✅ frontend/src/models.ts#L17-L25

## 附录 C. 单测汇总（cargo test --workspace）
- harness-config: 6/6 ✅（config_tests 6 条：read_roundtrip / missing → Ark 默认 / write_absent / skills_plugins_roundtrip / feishu_env_table / feishu_disabled_roundtrip）
- harness-sessions: 3/3 ✅（roundtrip_crud / search_matches_title / rename_missing_errors）
- harness-search: 5/5 ✅（MCP 配置 / 缺 key 错误 / HTTP 状态码 / 结果解析 / 空 URL 过滤）
- harness-plugins: 3/3 ✅（skill 递归发现 / plugin manifest 解析 / 幂等性）
- harness-router: 14/14 ✅（unit 6 + e2e_router 8）
- harness-auth: 9/9 ✅（密码登录 / token 吊销 / store 回滚 / 幂等 / PBKDF 校验）
- harness-appserver: 2/2 ✅（stdio JSON-RPC 握手 + 协议版本）
