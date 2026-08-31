# Harness 企业内部 Agent — 部署文档

> 版本：v0.5.1（P2 阶段 · RAG + Bitable + 广告脚本多 Agent + 飞书审批直连）（测试发布）
> 目标平台：Windows 10 / Windows 11 x64
> 源码仓库：`windyisland-aiot/codex-harness-app`（私有）

---

## 〇、v0.5.1 版更新要点（What's New）

本版本是**企业内多 Agent 协同（广告脚本生成）能力落地**的里程碑测试发布，同时把知识库 RAG、飞书多维表格（Base/Bitable）、飞书审批直连 3 条关键数据链路从后端贯通到前端 UI。

| 分类 | 变更内容 | 对应计划项 |
|------|----------|------------|
| 📚 知识库 RAG | 新增 `crates/harness-rag`：Chroma HTTP 客户端、`chunk_markdown`、`embed`、`RagMcpConfig`；14 条 RED→GREEN 集成测试 | T18 / P2-T1 |
| 📚 知识库 RAG | Tauri 命令：`rag_register` / `rag_status` / `rag_health` / `rag_search`；脱敏 + 幂等写入 config.toml | T18 / P2-T3 |
| 📚 知识库 RAG | 设置面板 MCP tab：+ 启用 RAG 按钮、Chroma 健康卡、入库分块预览 + 检索测试框（top-k / query / 结果列表） | T20 / P2-T5 |
| 🗂️ 飞书多维表格 | Tauri 命令：`base_register_mcp` / `base_status` / `base_health`；默认命令 `lark-openapi-mcp --mode=stdio --enable-bitable` | T19 / P2-T3 |
| 🗂️ 飞书多维表格 | 设置面板 MCP tab：+ 启用 Base 按钮、健康卡（校验 `FEISHU_*` 3 个 env 存在） | T19 / P2-T4 |
| 🎬 广告脚本多 Agent | 新增 `harness-plugins::ad_script::AdScriptWorkflow`：5 步编排 `RagSearch → LlmGenerate(×2) → BaseInsert → FeishuApprovalSubmit`，4 条用例含关键词断言 | T21 / P2-T2 |
| 🎬 广告脚本多 Agent | 左栏模板库：点「模板库」弹出广告脚本 5 步模板，一键填入输入框；同时附带周报模板 | T21 / P2-T6 |
| 📨 飞书审批直连 | Tauri 命令：`approval_send_to_feishu`；HTTP 返回脱敏不泄漏 token；instance_code + applink 生成 | T22 / P2-T3 |
| 📨 飞书审批直连 | 审批面板每张卡片加「提交至飞书审批」按钮 → 提单 loading/ok/error 状态 + 飞书打开链接 | T22 / P2-T4 |
| 📦 打包 & CI | 版本号统一升到 0.5.0（Cargo.toml / tauri.conf.json / 设置面板头部 & 关于页） | P2-T7 |
| 📦 打包 & CI | workflow 新增：`actions/cache@v4` 缓存 `%LOCALAPPDATA%\tauri-bundler`（NSIS/WiX 二次下载抗 504）；Tee-Object 记录每次 attempt 日志 | P2-T7 |
| 📦 打包 & CI | workflow 新增：构建结束 always() 收集 attempt 日志 + target/*.log + bundler-cache.txt，上传独立 artifact `Harness-BuildLogs-<ver>` | P2-T7 |
| 🧪 测试 | `cargo test --workspace --exclude harness-app` 全通过；tsc + vite build 全通过；glib 失败仅影响非目标 Linux | P2-T8 |

---

## 〇-1、v0.2.0 版更新要点（历史 What's New · Trae Work 风格 UI 重构）

本版本是**界面与交互重构的里程碑版本**，整体风格向 Trae Work 对齐，同时修复 P0 级的 LLM 调用故障。

| 分类 | 变更内容 | 对应计划项 |
|------|----------|------------|
| 🎨 UI 重构 | 顶栏改为 TraeWork 风格（拖拽区 / 搜索 / 编辑·帮助菜单 / 窗口三键） | T26 |
| 🎨 UI 重构 | 左侧栏改为 Work / Code / Design 三段 Pill + 新建任务 / 插件市场 / 模板库 / 自动化 / 办公助理 + 任务列表 | T25 / T31 |
| 🎨 UI 重构 | 单发送按钮（移除 Work / Code 双按钮），移除审批 / 终端 / 浏览器 / 画布 / 快捷键 / 自动路由等杂项勾选框 | T27 / T29 |
| 🎨 UI 重构 | 移除右侧会话详情面板；空白态统一为「新建任务」引导 | T30 |
| 🎨 UI 重构 | 小窗口拉伸布局修复（min-width/min-height 降到 720×520 + flex 容器最小尺寸约束） | T28 |
| 🤖 模型 | 输入框内嵌「提供商 + 模型」下拉切换；预设火山方舟 / DeepSeek / 智谱 GLM / 豆包 / Qwen / Claude / Moonshot / Doubao / OpenAI | T10 增强 |
| 🤖 模型 | **修复 io writer closed**：Ark 网关 SSE 改为边读边写（chunked streaming）、写超时 600s、BrokenPipe 归一化、上游错误消息脱敏（不泄漏 key） | P0 / T07 补注 |
| ✍️ 消息渲染 | AI 消息 Markdown 加固：表格 / 引用 / 列表 / 代码块样式；代码块一键复制按钮；DOMPurify 防 XSS | T19 增强 / CR-4 |
| 🔐 安全 | tauri.conf.json 启用正式 CSP（不再为 null）；覆盖 script/style/img/connect/media/font/worker 协议源 | CR-2 |
| 📦 打包 | 版本号统一提升到 0.2.0；前端生产产物 266 KB JS（gzip 86 KB）+ 27 KB CSS（gzip 6 KB） | T17 |

---

## 一、快速开始（普通用户）

### 1.1 环境要求

| 项目 | 最低要求 | 推荐 |
|------|----------|------|
| 操作系统 | Windows 10 x64 (21H2+) | Windows 11 x64 23H2+ |
| 内存 | 4 GB | 8 GB |
| 磁盘空间 | 200 MB（程序本体） + 2 GB（WebView2 / 模型上下文缓存） | 5 GB 可用 |
| 网络 | 能访问模型 API 端点 + 飞书开放平台 + Tavily/Serper | 稳定的企业网络出口 |
| WebView2 Runtime | Windows 10 21H2+ 自带；首次启动安装包会自动在线下载引导安装 | ≥ 120.0.2210.121 |

### 1.2 下载并安装

从 GitHub Release 页面下载安装包，二选一即可：

| 格式 | 下载链接 | 体积 | 适用场景 |
|------|----------|------|----------|
| MSI | [Harness_0.5.1_x64_en-US.msi](https://github.com/windyisland-aiot/codex-harness-app/releases/download/v0.5.1/Harness_0.5.1_x64_en-US.msi) | ≈ 6 MB | 企业 IT 批量部署、组策略管理 |
| NSIS (EXE) | [Harness_0.5.1_x64-setup.exe](https://github.com/windyisland-aiot/codex-harness-app/releases/download/v0.5.1/Harness_0.5.1_x64-setup.exe) | ≈ 4.5 MB | 个人开发者本地双击安装 |

安装步骤：
1. 双击安装包（如被 SmartScreen 拦截，点「更多信息」→「仍要运行」）。
2. 按向导选择安装路径（默认 `C:\Program Files\Harness`，单用户模式时为 `%LOCALAPPDATA%\Programs\Harness`）。
3. 首次启动若系统缺少 WebView2 Runtime，安装包会静默下载并安装（需联网）。
4. 桌面与开始菜单会创建快捷方式，双击启动。

### 1.3 卸载

- 方式 A：「设置 → 应用 → 已安装的应用 → Harness → 卸载」
- 方式 B：`C:\Program Files\Harness\uninstall.exe`（NSIS 安装）或 MSI 原文件右键「卸载」。
- 卸载后用户数据（会话 SQLite、配置、口令库）默认保留，路径见「四、数据目录」。若需彻底删除，手动删除对应目录。

---

## 二、从源码构建（开发者/CI）

### 2.1 工具链（Windows）

```powershell
# 1. 安装 WebView2（Win10 通常已有）
winget install Microsoft.WebView2.Runtime

# 2. 安装 Rust（稳定版）
# 从 https://rustup.rs/ 下载 rustup-init.exe 或：
winget install Rustlang.Rustup
rustup toolchain install stable
rustup default stable
rustup component add rustfmt clippy

# 3. 安装 MSVC Build Tools（已安装 Visual Studio 可跳过）
winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

# 4. 安装 Node 20 LTS
winget install OpenJS.NodeJS.LTS   # 或 20.x
node -v  # 应输出 ≥ v20
npm  -v

# 5. WiX Toolset v3（MSI 打包用）—— 可选，tauri bundler 会自动下载
choco install wixtoolset   # 或从 https://wixtoolset.org/releases/v3.14/
```

### 2.2 获取源码 & 构建

```powershell
git clone https://github.com/windyisland-aiot/codex-harness-app.git
cd codex-harness-app

# 前端依赖 + 构建
cd frontend
npm ci --no-audit --no-fund
npm run build
cd ..

# 本地安装 tauri CLI（仓库根无前/后脚本，用 --prefix 或 npm -i）
npm install -D @tauri-apps/cli@^2

# 正式构建（产出 MSI + NSIS）
# 注意：不要设置空的 HTTP_PROXY/HTTPS_PROXY，否则 ureq 会误走不存在代理
npx tauri build --verbose

# 产物输出目录（两者均有可能，取决于 workspace 布局）：
#   - target\release\bundle\msi\Harness_0.2.0_x64_en-US.msi
#   - target\release\bundle\nsis\Harness_0.2.0_x64-setup.exe
# 或者：
#   - src-tauri\target\release\bundle\msi\...
#   - src-tauri\target\release\bundle\nsis\...
```

也可直接运行仓库提供的 PowerShell 脚本：
```powershell
powershell -ExecutionPolicy Bypass -File scripts\build_windows.ps1
```

### 2.3 开发模式

```powershell
# 窗口 A
cd frontend
npm run dev     # 启动 Vite dev server @ http://127.0.0.1:1420

# 窗口 B（仓库根）
npm install -D @tauri-apps/cli@^2     # 首次
npx tauri dev                         # 启动 Tauri 窗口（热重载）
```

### 2.4 CI / 自动发布

`.github/workflows/build-windows-release.yml`：
- 触发条件：`push tags v*`、`push main`、`workflow_dispatch`。
- 环境：`windows-latest` runner（已预装 WiX 3.14.1）。
- 步骤：Checkout → 解析版本 → Node/Rust/Cache → 前端构建 → tauri build → 枚举产物（动态探测 `target` 和 `src-tauri/target`） → 上传 artifact → 创建 GitHub Release 并上传 assets（需要 `permissions: contents: write`）。
- 产物命名：`Harness_<version>_x64_en-US.msi`、`Harness_<version>_x64-setup.exe`。

---

## 三、首次运行配置

### 3.1 启动与应用账号登录

1. 启动 Harness，出现登录界面。
2. 首次运行需要**创建管理员账号**（在后续版本可改为 LDAP/OIDC；当前版本为本地账号库）。
   - 用户名：长度 3–32，仅允许 `[a-zA-Z0-9_-]`
   - 密码：≥ 8 位，强制包含字母+数字+符号之一
3. 口令以 PBKDF2-HMAC-SHA256 加盐 200,000 轮哈希后写入用户数据目录下的 `auth.sqlite`。
4. 登录成功后颁发 JWT（HS256），有效期 7 天；刷新可「设置 → 重新登录」。

### 3.2 模型 API 配置

在主界面点左上⚙️「**配置面板**」→「模型」标签：

- **内置 OpenAI provider**（codex 内置，无法改 base_url）
  - 环境变量注入：`OPENAI_API_KEY=sk-...`
  - 配置文件 `[model]`：
    ```toml
    model          = "gpt-5.2-codex"
    model_provider = "openai"
    ```

- **自定义 provider**（OpenAI 兼容，如企业网关、DeepSeek、GLM、Qwen 等）
  - 点「新增 Provider」，填写：
    | 字段 | 示例 |
    |------|------|
    | ID | `enterprise-gw` |
    | 名称 | `企业模型网关` |
    | base_url | `https://model-gw.example.com/v1` |
    | env_key | `HARNESS_MODEL_KEY` |
    | wire_api | `responses` 或 `chat_completions` |
  - 切换默认模型：`[model] model_provider = "enterprise-gw"`。

- **多模型预设**：配置面板已预装 `deepseek`、`zhipu-glm`、`qwen` 的 base_url 模板，只需填写 env_key（环境变量值）即可启用。切换后下一轮对话立即生效。

- **模型路由（T11）**：默认开启。规则优先级：
  1. **任务类型**：编码类任务 → 长上下文模型；文档类 → 高推理质量；对话类 → 低成本模型
  2. **上下文长度**：当前会话超过 64K tokens 时 → 强制选择支持 128K 的模型
  3. **成本**：同类任务中选单价最低可用模型
  4. **敏感度**：命中敏感数据关键词（如"财务""薪资""身份证号"）→ 仅路由到白名单本地或合规模型

可在配置面板关闭路由，强制使用「当前选中模型」。

### 3.3 审批策略（T08）

审批面板默认策略（可在配置面板 → 「审批」修改）：

| 策略 | 含义 |
|------|------|
| `never` | 不弹出审批（自动测试用默认，生产不建议） |
| `always` | 所有 `execCommand` 和 `applyPatch` 都必须人工点击确认 |
| `readonly` | 修改文件/执行写命令需审批；只读（ls、cat、grep）放行 |
| `suspicious` | 匹配正则/黑名单关键字（rm、del、format、net use、powershell EncodedCommand…）时审批 |

审批弹窗中可选择：
- ✅ **确认**（一次性确认；可勾选「同类规则永久信任」加入白名单）
- ❌ **拒绝**（可填原因，会写入审批日志）
- 🕒 **要求改写**（仅 applyPatch 场景，Codex 会重新生成 Patch）

### 3.4 飞书集成（T12 / T13）

#### 3.4.1 飞书开放平台准备

1. 在 [飞书开放平台](https://open.feishu.cn/app) 新建「企业自建应用」。
2. 开启权限（Scopes，申请后由管理员审核）：
   - 消息：`im:message`、`im:message:send_as_bot`
   - 文档：`docx:document:readonly`、`docx:document:write`
   - 通讯录：`contact:user.base:readonly`
   - 日历（可选）：`calendar:calendar:readwrite`
3. 安全设置 → 重定向 URL：填 `http://127.0.0.1:18089/callback`（Harness 本地起的回调端口）。
4. 获取 `App ID`（`cli_xxx`）、`App Secret`。

#### 3.4.2 Harness 飞书 MCP 配置

「配置面板」→「飞书」标签：

| 字段 | 填值 |
|------|------|
| App ID | `cli_xxxxxxxxxx` |
| App Secret | 🔒 加密后保存到用户数据目录，**不写入 config.toml 明文** |
| Lark OpenAPI MCP 路径 | 默认 `C:\Program Files\Harness\resources\lark-openapi-mcp.exe`（随安装包分发；构建则需自行放置 `resources/`） |
| Lark OpenAPI Base URL | 国际版：`https://open.larksuite.com/open-apis`；国内版：`https://open.feishu.cn/open-apis` |

填好后点「授权并启动 MCP」—— 浏览器打开飞书 OAuth 授权页，登录后回调到本地，拿到 **user_access_token** 并加入 codex MCP server 列表。刷新（默认 2 小时过期，Harness 内部自动刷新线程无感续期）。

#### 3.4.3 验证

对话里输入：`帮我给张三（zhangsan@example.com）发一条消息：今天下午3点评审会`。
Codex 会调用飞书 MCP 的 `im_message_create`，若配置正确可在飞书端收到消息。

### 3.5 联网搜索（T15）

Tavily 或 Serper 二选一（建议 Tavily，代码 & 摘要质量更高）。

1. 去 https://tavily.com/ 注册拿 API key（`tvly-...`）或 https://serper.dev 拿 `X-API-KEY`。
2. 「配置面板」→「搜索」：
   - 后端选 `tavily` 或 `serper`
   - API key 🔒 加密保存
   - base_url（默认即官网，企业自建可改）
3. 点「保存并注册为 MCP」—— 会在 `[mcp_servers.tavily]` / `[mcp_servers.serper]` 写入配置，下一轮 Turn 即可调用搜索。
4. 前端面板「搜索」可手动触发搜索并查看来源、摘要、命中分数。

### 3.6 插件 & Skill 系统（T14）

「配置面板」→「插件/Skill」：

- **Skill（单技能）**：放置在 `<数据目录>/skills/<skill-id>/SKILL.md`
  - YAML frontmatter：`name`、`version`、`description`、`tools[]`
  - Markdown body：技能指令（System Prompt）
- **Plugin（可含多技能 + 脚本）**：放置在 `<数据目录>/plugins/<plugin-id>/plugin.toml`
  - `[plugin]`：`id`、`name`、`version`、`description`
  - `[skills."<id>"]`：引用 `skills/<id>/SKILL.md`
  - `[[servers]]`：可选，内置一个 stdio MCP server（指向 `<plugin>/scripts/server.py` 或二进制）

操作：
- 「重新扫描」：发现新的技能/插件
- 「启用/禁用」：拨动开关；禁用时 codex 不会加载该插件/Skill 的工具与提示词
- 「应用配置」：写入 `config.toml` 的 `[[plugins]]` 段并重启 codex app-server（当前会话会丢失，确认弹窗会提示）

### 3.7 会话持久化（T16）

会话库默认 SQLite（内嵌 rusqlite + bundled SQLite，无额外依赖）。
- 每轮 Turn 结束自动落库（原子 WAL 模式，抗崩溃）。
- 侧栏「历史会话」可：搜索（标题/正文全文 FTS5）、重命名、恢复（重新注入 codex 作为上下文）、删除。
- 存储位置：见「四、数据目录」下的 `sessions.db`。

---

## 四、数据目录与配置文件

| 内容 | 路径 | 说明 |
|------|------|------|
| **应用安装目录** | `C:\Program Files\Harness\` 或 `%LOCALAPPDATA%\Programs\Harness\` | 可执行文件、WebView2 资源、随包附带的 MCP 二进制（lark-openapi-mcp 等） |
| **用户数据目录** | `%APPDATA%\com.enterprise.harness`（Tauri `appDataDir`） | 每个 Windows 用户各自独立 |
| ↳ 登录口令库 | `auth.sqlite` | 表 `users (id, username, pwhash_salted, salt, created_at)`；PBKDF2-HMAC-SHA256 200k 轮 |
| ↳ 配置文件 | `config.toml` | codex 模型、MCP servers、审批策略、插件列表 |
| ↳ 敏感凭据（加密） | `secrets.bin` | AES-GCM 加密容器，保存模型 API key、飞书 App Secret、Tavily/Serper key |
| ↳ 会话历史 | `sessions.db` | SQLite WAL + FTS5，表 `sessions` 元数据 + `messages` 消息 |
| ↳ Skill 目录 | `skills/` | 自定义 SKILL.md（扫描加载） |
| ↳ Plugin 目录 | `plugins/` | 自定义 plugin.toml + 脚本 |
| ↳ 日志 | `logs/harness-YYYY-MM-DD.log` | Rust tracing `info+` 写入；`error` 会弹窗提示 |
| ↳ Codex 运行根 | `codex-home/` | 运行时 `CODEX_HOME` 指向此处；codex 自建 `threads/`、`mcp_servers/` 缓存 |

**备份/迁移**：整个 `%APPDATA%\com.enterprise.harness` 目录拷贝到新机器同路径即可（注意 secrets.bin 解密 key 绑定机器名，跨机器需先在配置面板「导出凭据」）。

---

## 五、运行诊断 & 故障排查

### 5.1 日志定位

Tauri 后端日志：
```
%APPDATA%\com.enterprise.harness\logs\harness-YYYY-MM-DD.log
```
Codex app-server 子进程日志（stdout/stderr 重定向）：
```
%APPDATA%\com.enterprise.harness\codex-home\logs\app-server*.log
```
前端报错：按 `F12` 打开 DevTools → Console。

### 5.2 常见问题速查

| 现象 | 可能原因 | 解决 |
|------|----------|------|
| 首次启动黑屏/白屏 | WebView2 Runtime 缺失 | 安装包应已自动下载；手动装 https://developer.microsoft.com/microsoft-edge/webview2/ |
| 登录失败「用户名或密码错误」 | 口令哈希不匹配；或 `auth.sqlite` 损坏 | 备份 `auth.sqlite` → 删掉重启 → 创建新账号；口令哈希不可逆向还原 |
| 对话无响应，停留在「模型思考中」 | 模型 API key 无效、网络不通 | 配置面板 → 验证 connectivity；或在 cmd.exe 执行 `set OPENAI_API_KEY=...` 后重新启动 |
| `401 Authentication` 调 OpenAI | `env_key` 指向的环境变量未注入 | 打开 cmd 验证 `echo %HARNESS_MODEL_KEY%` 是否可见；若在 Harness 启动前设置则会被继承 |
| 飞书 MCP 返回「无权限」 | 应用 Scope 未获批或 `app_access_token` 过期 | 飞书后台检查已启用权限；面板点「重新授权」 |
| 联网搜索 MCP 报空结果 | API key 错误或配额用完 | `scripts/e2e_search.py --backend tavily --query "test" --api-key tvly-...` 离线验证 |
| 审批弹窗消失 | 审批默认 60 秒超时，超时 Codex 视为拒绝 | 配置面板调整 `approval_timeout_sec` |
| MSI 安装报「版本已存在无法安装」 | 旧版未卸载或 tag 相同 | `msiexec /i Harness_0.1.0_x64_en-US.msi REINSTALL=ALL REINSTALLMODE=vomus` |
| 体积过大（>10MB） | 前端未做 tree-shaking；Rust LTO=thin 而非 true | 确认 `Cargo.toml` 下 `[profile.release] lto = true`；前端用 `npm run build`（TSC + Vite production） |
| tauri build 报 WiX/NSIS 下载失败 | 代理设置错误 | **不要**设置空值 `$env:HTTP_PROXY=""`；用真实代理值或留空 |

### 5.3 自检脚本

T01–T16 每个任务都带端到端测试，可在 Windows（或 WSL）上直接运行：

```powershell
# 先装 Python 3.10+
python scripts\e2e_minimal_turn.py       # T03 MCP 最小对话
python scripts\e2e_approval.py           # T08 审批链路
python scripts\e2e_config.py             # T09 配置读写
python scripts\e2e_multimodel.py         # T10 多模型切换
python scripts\e2e_router.py             # T11 模型路由
python scripts\e2e_feishu_mcp.py         # T12 飞书 MCP（mock）
python scripts\e2e_feishu_oauth.py       # T13 飞书 OAuth（mock）
python scripts\e2e_plugins.py            # T14 插件 & Skill 扫描
python scripts\e2e_search.py             # T15 联网搜索
python scripts\e2e_sessions.py           # T16 会话持久化
python scripts\e2e_installer_size.py     # T17 体积校验（MSI ≤8MB, NSIS ≤6MB）
```

Rust crates 的单元测试：
```powershell
cargo test -p auth           # 口令哈希 + JWT
cargo test -p harness-config # 配置模型读写
cargo test -p harness-router # 路由规则
cargo test -p harness-search # 搜索客户端
cargo test -p harness-sessions # SQLite 会话存储
cargo test -p harness-plugins  # 插件发现
cargo test -p feishu-oauth  # OAuth 刷新
cargo test -p appserver     # JSON-RPC 客户端
```

### 5.4 重置（回到出厂）

若配置混乱，按顺序操作：
1. 关闭 Harness。
2. 备份整个 `%APPDATA%\com.enterprise.harness`。
3. 删除该目录。
4. 重启 Harness → 会触发首次初始化流程（重新建表 + 默认配置）。

---

## 六、安全清单（面向企业 IT）

| 维度 | 当前状态 | 建议 |
|------|----------|------|
| 口令存储 | PBKDF2-HMAC-SHA256 + 每用户随机盐 + 200k 轮 | ✅ 达标；建议后续切 Argon2id |
| 密钥存储 | secrets.bin = AES-GCM 256-bit + 机器标识派生 key | ⚠️ 迁移场景需先「导出凭据」；建议改 DPAPI/CryptoNG |
| 跨站脚本（CSP） | tauri.conf.json 已启用严格 CSP（default-src 限制协议源；script/style 仅允许 unsafe-inline；AI 消息 HTML 经 DOMPurify 再渲染） | ✅ v0.2.0 生效；后续可进一步 hash 内联脚本 |
| 网络访问审批 | 通过审批面板控制 execCommand / applyPatch | 建议生产环境把 approval_policy 设为 `suspicious` |
| WebView2 同源 | 前端资源从本地 `assets/` 协议加载，无远程 | ✅ |
| 文件系统 | Codex 的文件沙箱默认 `cwd = %USERPROFILE%\\harness-workspace` | 可配置为只允许单目录工作；建议开启 |
| 敏感协议 | model key / 飞书 secret 不写入 TOML，只在内存注入子进程环境变量 | ✅ |
| 审计 | 每次审批决策 + 错误写入 logs | P2 接入企业 ELK / SIEM |
| 安装包签名 | MSI / NSIS 目前均**未签名**（SmartScreen 会告警） | 申请 EV 代码签名证书后在 workflow 加入 signtool 步骤 |

---

## 七、升级流程

1. 下载新版 Release（MSI / NSIS）。
2. 关闭 Harness（包括托盘图标 → 退出）。
3. 直接运行新安装包；Windows 安装器会覆写旧版 Program Files 内容。
4. 用户数据目录不会被删除，升级后登录、会话、配置全部保留。
5. 若版本跨度大导致 `config.toml` schema 不兼容，启动时会自动备份为 `config.toml.bak.<old-version>` 并生成默认配置，按「三、首次运行配置」重新补齐 key 即可。

---

## 八、参考链接

- GitHub Release: https://github.com/windyisland-aiot/codex-harness-app/releases/tag/v0.5.1
- CI Workflow: `.github/workflows/build-windows-release.yml`
- 任务清单: [TASKS.md](TASKS.md)
- Tauri 2.x 文档: https://v2.tauri.app/
- Codex upstream: https://github.com/openai/codex （Apache-2.0）
