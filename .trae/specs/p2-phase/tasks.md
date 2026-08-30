# P2 阶段实施任务清单（v0.5.0）

> 关联规格：[`spec.md`](./spec.md)
> 总览：9 个任务（P1 前半为后端 crate 与 Tauri 命令，P2 后半为前端 UI 与 CI/发版）。依赖箭头：T1 → T2 → T3 → T5/T6；T4 依赖 T1；T7 与 T8 可并行；T9 压尾（发版）。

---

## Task 1: `harness-rag` 新增 chunk + embed + ingest CLI（FR3, AC-R4）

- **Status**: pending
- **Priority**: high
- **Parent AC**: AC-R1, AC-R4
- **Scope**: `/workspace/crates/harness-rag/src/lib.rs`、`/workspace/crates/harness-rag/tests/rag_tests.rs`、`/workspace/crates/harness-rag/examples/rag_cli.rs`

### 实现要点
1. `pub fn chunk_markdown(src: &str, chunk_chars: usize, overlap: usize) -> Vec<String>`（纯函数，边界正确）。
2. `impl RagClient { pub fn embed(&self, model: &str, texts: &[String]) -> Result<Vec<Vec<f32>>, RagError> }`（走 Chroma `/api/v1/embeddings` HTTP POST）。
3. `rag_cli.rs` clap 子命令 `ingest <collection> <file> [--chunk 800] [--overlap 120] [--model <name>]`。

### 本地测试要求（TR 均为 rule，全部必跑 RED→GREEN）
| TR-ID | 类型 | 内容 | 证据 |
|-------|------|------|------|
| T1-R1 | rule | 空串 `chunk_markdown("", 800, 120)` 返回 `[]` | `cargo test` |
| T1-R2 | rule | 短文本 `len < chunk_chars` 返回 1 段，内容完整 | 同上 |
| T1-R3 | rule | 典型 3000 字 Markdown，chunk=800, overlap=120 → 返回段数 ≥ `ceil((3000-120)/(800-120))`，且首/尾含原文首尾句子 | 同上 |
| T1-R4 | rule | overlap ≥ chunk_chars 时：返回 Err 或 panic-free 的合理处理（任选其一，文档化） | 同上 |
| T1-R5 | rule | `embed` 发 `/api/v1/embeddings` POST，mock server 返回含 `embeddings:[[...]]` 时解析 OK | mock HTTP（同 rag_tests.rs 模式） |
| T1-R6 | rule | 脱敏：`embed` 失败时错误字符串不含 `Authorization:` / `Bearer ` / `api_key=` | `cargo test` 断言正则 |

---

## Task 2: `harness-plugins` 新增 `AdScriptWorkflow`（FR5, AC-Q1）

- **Status**: pending
- **Priority**: high
- **Depends on**: T1
- **Parent AC**: AC-Q1
- **Scope**: `/workspace/crates/harness-plugins/src/ad_script_workflow.rs`（新建）、`/workspace/crates/harness-plugins/Cargo.toml`、`/workspace/crates/harness-plugins/tests/`

### 实现要点
1. 枚举 `StepTool { RagSearch, LlmGenerate, BaseInsert, FeishuApprovalSubmit }`。
2. 结构体 `Step { id: usize, name: &'static str, tool: StepTool, payload: serde_json::Value }`。
3. `impl AdScriptWorkflow { pub fn run(brief: &str) -> Vec<Step> }`：
   - Step1 `rag.search("品牌话术,竞品分析")`；
   - Step2 `llm.generate("脚本草案")`；
   - Step3 `llm.generate("脚本修订版")`（基于 Step2）；
   - Step4 `base.insert("脚本表")`；
   - Step5 `feishu_approval.submit("审批")`。
4. 纯数据不发网络，便于测试。

### 本地测试要求
| TR-ID | 类型 | 内容 | 证据 |
|-------|------|------|------|
| T2-R1 | rule | 任意非空 brief 返回 steps.len() == 5 | `cargo test` |
| T2-R2 | rule | steps[0].tool == RagSearch，steps[3].tool == BaseInsert，steps[4].tool == FeishuApprovalSubmit | 同上 |
| T2-R3 | rule | 空 brief 仍返回 5 步（不 panic），payload 中带 original_brief 字段 | 同上 |
| T2-R4 | rule | brief 中包含 `["快手"]` 品牌关键词时，Step1 payload 的 query 包含该关键词（简单关键词提取规则即可） | 同上 |

---

## Task 3: Tauri 新增 `base_*` 三命令 + `approval_send_to_feishu`（FR2 / FR6, AC-R5, AC-R9）

- **Status**: pending
- **Priority**: high
- **Depends on**: T1
- **Parent AC**: AC-R5, AC-R9, AC-R10
- **Scope**: `src-tauri/src/base.rs`（新建）、`src-tauri/src/approval_feishu.rs`（新建）、`src-tauri/src/lib.rs` invoke_handler 注册、`crates/harness-config` 中若需要追加 McpServerConfig helper 可不改（复用现有）。

### 实现要点
1. `base_register_mcp(codex_home, app_token?, env_vars?) -> McpServerConfig`：
   - id="base"、command="lark-openapi-mcp"、args=`["--mode=stdio","--enable-bitable"]`、env_vars=`["FEISHU_USER_ACCESS_TOKEN","FEISHU_APP_ID","FEISHU_APP_SECRET"]`。
   - 幂等：retain 旧 `id=="base"` 再 push。
2. `base_status(codex_home) -> { registered, enabled, appTokenHint }`：
   - `appTokenHint` 若 env_vars 含 FEISHU_APP_ID 则返回 "已声明 FEISHU_APP_ID 透传"，否则 "未声明，请在 lark-cli 配置或 SettingsPanel 中启用"。
3. `base_health(app_token?) -> { ok, message, hint }`：
   - HTTP GET `https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal` 空请求判断可达性（不一定拿到 200，但能解析响应即可），失败 hint 给 `lark-cli auth login` + `lark-openapi-mcp --help` 中文。
4. `approval_send_to_feishu(approval_id, summary, approver_open_ids, dept_id?, form_data?)`：
   - 封装一次 HTTP POST 到审批定义创建实例的端点（mock server 写测试即可）；返回 `{ approvalCode, instanceCode, link }`，link=`https://applink.feishu.cn/client/approval/detail?instance_code={instanceCode}`。
   - 错误路径脱敏。

### 本地测试要求
| TR-ID | 类型 | 内容 | 证据 |
|-------|------|------|------|
| T3-R1 | rule | `base_register_mcp` 连调两次后，config 中 `id=="base"` 仅 1 条（用临时文件作为 codex_home 集成测试） | `cargo test -p harness-app --lib`？No，用 `harness-config tests/config_tests.rs` 追加或建 `src-tauri/tests/` |
| T3-R2 | rule | `base_health` mock server 返回 5xx 时，error hint 中文且返回体中无 `token=...` 长串（脱敏） | mock TCP |
| T3-R3 | rule | `approval_send_to_feishu` mock 返回 `{data:{instance_code:"X"}}` 时能解析出 `link` 含该 code | 同上 |
| T3-R4 | rule | `invoke_handler` 注册：`grep` lib.rs 命中 4 个新增命令名 | 源码 grep |

---

## Task 4: 前端 `codexClient.ts` 追加 base + approval 客户端；SettingsPanel MCP 卡片补齐（FR1/FR6, AC-R6, AC-Q4）

- **Status**: pending
- **Priority**: high
- **Depends on**: T3
- **Parent AC**: AC-R3, AC-R6, AC-Q4

### 实现要点
1. `codexClient.ts`：
   - `baseRegisterMcp({ codexHome, appToken?, envVars? })` → `McpServerConfig`。
   - `baseStatus(codexHome)` → `{ registered, enabled, appTokenHint }`。
   - `baseHealth(appToken?)` → `{ ok, message, hint }`。
   - `approvalSendToFeishu({ approvalId, summary, approverOpenIds, deptId?, formData? })` → `{ approvalCode, instanceCode, link }`。
2. `SettingsPanel.tsx` SectionMcp：
   - 新增按钮：`+ 启用飞书多维表格 MCP（内存配置）` + `✓ 立即写入并启用飞书多维表格（推荐）`。
   - 当 `mcpServers.some(m.id=="base")` 显示 Base 健康卡（复用 `.sp-mcp-health-card.ok/.bad` 样式，保证同 RAG 视觉一致），卡内含：base 状态圆点、`appTokenHint`、hint 预代码块、「重新检查」按钮。
3. ApprovalPanel.tsx：
   - 每条 Approval 在按钮区下方新增 1 行操作：`[🔗 发起飞书审批]` 按钮 + 结果显示区 `飞书审批已创建 · 实例 xxxx · 链接 a 标签`。

### 本地测试要求
| TR-ID | 类型 | 内容 | 证据 |
|-------|------|------|------|
| T4-R1 | rule | `tsc --noEmit` exit 0 | 命令 |
| T4-R2 | rule | SettingsPanel 源码中存在 `addBase`、`addBaseViaTauri`、`checkBaseHealth` 三函数 | grep |
| T4-R3 | rule | ApprovalPanel 源码中存在 `approvalSendToFeishu` 调用且 props 新增可选字段（若组件 props 扩） | grep |
| T4-R4 | rule | Base 健康卡与 RAG 健康卡均使用 `.sp-mcp-health-card` 类，且 ok/bad 两个修饰类都存在引用 | `grep -E "sp-mcp-health-card(\\.ok|\\.bad)?" styles.css + SettingsPanel.tsx` |
| T4-Q4 | rubric | AC-Q4 UI 一致性：0/1/2 档按 spec 打分，阈值 ≥ 1 | 人工审阅样式对照 |

---

## Task 5: 前端 知识库入库 UI（MCP 区扩展卡片，FR4）

- **Status**: pending
- **Priority**: medium
- **Depends on**: T4
- **Parent AC**: AC-R6

### 实现要点
1. SettingsPanel MCP 区的 RAG 健康卡下方追加分区「索引与检索」：
   - 「选择 MD 文件」按钮 `<input type=file accept=".md,.txt" />` + 导入按钮；
   - 导入进度条（纯前端状态：上传 chunk 编号 / 总 chunk 数）；
   - 「检索测试」输入框 + 结果列表（命中 doc、distance、集合名）。
2. 后端调用：`codex.ragRegister` 已存在；`RagClient.search` 未直接暴露 Tauri 命令。为此，**在 rag.rs 追加 `rag_search(codex_home?, base_url?, collection?, query, topK=5)`** Tauri 命令（T3 在后端已完成注册，本任务仅调用方在前端实现）。

### 本地测试要求
| TR-ID | 类型 | 内容 | 证据 |
|-------|------|------|------|
| T5-R1 | rule | `rag_search` 已注册进 invoke_handler | grep |
| T5-R2 | rule | 前端 `tsc --noEmit` 仍 exit 0 | 命令 |
| T5-R3 | rule | MCP 页面中出现「索引与检索」分区（DOM 中含对应按钮文字） | 代码结构审阅 |

---

## Task 6: 前端 左侧「广告脚本生成」模板 + 后端工作流接入（FR5, T2 工作流渲染）

- **Status**: pending
- **Priority**: medium
- **Depends on**: T2, T4
- **Parent AC**: AC-Q1

### 实现要点
1. App.tsx 的「新建任务 / 模板」菜单中新增条目：「🎬 广告脚本生成（T21 工作流）」。
2. 选中后，自动在 composer textarea 里填入如下前缀（用户可继续补充 brief）：
   ```
   【广告脚本生成 · 工作流模板】请按以下 5 步执行：
   1. rag.search("品牌话术 + 竞品分析 + 历史脚本案例")
   2. llm.generate("脚本草案 · 3 条")
   3. llm.generate("脚本修订版 · 选 1 条精修")
   4. base.insert("脚本表", { title, script, brief })
   5. feishu_approval.submit("广告脚本审批", approvers=...)
   
   本次 brief：
   ```
3. 若未来需要工作流结构体校验，可选追加：点击发送时用 React 常量存储 5 步结构（不作强制）。

### 本地测试要求
| TR-ID | 类型 | 内容 | 证据 |
|-------|------|------|------|
| T6-R1 | rule | App.tsx 中存在「广告脚本生成」字符串 | grep |
| T6-R2 | rule | 模板字符串中 5 步齐全（含 `rag.search`、`base.insert`、`feishu_approval.submit` 字样） | grep |
| T6-R3 | rule | `tsc --noEmit` + `vite build` 不报错 | 命令 |

---

## Task 7: CI Release 稳定化 + 版本升到 0.5.0（FR7 / AC-R7 / AC-R8）

- **Status**: pending
- **Priority**: high
- **Parent AC**: AC-R7, AC-R8, AC-Q3

### 实现要点
1. `build-windows-release.yml`：
   - Step「镜像下载 NSIS/WiX 缓存」插入在「安装 tauri-cli」之前：分别从 `$Env:NSIS_MIRROR`（默认 jsdelivr）和 `$Env:WIX_MIRROR` 下载，解压到 `$env:LOCALAPPDATA\tauri-bundler\cache`；设置 `$env:TAURI_NSIS_PATH` 和 `$env:WIX` 指向对应目录。
   - `tauri build` 每次失败后，`Get-ChildItem $env:TEMP\tauri-bundler*.log` 上传 artifact（name=tauri-logs）。
2. 版本号变更：
   - `src-tauri/Cargo.toml` version 0.4.0 → 0.5.0。
   - `src-tauri/tauri.conf.json` version 0.4.0 → 0.5.0。
   - `frontend/package.json` version 0.3.0 → 0.5.0（可选，若已有）。
   - `DEPLOY.md` 顶部 〇、What's New 新增 v0.5.0 条目：T19 Base MCP、T20 RAG Ingest、T21 AdScript 模板、T22 审批直连飞书、CI 稳定化。

### 本地测试要求
| TR-ID | 类型 | 内容 | 证据 |
|-------|------|------|------|
| T7-R1 | rule | workflow yaml 中字符串 `TAURI_NSIS_PATH` 和 `WIX` 都命中 | grep |
| T7-R2 | rule | tauri build 失败后 upload-artifact tauri-logs 存在于 workflow | grep workflow yaml |
| T7-R3 | rule | 三处 0.5.0 版本号 grep 命中：Cargo.toml / tauri.conf.json / DEPLOY.md | grep `0\.5\.0` |
| T7-Q3 | rubric | AC-Q3 CI 稳定性打分：0/1/2，阈值 ≥ 2 | workflow yaml 审阅 |

---

## Task 8: 全量回归 + 打包 smoke（AC-R1, AC-R2, AC-R3, 汇总所有 TR）

- **Status**: pending
- **Priority**: high
- **Depends on**: T1–T7 全部 completed
- **Parent AC**: 所有 AC

### 命令（必跑，Implement 最后执行）
1. `cargo test --workspace --exclude harness-app -- --nocapture`
2. `cargo check -p harness-app 2>&1 | tail -30`（检查仅 glib-2.0 外部依赖失败，不产生 Rust 错误）
3. `cd frontend && npx tsc --noEmit && npx vite build`
4. `cargo test -p harness-plugins`（确保 T2 工作流测试）

### 本地测试要求
| TR-ID | 类型 | 内容 | 证据 |
|-------|------|------|------|
| T8-R1 | rule | 所有 crate tests 0 failures | 命令 |
| T8-R2 | rule | harness-app check 失败原因仅是 `glib-2.0` 系统依赖 | grep 输出 |
| T8-R3 | rule | tsc + vite exit 0 且 JS ≤ 350 KB（gzip ≤ 120KB），CSS ≤ 60 KB | vite build 汇总表 |

---

## Task 9: 打 tag 触发 CI 并创建 Release（最终交付）

- **Status**: pending
- **Priority**: high
- **Depends on**: T8 completed
- **Parent AC**: 规格 §1「目标产物」

### 步骤
1. 在仓库根执行 `git tag v0.5.0 && git push origin v0.5.0`（由用户或外部环境执行；沙盒里可尝试 dry-run，实际 push 视权限）。
2. 观察 GitHub Actions workflow `build-windows-release.yml`。
3. 检查 Release 页：`https://github.com/windyisland-aiot/codex-harness-app/releases/tag/v0.5.0` 至少 2 个资产：MSI 与 NSIS EXE。
4. 若权限不足无法真实 push/tag，本 Task 退化为：**本地验证 workflow yaml 语法** + **版本号正确** + **所有测试通过**，并在 `release-notes-draft.md` 内写 v0.5.0 Notes（不提交）。

### 本地测试要求
| TR-ID | 类型 | 内容 | 证据 |
|-------|------|------|------|
| T9-R1 | rule | `git tag v0.5.0 -n`（如允许）或 `grep v0.5.0 build-windows-release.yml tag matching pattern` valid | 命令 / yaml 结构 |
| T9-R2 | rule | Release action step `softprops/action-gh-release@v2` present | grep workflow yaml |
| T9-R3 | rule | 产物体积合理性：vite build 大小 + 构建经验显示 MSI ≤ 150MB（实际由 CI 产出，不在本地验证）；至少 workflow 中 upload-artifact + gh-release files 正确指向 bundle/** | 代码审阅 |
