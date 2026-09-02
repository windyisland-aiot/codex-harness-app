# P2 阶段交付规格（Harness Enterprise Internal Agent）

> 自然语言：中文
> 阶段范围：TASKS.md 中「P2 增强与规模化」的 **可交付子集**（见「范围裁剪」）。
> 目标版本：**v0.5.0**（harness-app 0.4.0 已用于 T18；本阶段发布升至 0.5.0）。
> 目标产物：① 所有新增 crate 与修改全部通过单元/集成测试（rust test、tsc、vite build）；② 触发 CI workflow 产出 `Harness_0.5.0_x64_en-US.msi` + `Harness_0.5.0_x64-setup.exe`；③ 通过 `softprops/action-gh-release@v2` 上传到 `windyisland-aiot/codex-harness-app/releases/tag/v0.5.0`。

---

## 1. 问题 / 用户 / 目标 / 非目标

### 问题
- P1 已能对话、切模型、接入飞书 IM 与搜索，但企业内部广告文案/策划团队**缺少可复用的「公司知识库检索」+「飞书多维表格作业闭环」**能力；现有 codex 仅能通过 prompt 拼接上下文，无法系统化处理品牌话术、竞品分析、排期看板回写。
- P0/P1 的 CI 构建**曾连续失败于 tauri-bundler NSIS/WiX 的 CDN 504 与下载目录不匹配**，导致 Release 资产不可用或上传失败。
- 审批面板 UI 与系统审批流程**尚未真正落地到飞书审批**，企业合规要求有留痕审批，而非仅弹窗确认。

### 用户
| 角色 | 场景 |
|------|------|
| 策划 / 运营 | 输入 brief → 检索知识库（品牌话术/竞品/历史案例）→ 生成广告脚本 → 回写多维表格 → 提交飞书审批 |
| 管理者 | 在多维表格看板里审阅，审批单通过/驳回有系统留痕 |
| 实施工程师 | 安装 v0.5.0 安装包，启用 RAG（Chroma 18763）+ 飞书多维表格 MCP + 飞书审批，一键跑通自检 |

### 目标
1. **T19 飞书多维表格（Base）MCP Server**：SettingsPanel MCP 区新增「启用飞书多维表格 MCP」按钮；Tauri 提供 `base_register_mcp` / `base_status` / `base_health` 三命令；前端显示健康卡片 + 常见工具映射（建表/读记录/增记录/改字段/看板视图）。
2. **T20 RAG 入库流水线**：`harness-rag` crate 增加 `ingest` 子命令（文档切片 → 计算 embedding → 写入 Chroma）；前端知识库管理页支持「选择文件 → 导入 → 显示进度/已入库 chunk 数」；提供一键自检「索引 + 搜索」。
3. **T21 多 Agent 编排：广告脚本生成闭环**：通过 MCP tool call 编排成「brief 解析 → RAG 检索 → 脚本草案生成 → 写回多维表格 → 触发飞书审批」5 步工作流；至少产出 2 个可执行单元测试（无外部依赖）证明编排结构正确。
4. **T22 审批 ↔ 飞书审批直连**：审批面板新增「同步到飞书审批」按钮；后端 `approval_send_to_feishu` 返回飞书审批链接；前端在审批卡片内呈现「飞书审批单已创建 · 查看链接」；本地下拉审批与飞书结果回写同步。
5. **CI Release 稳定化**：修复 Windows 构建 `tauri build` 阶段偶发 504/404（3 次指数退避 + NSIS/WiX 镜像缓存），确保 `v0.5.0` 推送 tag 时 MSI + EXE 都能稳定上传到 Release。
6. 所有变更**必须有测试**（TDD）；交付前跑 `cargo test --workspace --exclude harness-app` + `tsc --noEmit` + `vite build` 全绿。

### 非目标（Out of Scope）
- TASKS.md 中的 T23（安全与加固）、T24（升级回滚）：**不在本阶段**，留待 P3。
- 本地 embedding 模型推理（Ollama 等）：RAG 入库默认使用用户在 `[model_providers]` 中已配置的**文本嵌入** Custom 提供程序或环境变量 `OPENAI_API_KEY`（不要求纯本地）。
- 不产出 macOS/Linux 构建产物；仍仅面向 Windows x64。
- 不做用户/组级 RBAC；企业域集成在 P3。
- 不修改上游 codex 协议层；全部通过 `mcp_servers.<id>` 与 Tauri 命令新增。

---

## 2. 功能需求（Functional Requirements）

FR1. SettingsPanel → MCP 标签
- 新增按钮「+ 启用飞书多维表格 MCP（lark-openapi-mcp bitable 路由）」。
- 当检测到 `mcpServers[i].id == "base"` 时，展示 Base 健康卡片：base 应用 ID / 表数量 / 连通性（`lark-cli base` 等价的轻量健康检查，失败时给出 `lark-cli auth login` 提示）。
- 原飞书 IM MCP 卡片（feishu）保留；与 Base 健康卡同页。

FR2. Tauri base 命令
- `base_register_mcp(codexHome, appToken?, envVars?) → McpServerConfig`：写入 `[mcp_servers.base]`，command=`lark-openapi-mcp`，args 追加 `--enable-bitable`，envVars 默认含 `FEISHU_USER_ACCESS_TOKEN`、`FEISHU_APP_ID`、`FEISHU_APP_SECRET`。
- `base_status(codexHome) → { registered, enabled, appTokenHint }`。
- `base_health(appToken?) → { ok, message, hint }`：对飞书 openapi 做一次只读 ping（`GET /open-apis/auth/v3/app_access_token/internal` 用已注册凭据），失败时给出安装/授权兜底文案。

FR3. `harness-rag` 新增 `ingest` 能力
- 在现有 `RagClient` 基础上，增加一个公开函数（或新的 `ingest` 模块）：`fn chunk_markdown(src: &str, chunk_chars: usize, overlap: usize) -> Vec<String>`（纯函数）。
- `fn embed_texts(base_url: &str, model: &str, texts: &[String]) -> Result<Vec<Vec<f32>>, RagError>`：通过 Chroma 自身 `/api/v1/embeddings`（tenant/database header 可选）调用默认 embedding function，避免硬依赖 Python。
- CLI `harness-rag` 的 `rag_cli.rs` 新增 `ingest <collection> <file.md>` 子命令（chunk → embed → add_documents）。
- 单元测试：`chunk_markdown` 边界测试（空串 / 单 chunk / overlap=0 / overlap 比 chunk 大）。

FR4. 前端 知识库管理页（T22 原型，沿用 TASKS.md 命名）
- 新增 SettingsPanel 顶部 tab「知识库」（或复用 MCP 区的 RAG 健康卡片扩展）：① Chroma 健康；② Collection 列表；③ 「选择 MD 文件并导入」按钮 + 进度 + chunk 计数；④ 「搜索测试」输入框 + 结果列表（命中 doc、distance）。
- 本页不做拖拽批量上传；单文件选择足以满足 MVP。

FR5. 广告脚本生成工作流（T21）
- 在 `crates/harness-plugins` 中新增模块 `ad_script_workflow.rs`：一个不依赖网络的纯数据编排器 `AdScriptWorkflow`。
- 输入：`brief: String`（brief 文本）；输出：Step1..Step5 的有序 Step 数组，每步包含 id、name、requiredTool（`rag.search` / `llm.generate` / `base.insert` / `feishu_approval.submit` 之一）、payload。
- 纯函数测试：给定一个 brief，`Step1 = rag.search(品牌话术+竞品)` 必出；`Step4 = base.insert` 必出；`Step5 = feishu_approval.submit` 必出。
- 前端：在左侧「新建任务」模板中，新增模板「广告脚本生成（T21 工作流）」，选中后自动填入 Step1..Step5 提示前缀（暂不要求 Codex 内部执行，但 UI 与后端工作流定义一致）。

FR6. 审批 ↔ 飞书审批直连（T22 子项）
- 新增 Tauri 命令：`approval_send_to_feishu(approvalId, summary, approverOpenIds, deptId?, formData?) -> { approvalCode, instanceCode, link }`，封装 `lark-openapi-mcp` 的审批发起。
- 前端 ApprovalPanel：每条审批在「允许/拒绝」区下方新增按钮「🔗 发起飞书审批」，点击后调用上述命令，成功后在该条顶部显示「飞书审批已创建 — 实例 {instanceCode}」并给出 a 标签链接。
- 纯实现不要求真实飞书账号；单元测试用 mock HTTP 返回 OK 即算通过。

FR7. CI Release 稳定化
- `.github/workflows/build-windows-release.yml`：
  - 新增 `TAURI_BUNDLER_NSI_URL` / `TAURI_BUNDLER_WIX_URL` 环境变量，指向 jsdelivr / ghproxy 镜像（如 `https://cdn.jsdelivr.net/gh/tauri-apps/binary-releases@tauri-bundler-v2`）优先；回退官方。
  - 对 NSIS 与 WiX 的 tar/zip 先 `Invoke-WebRequest -MaximumRetryCount 5 -RetryIntervalSec 10` 下载到 `$env:LOCALAPPDATA\tauri-bundler\cache\`，再让 tauri-bundler 通过环境变量读。
  - `tauri build` 指数退避保留 3 次；每次失败时把 `$env:TEMP\tauri-bundler-*.log` 上传到 artifact 以便排查。
- 版本号：`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 从 0.4.0 升至 **0.5.0**；`DEPLOY.md` What's New 同步 v0.5.0 条目。

---

## 3. 非功能需求（Non-Functional Requirements）

NFR1. 测试密度
- 每个新增 public 函数至少 1 条 RED→GREEN 单元测试。
- `workspace` 内非 Tauri crate 的 `cargo test` 通过率 100%。`harness-app`（Tauri）在 Linux 沙盒缺失 glib-2.0 时**不强制通过**，但需在 `cargo check -p harness-app --no-default-features --target x86_64-unknown-linux-gnu 2>&1 | tail -30` 中显示仅为 glib 外部依赖导致，不产生任何 Rust 语法/类型错误。

NFR2. 构建指标
- 前端 `tsc --noEmit` exit 0；`vite build` 成功且总 JS ≤ 350 KB（gzip ≤ 120 KB），CSS ≤ 60 KB。

NFR3. 可观测性
- 每个健康检查（rag_health / base_health / search_status）返回 `{ ok, message, hint }` 三元组；hint 给出**中文可复制**的安装/授权命令行，便于首启用户自助排障。

NFR4. 安全
- 不把任何真实 key 写进配置文件 `env = { KEY = "value" }` 结构；默认用 `env_vars` 透传进程环境变量，除非前端用户在 UI 显式填写并勾选「写入 env」。
- 健康检查请求对失败响应 body 做**脱敏**（正则替换 `key=...` / `token=...` / `Authorization: Bearer ...` 为 `[REDACTED]`）。

NFR5. 兼容性
- 新增 MCP server 条目 id 固定为：`rag`（T18，已存在）、`base`（T19）、`feishu`（P1 已存在）。重复点击「启用」按钮必须幂等（retain 旧 id + push 新），不产生重复条目。

---

## 4. 约束 / 依赖 / 假设 / 开放问题

### 约束
- Rust edition 2021；TS 严格模式（tsconfig strict:true 已开启）。
- 不能修改 codex.exe 内部协议；所有能力通过 `mcp_servers.*` 与 Tauri 命令。
- 目标部署 Windows x64；开发机（当前沙盒是 Linux）仅跑单元测试与前端构建，Windows 打包交给 CI。

### 依赖
| 组件 | 用途 | 版本/来源 |
|------|------|-----------|
| `lark-openapi-mcp` | 飞书 IM/Base/审批共用 MCP（stdio）| 随包通过 PATH 或 `mcp_servers.feishu.command` 指向用户自行安装路径 |
| ChromaDB HTTP | RAG 向量库 | `pip install chromadb && chroma run --host 127.0.0.1 --port 18763` |
| tauri-apps/binary-releases | NSIS/WiX 缓存镜像 | jsdelivr 镜像兜底 + 官方回退 |
| GitHub Actions windows-latest | CI 构建 | WiX 3.14 预装路径可能变动，需脚本探测 candle.exe |

### 假设
1. 用户网络环境可访问火山方舟 / DeepSeek / OpenAI 之一，用于生成脚本与 embedding（若未配置，FR3/FR5 会在 hint 中提示配置模型提供程序）。
2. v0.5.0 的 Release 推送会使用到现有 GitHub Token（仓库 secrets 已配置）。
3. `lark-openapi-mcp` 在目标 Windows 机器已安装（或通过 `pip install lark-openapi-mcp` 可用）；Harness 自身不携带此 Python 依赖二进制。

### 开放问题（进入 Implement 前默认选择如下，用户可随时覆盖）
| # | 问题 | 默认决策 |
|---|------|----------|
| Q1 | T21 广告脚本工作流是做成 codex 内 MCP server 二进制，还是仅 Rust 结构体 + 前端模板？ | **仅 Rust 工作流定义 + 前端模板**（避免再打一个独立 exe，减小包体积）；Codex 侧通过 prompt 模板触发 MCP tool call。 |
| Q2 | RAG 入库 embedding 是否支持本地 Ollama？ | **暂不支持**（非目标），走 Chroma 内置或 Custom provider 的 embeddings endpoint。 |
| Q3 | CI Release 是否需要 draft/pre-release 标记？ | **否**，`v0.5.0` 直接正式 Release（`generate_release_notes:true`）。 |
| Q4 | SettingsPanel 顶部「知识库」tab 还是在 MCP tab 内扩展卡片？ | **MCP tab 内卡片扩展**（少改导航结构，降低回归风险）；T22 独立 tab 留作 P3。 |

---

## 5. 验收标准（Acceptance Criteria）

> 说明：`rule` 为可客观二值验证；`rubric` 为分数量化维度，有通过阈值。

### Rule（客观通过/失败）
| ID | 内容 | 证据来源 |
|----|------|----------|
| AC-R1 | `cargo test --workspace --exclude harness-app` 全部通过（0 failures） | CI / 本地命令输出 |
| AC-R2 | `cargo check -p harness-app 2>&1 \| grep -E "glib-2.0|E\["` 仅出现外部系统依赖 `Package 'glib-2.0' not found` 类错误，不出现 Rust 语法/类型/未解析符号错误 | 本地命令输出 |
| AC-R3 | `cd frontend && npx tsc --noEmit && npx vite build` exit 0 | 同上 |
| AC-R4 | `harness-rag` `chunk_markdown` 函数存在且 `#[test]` 至少覆盖 5 个场景；测试运行全通过 | `cargo test -p harness-rag -- --nocapture` |
| AC-R5 | Tauri 命令 `base_register_mcp` / `base_status` / `base_health` 与 `approval_send_to_feishu` 在 `src-tauri/src/lib.rs` invoke_handler 中注册 | `grep` 源码 + `cargo check -p harness-config harness-rag` 通过 |
| AC-R6 | SettingsPanel MCP 区新 UI（Base 健康卡 + RAG 入库区）在 `tsc` 通过的前提下，至少有 `addBase` / `addBaseViaTauri` / `checkBaseHealth` 三个前端函数存在且可在 JS bundle 中引用 | `vite build` JS 产物大小正常 + grep 源码 |
| AC-R7 | `.github/workflows/build-windows-release.yml` 含 NSIS/WiX 镜像缓存环境变量，且 `tauri build` 失败时上传 tauri-bundler 日志到 artifact | 代码检查 + workflow diff |
| AC-R8 | 版本号三处：`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`、`DEPLOY.md` What's New 版本号均为 **0.5.0** | `grep 0\\.5\\.0` 三处命中 |
| AC-R9 | 幂等性：连续两次调用 `rag_register()` / `base_register_mcp()` 返回的 `cfg.mcp_servers` 中，`id=="rag"` / `id=="base"` 条目各仅 1 条 | 集成测试（mock 文件系统） |
| AC-R10 | 脱敏：`RagError::HttpError` 与 `base_health` 错误路径中，响应字符串不包含字面 `Bearer ` / `api_key=` / `token=` 等敏感子串（由测试断言正则无命中） | `cargo test` |

### Rubric（质量维度，按 0-2 打分，阈值 ≥ 1）
| ID | 维度 | 低分锚(0) | 中分锚(1) | 高分锚(2) | 阈值 | 证据 |
|----|------|-----------|-----------|-----------|------|------|
| AC-Q1 | 工作流完成度（FR5） | T21 工作流缺失或结构错误 | 仅有工作流数据结构，无前端模板 | 工作流定义 + 前端模板 + 2 条纯函数测试通过 | ≥ 2 | `cargo test -p harness-plugins` 与前端 grep |
| AC-Q2 | 可观测性与错误提示（FR1/FR2/FR3/FR6） | 健康检查无 hint | hint 存在但部分为空或英文 | hint 全中文、给出可复制命令、覆盖失败分支 | ≥ 2 | 代码审阅 + 失败路径测试输出 |
| AC-Q3 | CI 稳定性（FR7） | 未做 NSIS/WiX 镜像，直接走官方 CDN | 仅 NSIS 镜像，无日志上传 artifact | NSIS + WiX 双镜像 + 失败日志上传 + 3 次指数退避保留 | ≥ 2 | workflow YAML 审阅 |
| AC-Q4 | 前端 UI 一致性（MCP 卡片风格） | RAG/Base 卡片风格各异 | 二者共享基础 card 样式，但颜色/状态显示不一致 | 完全共享 `.sp-mcp-health-card.ok/.bad`，ok/bad 色边一致、hint 区一致 | ≥ 1 | styles.css grep + 视觉审阅 |
