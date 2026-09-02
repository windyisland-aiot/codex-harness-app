# T18 · 知识库 RAG MCP Server 实施计划

> 对应 TASKS.md P2 · T18：知识库 RAG MCP Server（LlamaIndex/LangChain + ChromaDB/Qdrant，暴露 search/index 工具）。
> 本步骤是 P2 阶段第一个落地点，同时为"① 广告脚本生成项目并入"与"T22 知识库管理界面"提供底层基础设施。

## 一、仓库调研结论

1. **MCP 扩展通道已打通**：`harness-config` 的 `McpServerConfig`（id/command/args/env/env_vars/enabled）
   已支持 TOML `[mcp_servers.<id>]` 的完整读写（见
   [model.rs](file:///workspace/crates/harness-config/src/model.rs#L55-L71)、
   [lib.rs](file:///workspace/crates/harness-config/src/lib.rs#L392-L429)）。feishu、tavily 等都是按这个模式
   接入，因此 T18 新增一个 `mcp_servers.rag` 即可，**无需修改底座解析逻辑**。

2. **前端设置面板已有 MCP Section**：SettingsPanel 的 `SectionMcp`
   （[SettingsPanel.tsx](file:///workspace/frontend/src/components/SettingsPanel.tsx#L576-L608)）支持列表式
   注册/删除，并已有 `+ 注册飞书 MCP` 按钮作为快速注册入口。只需在此处追加一个
   "+ 启用内置知识库 RAG"一键按钮 + 必要参数（chroma 端口、collection 默认名、embedding
   模型名），零新页面。

3. **现有 search 模板可借鉴**：`crates/harness-search` 已经实现
   `SearchMcpConfig::build() -> (id,command,args,env,env_vars)` 模式，外加 `validate()`。
   T18 应照抄该模式新增 `crates/harness-rag` crate，保持与 T15 一致的接口风格。

4. **Codex 工具调用链路已验证**：codex stdio 子进程拉起 MCP 后，会把 MCP 暴露的 tools 自动注入
   tool list，Agent 可直接调。审批弹窗（刚改成图一样式）会在 RAG 触发"导入本地
   文档→读取文件"时按需弹框，无需为 RAG 单独新增审批类型。

5. **Windows 目标平台约束**：体积、启动速度、无后台 console 是硬要求。
   因此 T18 MVP 选择 **Rust 内嵌 SQLite + FTS5 + 纯 Rust 向量 HNSW（`tantivy`/`voile`暂不选，先 `chromadb` HTTP client）** 的折中方案：
   Chroma 以独立子进程 `chroma run --host 127.0.0.1 --port 18763` 启动（Tauri 负责健康检查 + 拉起），
   Harness 侧用 `ureq` 走 HTTP，与现有 harness-search 的客户端写法完全一致，**无 Python/Runtime 依赖**，
   等广告脚本项目接入时再决定是否要 Python LangChain 层。

## 二、文件与模块变更清单

| 位置 | 变更类型 | 说明 |
|---|---|---|
| `crates/harness-rag/`（新建） | crate | 核心：RagClient(HTTP) + RagMcpConfig(生成 mcp_servers.rag 配置) + 测试。加入 `Cargo.toml` workspace members。 |
| `crates/harness-rag/Cargo.toml` | 新建 | dependencies: serde, serde_json, ureq; dev-deps 同 harness-search。 |
| `crates/harness-rag/src/lib.rs` | 新建 | pub RagCollection / RagDocument / RagSearchResult / RagClient（chroma HTTP）；pub `RagMcpConfig::build()` + `validate()`。 |
| `crates/harness-rag/examples/rag_cli.rs` | 新建 | 类似 `search_cli.rs`：`--base-url --collection --index "<text>" --search "<q>"`，手动 smoke。 |
| `crates/harness-rag/tests/rag_tests.rs` | 新建 | 同 harness-search 风格：用 TCP mock server 测 list_collections / add / query / upsert / delete。 |
| `Cargo.toml`（workspace） | 编辑 | members 追加 `crates/harness-rag`。 |
| `src-tauri/Cargo.toml` | 编辑 | dependencies 追加 `harness-rag = { path = "../crates/harness-rag" }`。 |
| `src-tauri/src/lib.rs` / `src-tauri/src/rag.rs`（新） | 新建 + 编辑 | Tauri commands: `rag_register(base_url, collection, env)` → 写入 `mcp_servers.rag`；`rag_status()` → 回读；`rag_health(base_url)` → `GET /api/v1/heartbeat` 一次。 |
| `frontend/src/components/SettingsPanel.tsx` | 编辑 | `SectionMcp` 里追加 1 个按钮："+ 启用内置知识库 RAG（chroma:18763）" → 调用新 tauri cmd；列表里显示 `rag` 条目（复用现有 sp-mcp-row 样式）。 |
| `frontend/src/App.tsx` / `codexClient.ts` | 编辑（可选） | 如有前端侧"检索测试"功能（T22 的前置），增加一个调用 rag_search 的 tauri command 代理；MVP 可留空。 |
| `config/openai/config.toml` | 编辑（可选） | 如要在默认配置里启用 RAG，追加 `[mcp_servers.rag]` 模板注释块。MVP 默认关闭。 |

## 三、依赖顺序实施步骤

1. **骨架搭建**
   - 新建 `crates/harness-rag`：`Cargo.toml` + `src/lib.rs`（定义 Collection/Document/SearchResult
     三个结构 + RagClient 空 impl）。
   - 更新 workspace `Cargo.toml`、`src-tauri/Cargo.toml`，确保 `cargo check -p harness-rag` 过。

2. **RagClient：Chroma HTTP 薄封装**
   Chroma v0.5.x API 用得最多的 6 条端点，对应 6 个方法：
   | 方法 | 端点 | 作用 |
   |---|---|---|
   | `health()` | `GET /api/v1/heartbeat` | 检查 chroma 存活 |
   | `list_collections()` | `GET /api/v1/collections` | 列出集合（默认集合名 `harness_default`） |
   | `get_or_create_collection(name)` | `POST /api/v1/collections` + `get_or_create=true` | 获取或建集合 |
   | `add_documents(coll_id, docs[])` | `POST /api/v1/collections/{id}/add` | 批量 upsert（带 id + metadata） |
   | `search(coll_id, query, n_results, where?)` | `POST /api/v1/collections/{id}/query` | 向量检索，回 docs + distance + metadata |
   | `delete(coll_id, ids[])` | `POST /api/v1/collections/{id}/delete` | 按 ids 删文档 |
   - Embedding：**MVP 第一期走 `chromadb` 自带的默认 all-MiniLM-L6-v2（chroma 服务端内部算，不传到 Harness）**。
     这样 Harness 侧不依赖任何 ONNX/模型文件，体积最小。后续第二期再加
     `X-Chroma-Token`/外部嵌入 endpoint 参数。
   - 错误类型 `RagError`：`MissingBaseUrl` / `Transport` / `Http(u16,String)` / `Parse(String)`。
   - 同步实现（和 SearchClient 一样用 `ureq` blocking），Tauri 侧调用时包一层 `spawn_blocking`。

3. **RagMcpConfig：一键 mcp_servers.rag 配置生成器**
   ```rust
   pub struct RagMcpConfig {
     pub id: String,          // "rag"
     pub command: String,     // 实际 MCP server 二进制名（harness-rag-server 或 py 启动）
     pub args: Vec<String>,   // ["--base-url", "http://127.0.0.1:18763", "--default-collection", "harness_default"]
     pub env: Vec<String>,    // 暂空（key 不用写死）
     pub env_vars: Vec<String>, // 如 CHROMA_SERVER_AUTHN_CREDENTIALS，透传
   }
   ```
   - MVP 第一期**MCP server 的实际可执行文件：用本仓库 `crates/harness-rag/src/bin/rag_mcp_stdio.rs` 新
     建一个 stdio 协议的 MCP shell**。它内部调 RagClient，暴露 4 个 tools：
     - `rag_index_documents(collection?, documents:[{id,text,metadata}])`
     - `rag_search(collection?, query, n_results=5)`
     - `rag_list_collections()`
     - `rag_delete_documents(collection?, ids[])`
   - 这样 codex -> MCP stdio -> Rust RagClient -> Chroma HTTP -> 嵌向量库。链路全是二进制 +
     stdio/HTTP，**零 Python 依赖**，Windows 下好打包。
   - RagMcpConfig 的 `command` 默认写相对路径 `"./harness-rag-mcp${EXE_EXT}"`，打包时随 MSI 放在
     `C:\Program Files\Harness\resources\` 下；开发态通过 args 传路径。

4. **Tauri 命令 + 集成到 codex 拉起流程**
   - 新建 `src-tauri/src/rag.rs` 并在 `lib.rs` 里 `mod rag; pub use rag::*;`，`#[tauri::command]` 导出：
     - `rag_register(codex_home, base_url, collection, env_vars[])`：内部走
       `harness_config::read` -> `retain(|m| m.id!="rag")` -> `push(RagMcpConfig::build(..).into_mcp())` -> `write`。
     - `rag_status(codex_home)`：回读是否已注册、enabled、chroma base_url。
     - `rag_health(base_url)` -> `RagClient::new().health()`。
   - **codex 子进程拉起时是否额外启动 chroma？** MVP 采用"按需（注册 rag 后）启动 + 进程守护"：
     在 `appserver.rs`（或 tauri setup hook 里的 `AppServerHandle`）增加一个 task：如果
     `mcp_servers.rag` 存在且 enabled，则用 `std::process::Command` 启动
     `chroma run --host 127.0.0.1 --port 18763`（已安装前提下），
     并用 `CREATE_NO_WINDOW=0x08000000` 隐藏窗口（复用 v0.2.1 T32 的经验）。
     **如用户未装 chroma，MCP 工具调用时返回清晰错误文案并给出安装命令，不阻塞其它功能。**

5. **前端 MCP Section 增强**
   - 在 SettingsPanel 的 `SectionMcp` 顶部，飞书按钮下方增加：
     ```tsx
     <button className="sp-btn sp-btn-ghost" onClick={addRag}>+ 启用内置知识库 RAG（Chroma 18763）</button>
     ```
   - `addRag` 逻辑：调 `invoke("rag_register", {...})` 成功后 refreshConfig()，列表出现 rag 行。
   - 在 rag 行内加 "健康检查" 次级按钮，调用 `rag_health` 显示绿色 "Chroma OK" 或红色 "未启动" 提示。

6. **测试 + 文档**
   - `rag_tests.rs`：mock TCP server 覆盖 6 条端点的解析；至少 4 个用例（health_ok、
     list_two_collections、add_then_query_ok、query_missing_coll_returns_http_error）。
   - `rag_cli.rs`：一条 4 step CLI 流水线（list → add → search → delete），手动 smoke。
   - 在 `README.md` 末尾 "## RAG (T18)" 段追加 10 行：默认集合名、chroma 安装命令
     （`pip install chromadb && chroma run --host 127.0.0.1 --port 18763`）、MCP 工具名列表。

## 四、依赖和注意事项

1. **Chroma 安装责任边界**：Chroma 属第三方 Python 服务，**不随 MSI 打包**（体积 + license 风险），
   在 README 和 rag_health 错误里给出安装指引。后续 P2 T22 管理界面可加"一键下载/安装"按钮
   （Tauri shell + pip install chromadb --user）。

2. **Codex MCP 工具命名冲突**：工具名统一加 `rag_` 前缀，不与 tavily 的 `web_search` /
   feishu 的 `feishu_*` 冲突，Skill 指令不会混淆。

3. **Windows ANSI/路径**：MCP stdio 文本协议一律 UTF-8；chroma `--path` 默认落在
   `%LOCALAPPDATA%/Harness/chroma-data/`（由 tauri 启动时注入 `CHROMA_PERSIST_DIRECTORY`），
   避免中文用户名路径问题。

4. **与后续需求①广告脚本项目兼容**：RagClient.metadata 结构留成任意 `Map<String, Value>`，
   广告脚本的"行业/品牌/时长/场景/旁白"等 schema 直接写进 metadata 的 where 条件即可，不
   需要改底层。

5. **T19（飞书 Wiki 增量索引）的预留位**：RagClient 的 `add_documents` 接口里 metadata 会有
   `source_type = "feishu_wiki" | "bitable" | "file_upload"` 等字段的位置。后续接 T19
   不破坏结构。

## 五、验证清单（做完必须全部通过）

1. Rust 编译与单测：
   ```
   cargo check -p harness-rag -p harness-app --quiet
   cargo test -p harness-rag -- --nocapture
   cargo test -p harness-config -p harness-router -p harness-sessions （保持不回归）
   ```
2. 前端：
   ```
   cd frontend && npx tsc --noEmit && npx vite build
   ```
3. 手动 smoke：
   - 启动 `chroma run --port 18763`；
   - 在 SettingsPanel 点"+ 启用内置知识库 RAG"，列表出现 rag 行 + 健康检查 "OK"；
   - 打开 codex 会话，问："帮我导入一段文本'xxx'进知识库，然后检索'yyy'"，观察 MCP 工具被正确触发。

## 六、风险与处置

| 风险 | 等级 | 处置 |
|---|---|---|
| Chroma 用户侧没装，功能不可用 | 中 | 健康检查给出明确错误 + 安装命令；MCP 调用失败不阻塞其它对话。 |
| Chroma 默认 embedding 模型体积大（~100MB，首次下载） | 低 | 文档注明首次 `chroma run` 会下载 miniLM；若带宽差，提示用 `CHROMA_EMBEDDING_FUNCTION=none` 或切换自定义 endpoint。 |
| MCP stdio 协议细节（tools list / call 结构）与 codex 不匹配 | 中 | 先写 rag_cli 手动对，再按 codex 的 MCP 文档对齐 JSON-RPC；必要时在集成测试（黑盒）里把 harness-rag-mcp 作为子进程发一条 `tools/list` 断言回包。 |
| Windows 非 ASCII 用户名导致 chroma data 路径写失败 | 低 | 强制用 `%LOCALAPPDATA%/Harness/chroma-data/` 并在启动前创建目录；metadata 做 UTF-8 BOM 剥离。 |
