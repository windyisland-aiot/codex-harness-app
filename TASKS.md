# 任务拆分（按等级）

> 基于《基于 Codex 源码搭建公司内部 Harness 应用》需求文档 + 源码可行性调研。
> 等级定义：**P0 阻塞性基础（必须先完成并打通端到端）/ P1 核心功能（MVP 迭代主线）/ P2 增强与规模化**。
> 相关结论：协议用 app-server stdio JSON-RPC；模型改用 `[model_providers.<id>]` + `[model] model_provider`；安装包体积 ≤30MB 存在风险需调整。
> **目标平台：仅 Windows**。T17 起只产出 Windows 安装包，后续所有需求面向 Windows（.msi/.exe，WebView2）。

---

## P0 —— 端到端底座（必须全部完成）

| ID | 任务 | 说明 / 验收 | 状态 |
|----|------|-------------|------|
| T01 | 编译 Codex 核心二进制 | fork 仓库编译 `codex`（app-server/cli），产出平台可执行文件 | ✅ |
| T02 | 账号密码登录功能 | 应用级账号/口令登录：登录界面、后端校验、token 会话保持、登出；与多模型/飞书等工具凭据分离 | ✅ |
| T03 | 验证 `codex mcp-server` 最小对话 | 用 MCP inspect/client 打通 thread/start → turn/start → turn/completed → approval | ✅ |
| T04 | Tauri 2.x 工程骨架 | 建桌面应用骨架，面向 Windows（.msi/.exe，WebView2），预留跨平台结构 | ✅ |
| T05 | app-server stdio 集成 | Tauri 后端将 `codex` 作为子进程启动，实现 JSON-RPC over stdio 客户端 | ✅ |
| T06 | 基础对话 UI | 指令输入、流式输出（Markdown 渲染）、会话列表 | ✅ |
| T07 | 单模型打通（OpenAI） | `[model_providers.openai]` 配置 + `[model] model_provider = "openai"`，验证端到端 | ✅ |
| T08 | 审批面板 | 处理 `execCommandApproval`/`applyPatchApproval`，弹出确认/拒绝 | ✅ |

> 默认模型已切换为 volcengine-ark (ark-code-latest)，经由内嵌网关 127.0.0.1:18762 做 Chat→Responses 协议归一化。

## P1 —— 核心功能（MVP 主循环）

| ID | 任务 | 说明 / 验收 | 状态 |
|----|------|-------------|------|
| T09 | 配置面板 | 模型选择、MCP server 管理、权限设置，写/读 config.toml | ✅ |
| T10 | 多模型切换 | 预设 OpenAI/DeepSeek/GLM，改 base_url + env_key，下一个 Turn 生效 | ✅ |
| T11 | 模型路由 | 按任务类型/上下文长度/成本/敏感度路由到不同模型 | ✅ |
| T12 | 飞书 MCP 集成 | 注册 `[mcp_servers.feishu]`（lark-openapi-mcp），验证消息/文档操作 | ✅ |
| T13 | 飞书 OAuth | 用户授权流程 + token 自动刷新（app_access_token/user_access_token） | ✅ |
| T14 | 插件与 Skill 系统 | 加载 openai/skills、openai/plugins 与自定义插件，插件管理界面 | ✅ |
| T15 | 联网搜索 | 注册 Tavily/Serper MCP，搜索过程与来源展示 | ✅ |
| T16 | 会话持久化 | SQLite 存历史会话，支持搜索/重命名/恢复 | ✅ |
| T17 | Windows 安装包 | 生成 Windows .msi/.exe（NSIS/WebView2），校准体积（承接体积结论），CI 上构建并上传 GitHub Release | ✅ |

## UI/UX · Trae Work 风格改版

| ID | 任务 | 说明 / 验收 | 状态 |
|----|------|-------------|------|
| T25 | UI 顶栏重构 | 高度 42px、汉堡/搜索/菜单/主题切换/窗口按钮，`app-region: drag`，移除旧 brand/H/pill/model-switch/RouterPanel 等 | ✅ |
| T26 | 左栏 Trae 风格重构 | 合并 rail+sidebar 为单栏 272px，顶部 Work/Code/Design pill，菜单项 5 个，任务列表+搜索，底部 user footer；collapsed 时宽度 0 | ✅ |
| T27 | 对话框模型下拉切换器 | composer 正上方内联 ModelSwitcher pill，欢迎页正中再放一个，可切 provider+模型二级菜单 | ✅ |
| T28 | 单按钮发送 + 清理杂项控件 | 单圆形发送按钮（↑ SVG，紫蓝 gradient），删除 Work/Code 双按钮、三个勾选框、Enter 发送提示 | ✅ |
| T29 | Markdown 渲染增强（表格/代码块复制/列表） | 代码块 header+复制按钮（DOM 挂载式），表格全边框+zebra，blockquote 左侧 #6366F1 竖线，列表缩进美化 | ✅ |
| T30 | 小窗口布局弹性修复 | 所有 flex/grid 容器 min-width/min-height:0；`@media (max-width:720px)` 侧栏 auto-collapse、composer 模型 pill 简化、msglist padding 减 | ✅ |
| T31 | Ark 网关流式 SSE writer-closed 修复 | `stream.set_write_timeout` 600s；`write_simple` 吞 BrokenPipe/ConnectionReset；SSE 场景 chunked streaming 每 256ms flush；5xx body sanitize；upstream 错误不泄漏 key | ✅ |

## P2 —— 增强与规模化

| ID | 任务 | 说明 / 验收 |
|----|------|-------------|
| T18 | 知识库 RAG MCP Server | LlamaIndex/LangChain + ChromaDB/Qdrant，暴露 search/index 工具 |
| T19 | 飞书 Wiki/文档增量索引 | Webhook 触发重嵌入 + 定期全量兜底 |
| T20 | 多 Agent 编排 | 通过 `codex mcp-server` 注册代码审查/文档生成/数据分析等子 Agent |
| T21 | 主 Agent 任务分发 | 主 Agent 按子任务分发并汇总结果 |
| T22 | 知识库管理界面 | 索引状态、数据源配置、检索测试 |
| T23 | 安全与加固 | 敏感数据不出企业、模型路由到本地模型、权限审计、与 T02 登录结合 |
| T24 | 升级与回滚 | fork 后续 rebase 上游 openai/codex，协议向后兼容验证 |

---

## 实施顺序依赖

```
P0: T01→T03→T04→T05→T06→T07→T08
    T02(账号密码登录)：逻辑可先行设计，端到端验证依赖 T04/T05/T06 应用外壳与 UI 就绪，与 T06–T08 并行推进
P1: T09→T10→T11 (模型主线)，T09→T12→T13 (飞书主线)，T14/T15/T16/T17 可并行；T25–T31 (UI/UX) 并行迭代
P2: T18→T19→T22 (知识库)，T20→T21 (多 Agent)，T23/T24 贯穿
```
