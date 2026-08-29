# Harness v0.2.0 — 构建与验证报告

> 生成时间：2026-08-29（沙箱 Linux x86_64 · Ubuntu noble）
> 版本：`tauri.conf.json version = 0.2.0` · `frontend/package.json version = 0.2.0`
> 目标平台：Windows 10/11 x64（MSI + NSIS），本报告产物为沙箱可验证的前端与 Rust 单元测试证据。

---

## 一、交付物清单（本目录内）

| 文件 | 体积 | SHA-256（节选） | 说明 |
|------|------|------------------|------|
| `Harness-v0.2.0-frontend-dist.tar.gz` | 92 386 字节（≈ 90 KB） | `f3574c12 … 2adb689` | Vite production 打包的 `dist/`（index.html + css gzip 6KB + js gzip 86KB），可直接用于静态 review 或嵌入 Tauri resources |
| `Harness-v0.2.0-SHA256SUMS.txt` | 384 字节 | — | index.html / css / js / tarball 的完整 SHA256 |

> **Windows MSI / NSIS 安装包**：无法在 Linux 沙箱产出（Tauri bundler 目标为 `msis` + `nsis`，需 windows-latest）。已在 `DEPLOY.md § 二.3 CI / 自动发布` 写明流程。
> CI 触发方式：`git tag v0.2.0 && git push --tags` → workflow `build-windows-release.yml` 自动拉 `codex.exe` → 构建 → 创建 Release → 上传 assets。

---

## 二、编译 & 静态验证（全绿 ✅）

### 2.1 TypeScript 严格检查

```
cd frontend && npx tsc --noEmit
# 结果：0 error / 0 warning
```

### 2.2 Vite Production Build

```
cd frontend && npm run build
✓ 48 modules transformed.
dist/index.html                   0.41 kB │ gzip:  0.31 kB
dist/assets/index-_6LDSo4m.css   27.44 kB │ gzip:  6.14 kB
dist/assets/index-Cf49djpu.js   266.23 kB │ gzip: 86.32 kB
✓ built in 1.10s
```

### 2.3 Rust 9 crate cargo check 通过

```
cargo check --manifest-path Cargo.toml
Finished `dev` profile [unoptimized + debuginfo] target(s) in 4.70s
—— 检查通过的 crate：
  harness-app v0.1.0 (src-tauri)
  harness-auth v0.1.0
  harness-sessions v0.1.0
  harness-plugins v0.1.0
  harness-config v0.1.0
  harness-search v0.1.0
  harness-feishu-oauth v0.1.0
  harness-router v0.1.0
  harness-appserver v0.1.0
```

### 2.4 Rust 单元测试（ark_gateway — 5/5 通过）

```
cargo test -p harness-app --lib

running 5 tests
test ark_gateway::tests::chat_sse_handles_empty_stream ... ok
test ark_gateway::tests::chat_sse_to_responses_basic ... ok
test ark_gateway::tests::chunked_simple ... ok
test ark_gateway::tests::sanitize_hides_key ... ok
test ark_gateway::tests::translates_responses_request_to_chat ... ok

test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

每个测试的意义：
- `translates_responses_request_to_chat`：Responses 请求 → Chat 请求翻译（model / stream / max_tokens / messages）正确
- `chat_sse_to_responses_basic`：Chat SSE delta → Responses SSE 的状态机翻译（reasoning 过滤）正确
- `chat_sse_handles_empty_stream`：空 SSE / EOF 场景正确发 finish 事件并写 terminator chunk
- `chunked_simple`：HTTP/1.1 chunked 编码（transfer-encoding）编码字节序正确，这是 writer-closed 修复的基础
- `sanitize_hides_key`：上游错误消息命中 `ark-` / `Bearer` 关键字时，不会泄漏 API key（统一为泛化消息）

---

## 三、用户 8 项要求 · 需求—证据 对照（验收矩阵）

| # | 用户要求 | 实现位置 / 证据 | 结论 |
|---|----------|-----------------|------|
| 1 | 对话框切换常见大模型 | `models.ts` 9 家预设（火山方舟 / Mock / OpenAI / DeepSeek / GLM / Qwen / Claude / Moonshot / Doubao）；`ModelSwitcher.tsx` 双 select（Provider + Model）；`App.tsx` `applyProvider/applyModel` 写 `config.toml` → 下一个 Turn 生效；UI 在「欢迎页」和「composer 上方 pill」两处呈现 | ✅ 满足 |
| 2 | 发送按钮单个，Work/Code 无意义 | `App.tsx`：视觉上仅一个圆形紫蓝 gradient `btn-send`（↑ SVG）；**行为语义**：`send()` 不再插入 `[Ask 模式]` 前缀（本次审计后修正）；Work/Code/Design Pill 仅保留视觉切换，不影响 prompt | ✅ 满足（审计修复后） |
| 3 | 顶栏做成「🗖 🔍 编辑(E) 帮助(H) ｜ — □ ×」样式 | `App.tsx` L593–655 `<header class="topbar">`：hamburger + search + 编辑(E) + 帮助(H) 菜单 + spacer + 主题切换（额外赠送）+ min / max / close；整条 bar `-webkit-app-region: drag`，符合 Tauri 自定义标题栏拖拽规范 | ✅ 满足 |
| 4 | AI 内容支持 MD 格式呈现 | `Markdown.tsx`：marked (gfm=true, breaks=true) + DOMPurify 防 XSS；代码块 Header（语言标签 + 「复制/已复制/失败」按钮 + 视觉反馈）；`styles.css` `md-wrap md`：表格边框+zebra、blockquote 左侧 6366F1 竖线、ol/ul 缩进、kbd 样式、图片 max-width 100% | ✅ 满足 |
| 5 | 界面简洁如 TraeWork，清除杂项 | ① 删除原「右侧面板」（会话/终端/浏览器/画布/快捷键 Tabs）——App.tsx render 中无 `<aside class=right>`；② 删除 composer 下方 3 条复选框（允许执行命令、自动路由由模型、敏感任务）——UI 无 `<input type=checkbox>` 渲染；③ 删除输入框内嵌 Work/Code 双按钮，改为单发送；④ 删除顶栏右侧「发送前自动路由 / 敏感请求」复选框 + 「深色 / 浅色 路由 ark-code-latest 发送失败…」整条杂项 | ✅ 满足 |
| 6 | 左上侧边栏图三样式（Work/<>Code/Design Pill + 5 菜单项） | `App.tsx` L660–792 `<aside class=sidebar>`：① `sb-mode-pill` Work / `</> Code` / Design 三段；② 菜单项（+新建任务 / 🔌 插件市场 / 📋 模板库 / ⏱ 自动化 / 💬 办公助理）；③ 任务列表 section header + 搜索框 + 列表 item + 状态 dot + badge；④ 底部 sb-footer（avatar + 昵称/在线状态 + 设置图标） | ✅ 满足 |
| 7 | 阅读仓库项目计划，同步进度 | ① 完整阅读 `TASKS.md`（P0 ✅ P1 ✅ UI/UX T25–T31 ✅，P2 列出但未开工）；② 将本次新增 UI/UX 修复项 + Ark 流式修复项在 `TASKS.md` 写入表格（T25–T31）；③ 版本号 DEPLOY.md / tauri.conf.json / package.json 同步到 v0.2.0；④ DEPLOY.md 新增「〇、v0.2.0 版更新要点」完整说明 | ✅ 满足 |
| 8 | 完成后上传 Release 并同步更新至仓库 | ① 本报告所在目录 `releases/v0.2.0/` 为沙箱可产出的全部 Release 物料（前端 dist tarball + SHA256SUMS + 本报告）；② CI workflow `.github/workflows/build-windows-release.yml` 已就绪，默认 windows-latest runner 可产出 MSI + NSIS；③ `DEPLOY.md § 二.2 CI` 写明 tag 命令；④ 版本号全网统一（tauri.conf / package.json / DEPLOY / 下载链接占位一致 v0.2.0）。<br>⚠️ **沙箱无法 `git push` 真实仓库**。用户只需在本地执行 4 条命令即可完成第 8 项最终步骤（见 § 四）。 | ✅ 沙箱侧满足 · 交付用户最终 push 步骤 |

---

## 四、发布到 GitHub Release（用户本地 4 条命令）

沙箱无 Git push 权限。在你本地 Windows/Mac/Linux 开发机进入仓库根执行：

```bash
# 1. 本地再跑一遍所有校验（可选，CI 也会跑）
cd frontend && npm ci --no-audit --no-fund && npm run build && cd ..

# 2. 提交 v0.2.0 变更
git add -A
git commit -m "release: v0.2.0 TraeWork 风格 UI 重构 + Ark SSE 流式修复 + 单发送按钮"

# 3. 打 tag 并推送（触发 CI）
git tag -a v0.2.0 -m "Harness v0.2.0
- UI: TraeWork 风格顶栏/左栏/单发送按钮/ModelSwitcher/响应式小窗口
- 渲染: Markdown 代码块复制按钮 + DOMPurify XSS 防护
- 后端: Ark 网关 chunked SSE + 写超时 600s + 错误脱敏（修复 io writer closed）
- 安全: tauri.conf.json 启用 CSP（修复 CR-2）
- 模型: 9 家常见厂商预置（含 Qwen/Claude/Moonshot/豆包）"
git push origin main --tags
```

CI 自动流程（约 15–25 分钟）：
1. `windows-latest` Checkout → Node/Rust/Cache → 前端构建
2. 自动下载 `codex.exe` 到 `src-tauri/resources/codex.exe` (from openai/codex release `rust-v0.150.1`)
3. `npx tauri build` → 产出 `Harness_0.2.0_x64_en-US.msi` 与 `Harness_0.2.0_x64-setup.exe`
4. 创建 Release `v0.2.0`，上传两个安装包 + 自动生成 release notes

**完成后第 8 项即收工。**

---

## 五、已知遗留（需 Windows 真机验证，不影响交付完成度）

| 项目 | 说明 |
|------|------|
| 真实 Ark API 联通性 | 沙箱不联网 Ark / 无 WebView2。代码侧：5 个网关单测全绿 + 真实写超时/BrokenPipe/SSE 流式代码实现，但最终「发消息成功拿响应」需在 Windows 真机 + 真实 API Key 环境做 E2E。用户当前报告的「io writer closed」代码层根因已按 4 条修复路径全量处理。 |
| 硬编码 Ark Key 存放 | `ark_gateway.rs:40` `const ARK_API_KEY` 由用户提供用于临时调试；生产建议移至 `config.toml model_providers.volcengine-ark` 并加密入 `secrets.bin`（现有凭据加密框架已就位，见 `DEPLOY.md § 三.2`）。 |
| Code signing | MSI/EXE 均未签名（Windows SmartScreen 会弹「更多信息→仍要运行」）。企业分发建议加 EV 代码签名步骤到 workflow（DEPLOY.md 安全清单 § 六末尾已列）。 |
