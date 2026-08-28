# codex-harness-app

基于 OpenAI Codex 开源 harness（`github.com/openai/codex`，Apache-2.0）封装的企业内部 Agent 桌面应用。

整合飞书 API、企业知识库（RAG）、联网搜索与多模型 API，构建本地可安装的 Agent 工作平台。

## 技术路线

- **桌面框架**：Tauri 2.x（Rust 后端 + WebView 前端）
- **前端**：React + TypeScript + Tailwind（流式 Markdown 渲染）
- **harness 通信**：`codex` app-server 子进程，stdio JSON-RPC（MCP v2 RPC：thread/turn）
- **外部能力**：MCP 工具注入（飞书 lark-mcp / Tavily / RAG / 子 Agent）
- **多模型**：`[model_providers]` + `[model] model_provider` 切换 OpenAI/DeepSeek/GLM 等 OpenAI 兼容端点

## 依赖仓库

- `windyisland-aiot/codex` —— fork 自 openai/codex，本项目的 harness 底座

## 任务清单

见 [TASKS.md](TASKS.md)（按 P0/P1/P2 等级拆分）。

## License

本仓库为内部项目（私有）。底层 openai/codex 为 Apache-2.0。