# 任务拆分（按等级）

> 基于《基于 Codex 源码搭建公司内部 Harness 应用》需求文档 + 源码可行性调研。
> 等级定义：**P0 阻塞性基础（必须先完成并打通端到端）/ P1 核心功能（MVP 迭代主线）/ P2 增强与规模化**。
> 相关结论：协议用 app-server stdio JSON-RPC；模型改用 `[model_providers.<id>]` + `[model] model_provider`；安装包体积 ≤30MB 存在风险需调整。

---

## P0 —— 端到端底座（必须全部完成）

| ID | 任务 | 说明 / 验收 |
|----|------|-------------|
| T01 | 编译 Codex 核心二进制 | fork 仓库编译 `codex`（app-server/cli），产出平台可执行文件 |
| T02 | 验证 `codex mcp-server` 最小对话 | 用 MCP inspect/client 打通 thread/start → turn/start → turn/completed → approval |
| T03 | Tauri 2.x 工程骨架 | 建桌面应用骨架，三平台编译项（Win/macOS/Linux） |
| T04 | app-server stdio 集成 | Tauri 后端将 `codex` 作为子进程启动，实现 JSON-RPC over stdio 客户端 |
| T05 | 基础对话 UI | 指令输入、流式输出（Markdown 渲染）、会话列表 |
| T06 | 单模型打通（OpenAI） | `[model_providers.openai]` 配置 + `[model] model_provider = "openai"`，验证端到端 |
| T07 | 审批面板 | 处理 `execCommandApproval`/`applyPatchApproval`，弹出确认/拒绝 |

## P1 —— 核心功能（MVP 主循环）

| ID | 任务 | 说明 / 验收 |
|----|------|-------------|
| T08 | 配置面板 | 模型选择、MCP server 管理、权限设置，写/读 config.toml |
| T09 | 多模型切换 | 预设 OpenAI/DeepSeek/GLM，改 base_url + env_key，下一个 Turn 生效 |
| T10 | 模型路由 | 按任务类型/上下文长度/成本/敏感度路由到不同模型 |
| T11 | 飞书 MCP 集成 | 注册 `[mcp_servers.feishu]`（lark-openapi-mcp），验证消息/文档操作 |
| T12 | 飞书 OAuth | 用户授权流程 + token 自动刷新（app_access_token/user_access_token） |
| T13 | 插件与 Skill 系统 | 加载 openai/skills、openai/plugins 与自定义插件，插件管理界面 |
| T14 | 联网搜索 | 注册 Tavily/Serper MCP，搜索过程与来源展示 |
| T15 | 会话持久化 | SQLite 存历史会话，支持搜索/重命名/恢复 |
| T16 | 三平台安装包 | 生成 .msi/.dmg/.deb，校准体积（承接体积结论） |

## P2 —— 增强与规模化

| ID | 任务 | 说明 / 验收 |
|----|------|-------------|
| T17 | 知识库 RAG MCP Server | LlamaIndex/LangChain + ChromaDB/Qdrant，暴露 search/index 工具 |
| T18 | 飞书 Wiki/文档增量索引 | Webhook 触发重嵌入 + 定期全量兜底 |
| T19 | 多 Agent 编排 | 通过 `codex mcp-server` 注册代码审查/文档生成/数据分析等子 Agent |
| T20 | 主 Agent 任务分发 | 主 Agent 按子任务分发并汇总结果 |
| T21 | 知识库管理界面 | 索引状态、数据源配置、检索测试 |
| T22 | 安全与加固 | 敏感数据不出企业、模型路由到本地模型、权限审计 |
| T23 | 升级与回滚 | fork 后续 rebase 上游 openai/codex，协议向后兼容验证 |

---

## 实施顺序依赖

```
P0: T01→T02→T03→T04→T05→T06→T07   (T03 可与 T01/T02 并行)
P1: T08→T09→T10 (模型主线)，T08→T11→T12 (飞书主线)，T13/T14/T15/T16 可并行
P2: T17→T18→T21 (知识库)，T19→T20 (多 Agent)，T22/T23 贯穿
```