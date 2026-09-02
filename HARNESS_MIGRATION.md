# Harness 迁移 — 服务端执行总单

> 版本：v0.6.0（选项 C：云端 agent + 本地瘦壳）
> 仓库：`bibike-script-platform`（云服务器 `118.31.107.214`）
> 本文档是**唯一执行单**，覆盖 bibike 改造、云端 codex 部署、skill 同步、停用清理。

---

## 〇、执行总览（一张表）

| 阶段 | 做什么 | 涉及范围 | 新建 | 修改 | 验证标志 |
|------|--------|----------|------|------|----------|
| **A** | bibike 服务端改造：/retrieve + admin 看板 | schemas/service/routes/admin/models | 3 | 7 | `/retrieve` curl 返回 200 |
| **B** | 云端 codex 引擎 + skill 下发 | 服务器部署 + 本地网络层改造 | 2+ | 2+ | 本地对话请求云端生成 |
| **C** | 本地瘦壳（codexClient 改调云端） | `crates/appserver` / 前端 | — | 2+ | 本地不再起 codex 进程 |
| **D** | 数据迁移（账号继承、会话清空） | DB 脚本 | 1 | — | 旧账号可登录云端 |
| **E** | 联调收尾（飞书保留待确认） | — | — | — | 端到端 skill 可生成 |

---

## 一、阶段 A · bibike 服务端改造

> 目标：① `POST /api/v1/retrieve` 供 skill 检索；② admin 看板后端（用户/插件/LLM配置/知识库）。

### A1. `/retrieve` skill 检索桥

**改 3 个文件：**

1. `backend/app/schemas/script.py` — 在 `BriefPayload` 后追加：
```python
class RetrievePayload(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)
    brief: BriefPayload
    deep: bool = False
```

2. `backend/app/services/script_service.py` — import + 新增函数：
```python
from agents.retrieval import KnowledgeRetriever  # noqa: E402

def retrieve_references(brief_payload: dict, deep: bool = False) -> dict:
    brief = build_brief(brief_payload)
    examples, golden = KnowledgeRetriever().retrieve(brief, deep=deep)
    return {"brief": brief_payload, "examples": examples, "golden": golden}
```

3. `backend/app/api/routes.py` — import + 注册路由：
```python
from ..schemas.script import ..., RetrievePayload
from ..services.script_service import retrieve_references

@router.post("/retrieve", status_code=status.HTTP_200_OK)
async def retrieve(payload: RetrievePayload, request: Request):
    data = retrieve_references(payload.brief.model_dump(), deep=payload.deep)
    return envelope(data, request)
```

> `/retrieve` 无登录依赖（只读）。如需 API-key 鉴权后续追加。

### A2. LLM / Embedding 运行时配置（热重载）

**新建 1 个文件、改 2 个文件、改 admin 接口：**

1. **新建** `runtime_settings.py`（仓库根目录，与 `config.py` 平级）：
```python
"""运行时可覆盖的模型/知识库配置；改后即时生效，不重启进程。"""
from __future__ import annotations
import json, os, threading
from pathlib import Path
from config import LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, \
    EMBEDDING_API_KEY, EMBEDDING_BASE_URL, EMBEDDING_MODEL

_PATH = Path(os.getenv("RUNTIME_SETTINGS_PATH", str(Path(__file__).parent / "runtime_settings.json")))
_lock = threading.Lock()
_cached: dict = {}
_cached_mtime = 0

def _load():
    global _cached, _cached_mtime
    try: mtime = _PATH.stat().st_mtime_ns
    except OSError: return
    if mtime == _cached_mtime: return
    try: data = json.loads(_PATH.read_text(encoding="utf-8")) or {}
    except Exception: return
    _cached, _cached_mtime = data, mtime

def reload():
    global _cached_mtime
    _cached_mtime = 0
    with _lock: _load()

def get_llm_base_url() -> str:       _load(); return (_cached.get("llm", {}).get("base_url") or LLM_BASE_URL)
def get_llm_model() -> str:          _load(); return (_cached.get("llm", {}).get("model") or LLM_MODEL)
def get_llm_api_key() -> str:        _load(); return (_cached.get("llm", {}).get("api_key") or LLM_API_KEY)
def get_embedding_base_url() -> str: _load(); return (_cached.get("embedding", {}).get("base_url") or EMBEDDING_BASE_URL)
def get_embedding_model() -> str:     _load(); return (_cached.get("embedding", {}).get("model") or EMBEDDING_MODEL)
def get_embedding_api_key() -> str:   _load(); return (_cached.get("embedding", {}).get("api_key") or EMBEDDING_API_KEY)
```

2. **改** `agents/base.py` — `BaseAgent.__init__`：
```python
from runtime_settings import get_llm_api_key, get_llm_base_url, get_llm_model

def __init__(self, name, system_prompt, timeout=90.0, model=None):
    self.name = name
    self.system_prompt = system_prompt
    self.model = model or get_llm_model()
    self.client = OpenAI(api_key=get_llm_api_key(), base_url=get_llm_base_url(), timeout=timeout)
```

3. **改** `rag/vector_store.py` — `VectorStoreManager.__init__`：
```python
from runtime_settings import get_embedding_api_key, get_embedding_base_url
# ...
self.openai = OpenAI(api_key=get_embedding_api_key(), base_url=get_embedding_base_url())
```

4. **改** `backend/app/api/admin.py` — 新增运行时配置读写：
```python
from fastapi import UploadFile, File, Form
from pydantic import BaseModel, Field
from runtime_settings import reload

class LlmConfigPayload(BaseModel):
    base_url: str = Field(default="", max_length=500)
    model: str = Field(default="", max_length=120)
    api_key: str = Field(default="", max_length=500)

class EmbeddingConfigPayload(BaseModel):
    base_url: str = Field(default="", max_length=500)
    model: str = Field(default="", max_length=120)
    api_key: str = Field(default="", max_length=500)
```

工具函数（新建 `backend/app/services/runtime_cfg_service.py`）：
```python
import json
from runtime_settings import _PATH, reload

def _read() -> dict:
    try: return json.loads(_PATH.read_text(encoding="utf-8")) or {}
    except Exception: return {}

def write_runtime(scope: str, patch: dict) -> dict:
    data = _read()
    merged = dict(data.get(scope) or {})
    for k, v in patch.items():
        if v not in (None, ""): merged[k] = v
        else: merged.pop(k, None)
    data[scope] = merged
    _PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    reload()
    return {"ok": True, "scope": scope, "path": str(_PATH)}
```

Admin 路由：
```python
@router.get("/admin/config/runtime")
async def runtime_config(request: Request, user=Depends(require_admin)):
    from runtime_settings import _cached
    return envelope({"llm": _cached.get("llm") or {},
                     "embedding": _cached.get("embedding") or {},
                     "path": str(_PATH)}, request)

@router.patch("/admin/config/llm")
async def set_llm_config(payload: LlmConfigPayload, request: Request, user=Depends(require_admin)):
    return envelope(write_runtime("llm", payload.model_dump()), request)

@router.patch("/admin/config/embedding")
async def set_embedding_config(payload: EmbeddingConfigPayload, request: Request, user=Depends(require_admin)):
    return envelope(write_runtime("embedding", payload.model_dump()), request)
```

> `runtime_settings.json` 加入 `.gitignore`，管理页脱敏显示 api_key。

### A3. 用户管理补全

**改 models、加迁移、改 security、扩 admin：**

1. `backend/app/models.py` — `User` 加列：
```python
from sqlalchemy import Boolean
class User(Base):
    # ...现有...
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, default=None)
```

2. **新建迁移** `backend/alembic/versions/0006_user_active_last_seen.py`：
```python
revision = "0006"
down_revision = "0005"

def upgrade():
    op.add_column("users", sa.Column("active", sa.Boolean(), server_default=sa.text("true"), nullable=False))
    op.add_column("users", sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True))

def downgrade():
    op.drop_column("users", "last_seen_at")
    op.drop_column("users", "active")
```

3. `backend/app/security.py` — `get_current_user` 追加：
```python
if not user.active:
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="账号已被禁用")
try:
    user.last_seen_at = utcnow()
    session.commit()
except Exception:
    session.rollback()
```

4. `backend/app/api/admin.py` — 扩展现有 `/admin/users`：
```python
from sqlalchemy import func, select
from ..models import ScriptSession
from ..db import utcnow

@router.get("/admin/users")
async def admin_users(request: Request, user=Depends(require_admin)):
    data = []
    with db_session() as db:
        rows = db.scalars(select(User).order_by(User.id)).all()
        counts = dict(db.execute(
            select(ScriptSession.user_id, func.count(ScriptSession.id)).group_by(ScriptSession.user_id)
        ).all())
        for u in rows:
            online = bool(u.last_seen_at and (utcnow() - u.last_seen_at).total_seconds() <= 300)
            data.append({"id": u.id, "username": u.username, "role": u.role,
                         "active": u.active,
                         "created_at": u.created_at.isoformat() if u.created_at else None,
                         "online": online, "session_count": counts.get(u.id, 0)})
    return envelope(data, request)

class UserActivePayload(BaseModel):
    active: bool

@router.patch("/admin/users/{user_id}/active")
async def set_user_active(user_id: int, payload: UserActivePayload, request, user=Depends(require_admin)):
    if user_id == user.id:
        raise HTTPException(status_code=400, detail="不能禁用自己")
    with db_session() as db:
        target = db.get(User, user_id)
        if target is None:
            raise HTTPException(status_code=404, detail="用户不存在")
        target.active = payload.active
        return envelope({"id": target.id, "username": target.username, "active": target.active}, request)
```

### A4. 插件 / SKILL 管理

**新建表 + 迁移 + 服务 + 路由：**

1. `backend/app/models.py` — 新表：
```python
class Plugin(Base):
    __tablename__ = "plugins"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    key: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(200), default="")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    source: Mapped[str] = mapped_column(String(20), default="builtin")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
```

2. **新建迁移** `backend/alembic/versions/0007_plugins.py`：
```python
revision = "0007"
down_revision = "0006"

def upgrade():
    op.create_table("plugins",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("key", sa.String(120), nullable=False, unique=True),
        sa.Column("name", sa.String(200), nullable=False, server_default=""),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("source", sa.String(20), nullable=False, server_default="builtin"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
    )

def downgrade():
    op.drop_table("plugins")
```

3. **新建** `backend/app/services/plugin_service.py`：
```python
from __future__ import annotations
import io, zipfile
from pathlib import Path
from ..db import db_session
from ..models import Plugin

PLUGIN_DIR = Path(__file__).resolve().parents[3] / "skills"

def _register(key: str, name: str, source: str) -> None:
    with db_session() as db:
        db.merge(Plugin(key=key, name=name, enabled=True, source=source))

def upload(key: str, name: str, enabled: bool, file) -> dict:
    target = PLUGIN_DIR / key
    target.mkdir(parents=True, exist_ok=True)
    raw = file.file.read()
    if file.filename and file.filename.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            z.extractall(target)
    else:
        (target / "SKILL.md").write_bytes(raw)
    _register(key, name or key, "upload")
    return {"ok": True, "key": key, "path": str(target)}

def scan_builtins() -> dict:
    found = []
    if PLUGIN_DIR.exists():
        for d in PLUGIN_DIR.iterdir():
            if (d / "SKILL.md").exists():
                _register(d.name, d.name, "builtin")
                found.append(d.name)
    return {"ok": True, "found": found}
```

4. `backend/app/api/admin.py` — 插件路由：
```python
from ..services import plugin_service

@router.get("/admin/plugins")
async def admin_plugins(request: Request, user=Depends(require_admin)):
    from ..models import Plugin
    with db_session() as db:
        rows = db.scalars(select(Plugin).order_by(Plugin.id)).all()
        return envelope([{"id": r.id, "key": r.key, "name": r.name,
                          "enabled": r.enabled, "source": r.source} for r in rows], request)

@router.patch("/admin/plugins/{plugin_id}/enabled")
async def set_plugin_enabled(plugin_id: int, payload: UserActivePayload, request, user=Depends(require_admin)):
    from ..models import Plugin
    with db_session() as db:
        row = db.get(Plugin, plugin_id)
        if row is None: raise HTTPException(status_code=404, detail="插件不存在")
        row.enabled = payload.active
        return envelope({"id": row.id, "key": row.key, "enabled": row.enabled}, request)

@router.post("/admin/plugins/upload", status_code=201)
async def upload_plugin(request: Request, user=Depends(require_admin),
                        key: str = Form(...), name: str = Form(default=""),
                        enabled: bool = Form(True), file: UploadFile = File(...)):
    return envelope(plugin_service.upload(key, name, enabled, file), request)

@router.post("/admin/plugins/scan")
async def scan_plugins(request: Request, user=Depends(require_admin)):
    return envelope(plugin_service.scan_builtins(), request)
```

5. **初始化**：把 `talk-script`、`feishu-bot` 的 `SKILL.md` 放入 `skills/talk-script/SKILL.md`、`skills/feishu-bot/SKILL.md`，然后调 scan 入库。

### A5. 知识库 / 禁用词（已有，直接用）

- `GET/POST /admin/knowledge(/*)`：六模块+金句库 — 已就绪
- `GET/POST/PATCH/DELETE /admin/banned-words(/*)`：禁用词 — 已就绪
- `GET /admin/system/status`：系统状态 — 已就绪

---

## 二、阶段 B · 云端 codex 执行引擎 + skill 同步

> 目标：在云端服务器部署 codex app-server，本地瘦壳通过网络连接，不再本地跑 codex。

### B1. 云端部署 codex app-server

**前提**：服务器需 Node.js 20+、能访问 LLM API（火山方舟/DeepSeek 等）。

```bash
# 1. 服务器安装 Node.js（若未装）
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# 2. 创建工作目录
export CODEX_HOME=/opt/codex-home
mkdir -p $CODEX_HOME/skills $CODEX_HOME/logs

# 3. 安装 codex（基于 OpenAI codex CLI，或复用 harness 的 codex 包）
npm install -g @openai/codex
# 或从 harness 源码的 codex 依赖中复制

# 4. 放入 skill 文件
mkdir -p $CODEX_HOME/skills/talk-script $CODEX_HOME/skills/feishu-bot
# 把 talk-script/SKILL.md、feishu-bot/SKILL.md 复制到对应目录

# 5. 配置环境变量
export OPENAI_API_KEY=sk-...   # 或兼容网关 key
export CODEX_MODEL=deepseek-v4-flash
# 若有自定义 base_url，codex CLI 可能需额外配置

# 6. 启动 codex app-server（需确认 codex CLI 支持 app-server 模式）
# 标准 codex CLI 可能需包装；参考 harness 现有 appserver 启动逻辑
codex app-server --port 18080 --skills-dir $CODEX_HOME/skills
```

> **注意**：codex app-server 的具体启动命令需根据实际 codex 版本确认。若标准 codex CLI 无 app-server 模式，需复用 harness 的 `crates/appserver` 逻辑在云端编译运行。

### B2. 本地瘦壳网络层改造

**核心改动**：`crates/appserver/src/lib.rs` 不再本地起 codex 子进程，改为通过 HTTP/SSE 连接到云端。

1. **新增配置项**（`harness-config` 或 `config.toml`）：
```toml
[cloud]
enabled = true
api_base = "http://118.31.107.214:8000/api/v1"   # bibike FastAPI
# codex 直连或走 FastAPI 代理
codex_sse_url = "http://118.31.107.214:18080/sse"   # 云端 codex SSE 端点
```

2. **`crates/appserver/src/lib.rs`** — 改造 `appserver_start`：
- 若 `cloud.enabled`，不再 `std::process::Command` 起本地 codex
- 改为维护一个 HTTP 长连接到 `codex_sse_url`
- 前端发来的 JSON-RPC 请求通过 HTTP POST 转发到云端
- 云端返回的 SSE stream 转发给前端

3. **认证**：本地启动时从 bibike FastAPI 获取 API token（用已有账号登录），后续请求带 `Authorization: Bearer <token>`。

### B3. Skill 云端下发 / 同步

**云端新增接口**（`backend/app/api/routes.py` 或独立 router）：

```python
@router.get("/plugins/sync")
async def plugins_sync(request: Request, user=Depends(get_current_user)):
    """本地瘦壳启动时调用，获取云端 skill 清单与内容哈希。"""
    from ..models import Plugin
    with db_session() as db:
        rows = db.scalars(select(Plugin).where(Plugin.enabled == True)).all()
        return envelope([{
            "key": r.key,
            "name": r.name,
            "source": r.source,
            "updated_at": r.updated_at.isoformat() if r.updated_at else None,
            # 可加入 content_hash 用于增量同步
        } for r in rows], request)

@router.get("/plugins/{key}/download")
async def download_plugin(key: str, request: Request, user=Depends(get_current_user)):
    """下载单个 skill 的压缩包。"""
    from pathlib import Path
    skill_dir = Path(__file__).resolve().parents[3] / "skills" / key
    if not (skill_dir / "SKILL.md").exists():
        raise HTTPException(status_code=404, detail="skill 不存在")
    # 返回 SKILL.md 内容或 zip 包
    return FileResponse(skill_dir / "SKILL.md", media_type="text/markdown")
```

**本地同步逻辑**（Rust 侧，启动时执行）：
1. 调用 `GET /plugins/sync` 获取云端清单
2. 比对本地 `$CODEX_HOME/skills/` 目录
3. 对差异 skill，调用 `/plugins/{key}/download` 下载
4. 更新本地文件，记录同步时间

### B4. 执行链路（端到端）

```
用户在前端发消息
  → 本地 appserver（网络代理，不再起 codex）
  → HTTP POST 云端 codex app-server
  → codex 解析消息，匹配 talk-script skill（读云端 $CODEX_HOME/skills/）
  → skill 🅰 需求采集 → 云端对话上下文
  → skill 🅱 检索 → 调云端 /api/v1/retrieve → Chroma 返回参考片段
  → skill 🅲 生成 → 调用 LLM API（火山方舟）
  → skill 🅳 守卫 → 自查 + 可选调 /guard
  → 结果通过 SSE 回流
  → 本地前端渲染口播稿 + 创作说明 + 风险提醒
```

---

## 三、阶段 C · 本地瘦身

> 目标：本地 Harness 退化为前端壳，codex 完全上云。

**要做的事**：
- 本地不再安装/运行 codex Node.js 依赖（可选保留作为 fallback）
- `crates/appserver` 纯网络代理化（见 B2）
- 前端不再依赖本地 codex 进程状态，改为显示"云端连接状态"
- 配置面板增加「云端地址」设置项
- 打包体积减小（去掉本地 codex bundle）

**验证**：启动 Harness，进程列表里没有 node/codex 子进程，对话请求走网络。

---

## 四、阶段 D · 数据迁移

> 决策已确认：账号继承，会话清空。

**脚本**（新建 `scripts/migrate_accounts.py`）：
```python
"""把 bibike 本地 auth.sqlite 的用户账号迁移到云端 PostgreSQL。
旧会话/消息/脚本版本表不迁移。"""
# 读取本地 auth.sqlite → users 表
# 对每条记录：云端 INSERT INTO users (username, password_hash, salt, role, active)
# 冲突时跳过（username unique）
```

**验证**：旧账号能在云端登录，旧会话不存在。

---

## 五、阶段 E · 联调收尾

- **飞书联动保留待确认**：talk-script skill 是否保留 Base 写入 / 审批提交？
  - 若保留：skill 末尾增加飞书 MCP 调用步骤
  - 若弃用：从 skill 中移除，管理看板可保留飞书配置（供其他用途）
- **端到端验证**：从前端发需求 → 追问 → 检索 → 生成 → 守卫 → 展示，全链路跑通
- **性能压测**：并发 3 路生成，观察云端 codex 内存/响应

---

## 六、停用 / 保留 / 降级清单

| 功能 | 动作 | 时机 | 说明 |
|------|------|------|------|
| **Chroma RAG / 知识库** | ✅ **保留** | — | skill 知识来源，看板继续管理 |
| **用户/认证系统** | ✅ **保留扩展** | 阶段 A | 新增 active/last_seen，admin 看板用 |
| **禁用词（公共/私有）** | 🟡 **降级保留** | 阶段 B | 数据保留，改为 skill `/guard` 工具调用；web 禁用词页面可退役 |
| **会话/脚本历史** | 🟡 **观望** | 阶段 D | 旧会话不保留，新会话云端存 |
| **飞书 Base/审批** | 🟡 **观望** | 阶段 E | 待确认是否保留在 skill 工作流 |
| **bibike Next.js 创作前端** | ⛔ **停用** | 阶段 C | 创作界面由本地桌面壳替代 |
| **Celery 任务队列** | ⛔ **停用** | 阶段 B | 生成执行交给云端 codex，不再走 worker 队列 |
| **视频生成模块** | ⛔ **停用** | 阶段 B | 不在 talk-script skill 范围内 |
| `ad_script.rs` 泛化 5 步 | ⛔ **弃用** | 阶段 B | 被 talk-script 取代 |
| **本地 codex 引擎** | ⛔ **停用** | 阶段 C | 完全上云，本地不再起进程 |

> ⚠️ `⛔` 表示目标态停用，但**不能提前删**：先验证云端 codex 跑通，再逐步退役，避免断档。

---

## 七、迁移路线图（时间顺序 + 依赖）

```
Week 1 ──────────────────────────────────────
  ├─ A1  /retrieve 接口          [可独立验证]
  ├─ A2  LLM 热配置               [可独立验证]
  ├─ A3  用户补全 + 迁移 0006      [需 alembic]
  ├─ A4  插件管理 + 迁移 0007      [需 alembic]
  └─ A5  知识库/禁用词确认可用      [已就绪]

Week 2 ──────────────────────────────────────
  ├─ B1  云端部署 codex           [需 Node.js + skill 文件]
  ├─ B2  本地网络层改代理          [需 B1]
  ├─ B3  skill 同步接口            [需 A4]
  └─ D   账号迁移                  [需 A3]

Week 3 ──────────────────────────────────────
  ├─ C   本地瘦身（去掉本地 codex） [需 B2]
  ├─ E   端到端联调                [需 B+C]
  └─ 确认飞书保留/弃用              [需 E]
```

---

## 八、验证命令汇总

```bash
# ── 阶段 A ──
# 语法
python -m py_compile backend/app/api/routes.py backend/app/api/admin.py \
  backend/app/schemas/script.py backend/app/services/script_service.py \
  agents/base.py rag/vector_store.py runtime_settings.py

# 迁移
alembic upgrade head

# /retrieve 冒烟
curl -s http://127.0.0.1:8000/api/v1/retrieve -H 'Content-Type: application/json' \
  -d '{"brief":{"targetAudience":"牙龈肿痛人群","primarySellingPoint":"清热通便","durationSeconds":30,"scriptMode":"content"}}'

# Admin（需管理员 cookie）
curl -s -b cookies.txt http://127.0.0.1:8000/api/v1/admin/users
curl -s -b cookies.txt -X PATCH http://127.0.0.1:8000/api/v1/admin/config/llm \
  -H 'Content-Type: application/json' -d '{"model":"glm-5.2"}'
curl -s -b cookies.txt -X POST http://127.0.0.1:8000/api/v1/admin/plugins/scan

# ── 阶段 B ──
# 云端 codex 健康
curl -s http://118.31.107.214:18080/health

# skill 同步
curl -s -H 'Authorization: Bearer <token>' http://118.31.107.214:8000/api/v1/plugins/sync

# ── 阶段 C ──
# 本地无 codex 进程
ps aux | grep -i codex   # 应无 node/codex 进程
```

---

## 九、注意事项 / 风险

1. **鉴权分两路**：Admin 走 `bibike_session` cookie；skill 检索 `/retrieve` 暂公开（后续加 API-key）；本地瘦壳走 Bearer token。
2. **`runtime_settings.json` 敏感**：含 api_key，加入 `.gitignore`、限制权限、管理页脱敏。
3. **别误禁自己**：`/admin/users/{id}/active` 已拒改自身。
4. **LLM 配置只影响新 Agent**：正在跑的任务不中途切换模型。
5. **停用不能提前**：Celery/前端/本地 codex 必须在云端 codex 验证跑通后再退役。
6. **codex 云端部署细节**：app-server 启动命令需根据实际 codex 版本调整，可能需复用 harness 的 Rust appserver 在云端编译运行。
7. **.gitignore 追加**：`runtime_settings.json`、`skills/upload*/`。