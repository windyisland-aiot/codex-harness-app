# Harness 桌面客户端 · 后端接口文档

> **客户端仓库**：`windyisland-aiot/codex-harness-app`（Tauri v0.6.1，Rust + React + Vite）
> **默认后端地址**：`http://118.31.107.214`（可在客户端 UI 内修改）
> **架构**：客户端 = 薄 UI 外壳；后端 = bibike-script-platform（FastAPI）+ 统一火山方舟代理

---

## 目录

- [1. 通用约定](#1-通用约定)
- [2. 健康检查](#2-健康检查)
- [3. 认证 / 登录](#3-认证--登录)
- [4. 核心对话（SSE 长连接）](#4-核心对话sse-长连接)
- [5. 对话健康检查](#5-对话健康检查)
- [6. Skill 同步](#6-skill-同步)
- [7. 插件市场](#7-插件市场)
- [8. 多模态附件（规划中）](#8-多模态附件规划中)
- [9. 错误响应统一格式](#9-错误响应统一格式)
- [10. 前端调用链路参考](#10-前端调用链路参考)
- [附录 A. 当前端点可用性速查](#附录-a-当前端点可用性速查)

---

## 1. 通用约定

### Base URL
```
{base} = 客户端配置的后端地址，默认 http://118.31.107.214
        所有路径以 {base} 开头，客户端代码不会自动拼接 /api/v1。
        但 plugins 模块下的端点都带 /api/v1（见 §7）。
        ⚠️ 这两者目前不统一，后端建议统一加 /api/v1 前缀。
```

### 鉴权
| 场景 | Header | 说明 |
|------|--------|------|
| 未登录可访问 | 无 | `/auth/login`、`/health` |
| 已登录 | `Authorization: Bearer <token>` | 所有其他端点 |

### Token 格式
客户端不校验 token 内容，只要求登录响应的 `data.user.token` 字段能取到字符串即可。
后端可用 JWT（推荐），也可用 UUID + Redis 会话。

### Content-Type
- **普通请求**：`application/json`
- **SSE 响应**：`text/event-stream`
- **文件下载**：`application/zip`（见 §7.2）

### 时间格式
ISO-8601，UTC：`2026-09-02T10:30:00Z`

---

## 2. 健康检查

客户端**启动时**会调这个端点探测后端是否可达。

### `GET /api/v1/health`（plugins 模块用的路径）
或  
### `GET /health`（cloud_bridge 模块用的路径）

> ⚠️ 客户端两处调用的路径不一致：
> - `plugins_cloud_health` → `GET {base}/api/v1/health`
> - `cloud_health`          → `GET {base}/codex/health`
> 
> 后端建议统一为一个路径，返回 200 即可。plugins 模块的容错逻辑会依次尝试 4 个候选路径，只要有一个通就算 ok。

**请求**
```
GET {base}/api/v1/health
```

**成功响应 200**（任意结构都可，客户端只看 status code）
```json
{
  "data": { "status": "ok", "service": "api" },
  "request_id": "f38a03d8-ac01-4404-9b0f-91b97977bee2"
}
```

---

## 3. 认证 / 登录

### `POST /auth/login`

用户名密码登录。客户端从返回的 `data.user.token` 取 token 保存到本地，后续所有请求自动带上。

**请求**
```http
POST /auth/login
Content-Type: application/json

{
  "username": "admin",
  "password": "byyynhy1017"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| username | string | ✅ | 用户名 |
| password | string | ✅ | 明文密码（HTTPS 传输） |

**成功响应 200**
```json
{
  "data": {
    "user": {
      "id": "u_001",
      "username": "admin",
      "name": "管理员",
      "role": "admin",
      "token": "eyJhbGciOiJIUzI1NiIs...（JWT 或任意字符串）"
    }
  },
  "request_id": "a1b2c3d4-..."
}
```

> 客户端**只依赖三个字段**：`data.user.token`（必须）、`data.user.username`（可选，展示用）、`data.user.id`（可选）。其他字段（email、avatar 等）可自由扩展，客户端会忽略。

**失败响应 401**
```json
{ "detail": "用户名或密码错误" }
```

---

## 4. 核心对话（SSE 长连接）

这是**整个后端最核心的端点**。客户端发送用户消息，后端输出 SSE 事件流，前端实时渲染回复气泡和状态。

### `POST /codex/chat`

**请求**
```http
POST /codex/chat
Authorization: Bearer <token>
Content-Type: application/json
Accept: text/event-stream

{
  "session_id": "h-3f2a-8b41-c7d9-e5f0-a1b2c3d4e5f6",
  "messages": [
    { "role": "user", "content": "今天想做什么？" }
  ],
  "brief": {}
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| session_id | string | ✅ | 客户端生成的会话 ID（UUID 格式，前缀 `h-`）。**后端不做会话持久化**（每次 chat 都是独立请求），但建议用它去后台日志里关联同一用户的多轮对话。 |
| messages | array | ✅ | 本轮对话。当前版本只传一个 `user` 消息；未来多轮时后端可自行维护会话历史。 |
| messages[].role | string | ✅ | `"user"` 或 `"assistant"` |
| messages[].content | string 或 array | ✅ | 纯文本时是 string；多模态时是内容块数组（见 §8） |
| brief | object | ❌ | 预留的任务上下文（当前为空对象 `{}`） |

**成功响应 — SSE 事件流**

客户端用标准 `BufReader` 逐行读取，按空行分割事件块。每个事件块最多由三部分组成：
```
event: <事件名>
data: <JSON 字符串>

```

**客户端识别的事件名**

| event | 前端 method | data 结构 | 前端行为 |
|-------|------------|----------|---------|
| `status` | `cloud/status` | `{ "stage": "intake" \| "retrieving" \| "generating" \| "guard" }` | 更新对话框顶部状态条文字 |
| `intake_question` | `cloud/intake_question` | `{ "question": "提炼后的需求", "reason": "为什么这样提炼" }` | 在对话框显示一个蓝色"需求提炼"气泡 |
| `result` | `cloud/result` | `{ "script": "...", "creative_notes": "...", ... }` | 在对话框显示结构化的脚本生成结果（JSON → Markdown 渲染） |
| （空 / 未知名） | `cloud/unknown` | 任意 JSON 或纯文本 | `data.raw` 追加到当前 assistant 消息气泡 |

> **推荐实现**：后端在 streaming 过程中按以下节奏发事件：
> 1. 先 `event: status, data: {"stage":"intake"}`
> 2. 然后 `event: intake_question, data: {...}`
> 3. 然后 `event: status, data: {"stage":"retrieving"}`（可选）
> 4. 然后 `event: status, data: {"stage":"generating"}`
> 5. 边生成边发普通 SSE 事件（event 留空 / data 就是当前生成的文本片段）
> 6. 生成完毕后发 `event: result, data: {...}`（如果有结构化结果）
> 7. 关闭连接；客户端收到流结束后自动追加一个 `cloud/turn_completed` 事件并把 pending 状态置回 false

**SSE 示例**
```http
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no    ← 建议关闭 Nginx buffering，否则 SSE 会攒一大块再发

event: status
data: {"stage":"intake"}

event: intake_question
data: {"question":"帮我生成一条618大促的豆包短视频脚本","reason":"用户原始需求比较口语化，提炼为具体文案任务"}

event: status
data: {"stage":"generating"}

data: 好的，下面为你生成一条 618 大促豆包短视频脚本：\n\n
data: **标题**：一键成案，AI 时代的广告创意\n\n
data: **时长**：30 秒\n\n

event: result
data: {"script":"...完整脚本...","creative_notes":"画面节奏建议前 5 秒抓人眼球"}

```

---

## 5. 对话健康检查

### `GET /codex/health`

带鉴权的健康检查。客户端登录后会定时调这个端点来检测云端连接是否还活着。

**请求**
```http
GET /codex/health
Authorization: Bearer <token>
```

**成功响应 200**（任意 JSON 均可）
```json
{ "status": "ok", "session_count": 42 }
```

---

## 6. Skill 同步

### `GET /plugins/sync`

返回后端已注册的 skill 列表。客户端登录后、以及用户手动点"刷新"时会调用。

**请求**
```http
GET /plugins/sync
Authorization: Bearer <token>
```

**成功响应 200**

客户端能识别的字段（**宽松解析**，下面结构任意一种都行）：
```json
{
  "ok": true,
  "synced": ["talk-script", "feishu-bot"],
  "skills": [
    {
      "id": "talk-script",
      "name": "talk-script",
      "version": "1.2.0",
      "description": "广告脚本生成",
      "installUrl": "https://.../download/talk-script.zip",
      "entry": "SKILL.md"
    }
  ]
}
```

客户端 `cloud_skills_sync` 解析逻辑（Rust `serde_json::Value` 直接转回给前端）：
- 不做字段校验，原样透传给前端
- 前端用 `ok` 字段判断是否成功
- `synced` 数组用于 UI 提示"已同步哪些 skill"

---

## 7. 插件市场

这部分给客户端**插件管理页面**用。

### 路径前缀说明

插件相关端点**都带 `/api/v1` 前缀**（和 `auth/login`、`codex/chat` 不同）。
```
GET  {base}/api/v1/market
GET  {base}/api/v1/market/{id}/download
```

### 7.1 `GET /api/v1/market`

获取云端可下载的插件 / skill 列表。客户端**容错逻辑**：会依次尝试 4 个候选路径，**第一个返回 2xx 的就算成功**：
1. `GET /api/v1/market`
2. `GET /api/v1/plugins`
3. `GET /api/v1/marketplace`
4. `GET /api/v1/skills`

后端**只需要实现一个**，推荐 `/api/v1/market`。

**请求**
```http
GET /api/v1/market
Authorization: Bearer <token>    ← 可选，未登录也能看列表
```

**成功响应 200**

客户端能识别以下三种结构（`extract_items` 函数宽容解析）：

```json
// 格式 A：数组直接返回
[
  { "id": "talk-script", "name": "talk-script", "version": "1.2.0", "description": "广告脚本生成", "downloadUrl": "/api/v1/market/talk-script/download" },
  { "id": "feishu-bot",  "name": "feishu-bot",  "version": "0.9.0", "description": "飞书多维表格读写", "downloadUrl": "/api/v1/market/feishu-bot/download" }
]

// 格式 B：{ items: [...] }
{ "items": [ ... ] }

// 格式 C：{ data: { items: [...] } }
{ "data": { "items": [ ... ] } }
```

**必须字段**
| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 唯一标识，后续 download 用 |

**推荐字段**
| 字段 | 类型 | 说明 |
|------|------|------|
| name | string | 显示名 |
| version | string | 版本号 |
| description | string | 一句话描述 |
| downloadUrl | string | 下载 URL（客户端会优先用这个；没提供就自动拼 `/api/v1/market/{id}/download`） |

**失败时的优雅降级**（客户端行为）
如果这 4 个路径**全部返回 404 / 超时**，客户端会返回空列表而不是报错，UI 显示"服务端暂未开放插件市场"。所以后端开发时**这个端点的优先级可以放低**，不影响核心对话功能。

---

### 7.2 `GET /api/v1/market/{item_id}/download`

下载单个插件的 ZIP 包，客户端下载后自动解压到 `<codex_home>/skills/{item_id}/`。

**请求**
```http
GET /api/v1/market/talk-script/download
Authorization: Bearer <token>
```

**成功响应 200**
```
Content-Type: application/zip
Content-Disposition: attachment; filename="talk-script-1.2.0.zip"
Content-Length: 123456

<binary ZIP stream>
```

**ZIP 内容约定**
解压后应直接包含插件根目录结构，例如：
```
talk-script-1.2.0.zip
├── SKILL.md            ← 入口文件（必读）
├── prompt.md           ← skill 提示词
├── scripts/            ← 可选脚本
└── manifest.json       ← 可选元数据
```

**失败响应**
```json
// 404 不存在
{ "detail": "plugin not found" }

// 403 无权限
{ "detail": "token expired" }
```

---

## 8. 多模态附件（规划中）

前端 **v0.6.1 已经有附件上传按钮 UI**，但附件目前还没接到请求里。下一个迭代会扩展 `/codex/chat` 的 messages 格式。

### 8.1 前端待发送的请求体（未实现，后端可预留）

```json
{
  "session_id": "h-...",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "帮我分析这张图" },
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,iVBORw0KGgo..." } }
      ]
    }
  ],
  "attachments": [
    {
      "filename": "report.pdf",
      "mime": "application/pdf",
      "size": 1048576,
      "data_url": "data:application/pdf;base64,JVBERi0xLj..."
    }
  ]
}
```

后端收到后应把 `content` 块或 `attachments` 转换为火山方舟的多模态格式再转发。

### 8.2 火山方舟多模态模型

参考：https://www.volcengine.com/docs/82379/1330310

以下模型支持 `image_url` 输入：
- `doubao-seed-2.0-lite` / `doubao-seed-2.0-mini`
- `minimax-m3` / `minimax-seed-evolving`
- `deepseek-v4-flash` / `deepseek-v4-pro`
- `glm-5.3` / `glm-5-flash`
- `kimi-k2.5` / `kimi-k3`

只有 `ark-code-latest` 是纯文本（Coding Plan 路由）。

---

## 9. 错误响应统一格式

所有非 2xx 响应建议用这个结构，客户端前端的 `Error` 气泡会展示 `detail` 字段。

```json
{
  "detail": "人类可读的错误描述",
  "error_code": "E_AUTH_TOKEN_EXPIRED",
  "request_id": "a1b2c3d4-..."
}
```

| HTTP | 场景 | 前端行为 |
|------|------|---------|
| 400 | 参数缺失 / 格式不对 | 显示红色错误气泡，允许用户修正后重试 |
| 401 | token 过期 / 无效 | 自动弹出登录框，用户重新登录 |
| 403 | 权限不足 | 显示错误气泡 |
| 404 | 插件不存在 | 显示错误气泡 |
| 429 | 限流 | 显示"请求太频繁，请稍后再试" |
| 500 | 后端崩溃 | 显示错误气泡 + 状态栏提示，SSE 模式下会自动关闭连接 |

---

## 10. 前端调用链路参考

```
┌──────────────────── 客户端 (Tauri Harness v0.6.1) ────────────────────┐
│                                                                       │
│   React UI                   Rust cloud_bridge.rs                    │
│   ─────────                  ────────────────                        │
│   用户点击登录    ──invoke──▶ cloud_login   ──HTTP──▶ POST  /auth/login │
│                             cloud_health    ──HTTP──▶ GET   /codex/health │
│                                                                       │
│   打开插件市场    ──invoke──▶ plugins_cloud_list  ──HTTP──▶ GET /api/v1/market │
│                             plugins_cloud_install ──HTTP──▶ GET /api/v1/market/{id}/download │
│                                                                       │
│   用户发消息      ──invoke──▶ cloud_turn_start   ──HTTP──▶ POST /codex/chat (SSE) │
│                             │                                         │
│                             ▼ (后台线程)                               │
│                             BufReader 逐行读 SSE                       │
│                             解析 event: / data: 行                     │
│                             push_event → CodexState.events 队列        │
│                             pollEvents() 拉取 → React setState → UI   │
│                                                                       │
│   手动同步 skill  ──invoke──▶ cloud_skills_sync ──HTTP──▶ GET /plugins/sync │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

---

## 附录 A. 当前端点可用性速查

> 测试时间：2026-09-02 · 客户端 v0.6.1 · 后端 118.31.107.214

| 端点 | Method | 路径 | 实测 | 备注 |
|------|--------|------|------|------|
| 健康检查 | GET | `/api/v1/health` | **200** ✅ | 已有，响应正确 |
| 健康检查 | GET | `/codex/health` | 401 | 路由存在（加了 auth），实现 OK |
| 登录 | POST | `/auth/login` | 405 | 路由存在但方法不对（可能后端用 GET），需改为 POST |
| 对话桥 | POST | `/codex/chat` | 401 | **路由存在但核心未接**，需接 talk-script agent + SSE 输出 |
| Skill 同步 | GET | `/plugins/sync` | 401 | 路由存在，**需确认是否已实现返回列表** |
| 市场列表 | GET | `/api/v1/market` | **404** ❌ | **不存在，需新建** |
| 插件列表 | GET | `/api/v1/plugins` | 404 | 同 market |
| Skill 列表 | GET | `/api/v1/plugins/skills` | 404 | 同 market |
| 插件下载 | GET | `/api/v1/market/{id}/download` | **404** ❌ | **不存在，需新建** |
| 检索（talk-script） | POST | `/api/v1/retrieve` | **200** ✅ | 之前已实现 |

---

## 实施优先级建议

```
P0  必做（没有这两个客户端云端模式完全不可用）
├── POST /auth/login        ← 把现有 auth 路由改成 POST，返回 data.user.token
└── POST /codex/chat        ← 接 talk-script agent，输出 SSE（工作量最大）

P1  重要（插件管理页面是空的，做完才有内容）
├── GET  /plugins/sync      ← 确认已实现 / 补实现
├── GET  /api/v1/market     ← 新建，返回插件列表
└── GET  /api/v1/market/{id}/download  ← 新建，返回 ZIP

P2  锦上添花
├── GET  /codex/health      ← 已实现（加了 auth）
├── POST /codex/chat 多模态  ← 支持 image_url content 块
└── GET  /api/v1/admin/plugins ← 管理员后台（可不在此周期）
```
