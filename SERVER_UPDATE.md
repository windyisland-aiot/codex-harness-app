# bibike-script-platform 服务端更新文档（云端管理看板 + skill 桥接）

> 目标：把 bibike 云服务改造成「后端管理看板」——实时管理用户、添加插件、更新知识库、更改 LLM 配置；
> 同时暴露 `POST /api/v1/retrieve` 供 `talk-script` SKILL 做知识库检索。
>
> 本文档基于现有仓库（`config.py` / `agents/` / `backend/app/`），给出**可直接照改**的改动清单。
> 共分两个阶段：**A. skill 桥接（已实现，待应用）**、**B. 管理看板后端（新增）**。
> 前端管理页面与本地瘦壳不在本文档范围，另行规划。

---

## 〇、现状盘点（仓库已具备的能力）

| 你要的 | 仓库现状 | 本阶段动作 |
|--------|----------|-----------|
| 更新知识库 | ✅ `backend/app/api/admin.py` 全套：六模块/金句库增删、检索测试、适用类型、维护任务 | 无需改动，直接用 |
| 禁用词 | ✅ `admin/backend` CRUD + 审计 | 无需改动 |
| 管理用户 | 🟡 列出 + 改角色 | 补 `active`(禁用)、`last_seen`(在线)、用量统计 + 认证拦截 |
| 更改 LLM 配置 | ❌ 无运行时接口（env 固定） | 新增运行时覆盖 + 热重载 |
| 添加插件 | ❌ 无插件系统 | 新增插件注册/上传/启停 |
| skill 检索桥 | ❌ | 新增 `/retrieve` |

---

## 一、阶段 A · `POST /api/v1/retrieve`（skill 知识库检索）

> 已在本地验证，语法通过。服务端按此应用即可（若服务端已合入可跳过）。

### A1. `backend/app/schemas/script.py` — 追加检索请求模式
在 `RetrievePayload` 前已有 `BriefPayload`（勿重复），在其后加：

```python
class RetrievePayload(BaseModel):
    """talk-script skill 知识库检索请求：携带 brief 即返回按模块清洗后的参考片段。"""
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)
    brief: BriefPayload
    deep: bool = False
```

### A2. `backend/app/services/script_service.py` — 新增检索服务函数
顶部 import 增加一行：

```python
from agents.retrieval import KnowledgeRetriever  # noqa: E402
```

在 `build_brief(...)` 之后新增：

```python
def retrieve_references(brief_payload: dict, deep: bool = False) -> dict:
    """talk-script skill 知识库检索：返回按模块清洗后的参考片段 + 金句库。"""
    brief = build_brief(brief_payload)
    examples, golden = KnowledgeRetriever().retrieve(brief, deep=deep)
    return {"brief": brief_payload, "examples": examples, "golden": golden}
```

### A3. `backend/app/api/routes.py` — 注册 `/retrieve`
import：

```python
from ..schemas.script import GeneratePayload, IntakePayload, ModifyPayload, RetrievePayload
from ..services.script_service import retrieve_references
```

在 `@router.post("/scripts/generate"...)` 之前新增：

```python
@router.post("/retrieve", status_code=status.HTTP_200_OK)
async def retrieve(payload: RetrievePayload, request: Request):
    """talk-script skill 知识库检索：返回按模块清洗后的参考片段与金句库。"""
    data = retrieve_references(payload.brief.model_dump(), deep=payload.deep)
    return envelope(data, request)
```

> 端点：`/api/v1/retrieve`，无登录依赖（与 `/health` 一致，只读检索）。如需加签，见文末「G. 可选：/retrieve 鉴权」。

---

## 二、阶段 B · 管理看板后端（新增能力）

### B1. LLM / Embedding 运行时配置 + 热重载

**原理**：新建一个 `runtime_settings.json` 作为运行时覆盖源，用读取函数替代 `base.py` / `vector_store.py` 里对 `LLM_*`、`EMBEDDING_*` 常量的直接引用；Admin 接口写文件并触发 `reload()`，下一轮 Agent 实例即生效，**不重启进程**。

#### B1-1 新增文件 `runtime_settings.py`（仓库根目录，与 `config.py` 平级）
```python
"""运行时可覆盖的模型/知识库配置；改后即时生效，不重启进程。"""
from __future__ import annotations
import json, os, threading
from pathlib import Path

from config import (
    LLM_API_KEY, LLM_BASE_URL, LLM_MODEL,
    EMBEDDING_API_KEY, EMBEDDING_BASE_URL, EMBEDDING_MODEL,
)

_PATH = Path(os.getenv("RUNTIME_SETTINGS_PATH", str(Path(__file__).parent / "runtime_settings.json")))
_lock = threading.Lock()
_cached: dict = {}
_cached_mtime = 0

def _load() -> None:
    global _cached, _cached_mtime
    try:
        mtime = _PATH.stat().st_mtime_ns
    except OSError:
        return
    if mtime == _cached_mtime:
        return
    try:
        data = json.loads(_PATH.read_text(encoding="utf-8")) or {}
    except Exception:
        return
    _cached, _cached_mtime = data, mtime

def reload() -> None:
    global _cached_mtime
    _cached_mtime = 0
    with _lock:
        _load()

def get_llm_base_url() -> str:   _load(); return (_cached.get("llm", {}).get("base_url") or LLM_BASE_URL)
def get_llm_model() -> str:      _load(); return (_cached.get("llm", {}).get("model") or LLM_MODEL)
def get_llm_api_key() -> str:    _load(); return (_cached.get("llm", {}).get("api_key") or LLM_API_KEY)
def get_embedding_base_url() -> str: _load(); return (_cached.get("embedding", {}).get("base_url") or EMBEDDING_BASE_URL)
def get_embedding_model() -> str:     _load(); return (_cached.get("embedding", {}).get("model") or EMBEDDING_MODEL)
def get_embedding_api_key() -> str:   _load(); return (_cached.get("embedding", {}).get("api_key") or EMBEDDING_API_KEY)
```

#### B1-2 改写 `agents/base.py` 的 `BaseAgent.__init__`
把对常量的直接读取改为经 `runtime_settings` 取**当前值**，保证每个新 Agent 实例拿到最新配置：

```python
from openai import OpenAI
from runtime_settings import get_llm_api_key, get_llm_base_url, get_llm_model, \
    get_llm_reasoning_effort  # 若 REASONING 也要热更则加；否则沿用 REASONING_EFFORT
```
```python
def __init__(self, name, system_prompt, timeout=90.0, model=None):
    self.name = name
    self.system_prompt = system_prompt
    self.model = model or get_llm_model()
    self.client = OpenAI(api_key=get_llm_api_key(), base_url=get_llm_base_url(), timeout=timeout)
```
> 说明：`generate_script` 每轮都会新建 `ScriptOrchestrator`，所有 Agent 在 init 时读值，故改完配置下一轮即时生效。

#### B1-3 改写 `rag/vector_store.py` 的 `VectorStoreManager.__init__`
把 `self.openai = OpenAI(api_key=EMBEDDING_API_KEY, base_url=EMBEDDING_BASE_URL)` 改为：

```python
from runtime_settings import get_embedding_api_key, get_embedding_base_url
# ...
self.openai = OpenAI(api_key=get_embedding_api_key(), base_url=get_embedding_base_url())
```
（模块顶部的 `EMBEDDING_*` 常量 import 可保留作回退默认值。）

#### B1-4 新增 Admin 接口（`backend/app/api/admin.py`）
```python
from pydantic import BaseModel, Field
from runtime_settings import reload

class LlmConfigPayload(BaseModel):
    base_url: str = Field(default="", max_length=500)
    model: str = Field(default="", max_length=120)
    api_key: str = Field(default="", max_length=500)  # 留空表示不修改

class EmbeddingConfigPayload(BaseModel):
    base_url: str = Field(default="", max_length=500)
    model: str = Field(default="", max_length=120)
    api_key: str = Field(default="", max_length=500)

@router.get("/admin/config/runtime")
async def runtime_config(request: Request, user=Depends(require_admin)):
    from runtime_settings import _cached
    data = {
        "llm":       _cached.get("llm") or {},
        "embedding": _cached.get("embedding") or {},
        "path": _get_runtime_path(),
    }
    return envelope(data, request)

@router.patch("/admin/config/llm")
async def set_llm_config(payload: LlmConfigPayload, request, user=Depends(require_admin)):
    return _write_runtime("llm", payload.model_dump(exclude_none=True), request)

@router.patch("/admin/config/embedding")
async def set_embedding_config(payload: EmbeddingConfigPayload, request, user=Depends(require_admin)):
    return _write_runtime("embedding", payload.model_dump(exclude_none=True), request)
```
配合以下工具函数（可放 `backend/app/services/runtime_cfg_service.py`）：
```python
import json, os
from pathlib import Path
from fastapi import Request
from runtime_settings import _PATH, reload

def _read() -> dict:
    try:
        return json.loads(_PATH.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}

def _write_runtime(scope: str, patch: dict, request: Request) -> dict:
    data = _read()
    merged = dict(data.get(scope) or {})
    # 空串视作恢复默认（回退到 env）
    for k, v in patch.items():
        if v not in (None, ""):
            merged[k] = v
        else:
            merged.pop(k, None)
    data[scope] = merged
    _PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    reload()
    return {"ok": True, "scope": scope, "path": str(_PATH)}
```
> `runtime_settings.json` 建议加入 `.gitignore`（含 api_key 明文）。

### B2. 用户管理补全（禁用 / 在线 / 用量）

#### B2-1 `backend/app/models.py` — `User` 增加两列
```python
from sqlalchemy import Boolean
class User(Base):
    # ...现有字段...
    role: Mapped[str] = mapped_column(String(20), default="user", index=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, default=None)
```

#### B2-2 新增迁移 `backend/alembic/versions/0006_user_active_last_seen.py`
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

#### B2-3 认证拦截 & 记录在线（`backend/app/security.py`）
在 `get_current_user` 校验通过后追加：
```python
if not user.active:
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="账号已被禁用")

# 触碰在线时间（不阻塞请求）
try:
    user.last_seen_at = utcnow()
    session.commit()
except Exception:
    session.rollback()
```
> `login` 也应在校验密码后拒绝 `not user.active`。

#### B2-4 Admin 接口（`backend/app/api/admin.py`，扩展现有 `/admin/users`）
列表带在线/禁用/用量：
```python
from sqlalchemy import func, select
from ..models import ScriptSession

@router.get("/admin/users")
async def admin_users(request: Request, user=Depends(require_admin)):
    from ..config import settings
    online_secs = 300  # 5 分钟内活跃视为在线
    with db_session() as db:
        rows = db.scalars(select(User).order_by(User.id)).all()
        by_id = {u.id: u for u in rows}
        counts = dict(db.execute(
            select(ScriptSession.user_id, func.count(ScriptSession.id)).group_by(ScriptSession.user_id)
        ).all())
        from ..db import utcnow
        data = [{
            "id": u.id, "username": u.username, "role": u.role,
            "active": u.active,
            "created_at": u.created_at.isoformat() if u.created_at else None,
            "online": bool(u.last_seen_at and (utcnow() - u.last_seen_at).total_seconds() <= online_secs),
            "session_count": counts.get(u.id, 0),
        } for u in rows]
    return envelope(data, request)
```
新增启用/禁用：
```python
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

### B3. 插件 / SKILL 管理（新增）

**落点**：云端维护一份 `skills/` 目录 + 注册表（DB 表 `plugins`），提供上传/启停/扫描；本地瘦壳后续同步拉取。

#### B3-1 新增表 `Plugins`（`backend/app/models.py` + 迁移 `0007_plugins.py`）
```python
class Plugin(Base):
    __tablename__ = "plugins"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    key: Mapped[str] = mapped_column(String(120), unique=True, index=True)  # 如 talk-script
    name: Mapped[str] = mapped_column(String(200), default="")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    source: Mapped[str] = mapped_column(String(20), default="builtin")     # builtin / upload / sync
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
```
迁移 0007：
```python
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

#### B3-2 Admin 接口（`backend/app/api/admin.py`）
```python
from pathlib import Path
from ..services import plugin_service  # 见下

@router.get("/admin/plugins")
async def admin_plugins(request: Request, user=Depends(require_admin)):
    from ..db import db_session
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
        if row is None:
            raise HTTPException(status_code=404, detail="插件不存在")
        row.enabled = payload.active
        return envelope({"id": row.id, "key": row.key, "enabled": row.enabled}, request)

@router.post("/admin/plugins/upload", status_code=201)
async def upload_plugin(
    request: Request, user=Depends(require_admin),
    key: str = Form(...), name: str = Form(default=""), enabled: bool = Form(True),
    file: UploadFile = File(...),   # .md SKILL 或 .zip
):
    return envelope(plugin_service.upload(key, name, enabled, file), request)

@router.post("/admin/plugins/scan")
async def scan_plugins(request: Request, user=Depends(require_admin)):
    return envelope(plugin_service.scan_builtins(), request)
```
> 备注：`/upload` 用 `Form`+`UploadFile`，`require_admin` 依赖要求先登录（返回了 cookie 会话），浏览器管理页可用。

#### B3-3 工具服务 `backend/app/services/plugin_service.py`
```python
from __future__ import annotations
import io, shutil, zipfile
from pathlib import Path
from ..db import db_session, utcnow
from ..models import Plugin

PLUGIN_DIR = Path(__file__).resolve().parents[3] / "skills"  # bibike 根下的 skills/

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

### B4. 后端仪表盘只读面板（可选、轻量）
复用现有：
- `GET /admin/system/status`（已存在）
- `GET /admin/knowledge`（已存在，展示各 Chroma 模块计数）
前端 `admin/` 页据此拼「总览」。

---

## 三、迁移落地顺序建议

1. **先合阶段 A**（`/retrieve`）→ 打通 SKILL 检索链路，验证接口。
2. **B1 LLM 运行时配置**（最独立、见效最快）→ 管理页可改模型。
3. **B2 用户补全** → 配合迁移 `0006`、`0007` 一起跑 `alembic upgrade head`。
4. **B3 插件管理** → 建 `skills/` 目录、入库 `talk-script` / `feishu-bot` 两条内置 SKILL 记录。
5. 前端 admin 页面补齐（用户 / 插件 / LLM 三页），属前端工作。

> 已有知识库管理、禁用词管理无需改动。

---

## 四、请求 / 响应示例

### 改 LLM 模型（管理员）
```
PATCH /api/v1/admin/config/llm
Cookie: bibike_session=...
Content-Type: application/json

{"base_url":"https://ark.cn-beijing.volces.com/api/plan/v3","model":"deepseek-v4-flash"}
```
响应：`{"data":{"ok":true,"scope":"llm","path":"...runtime_settings.json"},"request_id":"..."}`

### 查看 /retrieve（skill 检索）
```
POST /api/v1/retrieve
Content-Type: application/json

{"brief":{"targetAudience":"熬夜上火人群","primarySellingPoint":"清热通便","styles":["真诚"],"durationSeconds":45,"scriptMode":"content"}}
```
响应：`{"data":{"examples":{...六模块...},"golden":{...}},"request_id":"..."}`

---

## 五、验证命令

```bash
# 语法自检
python -m py_compile backend/app/api/routes.py backend/app/api/admin.py \
  backend/app/schemas/script.py backend/app/services/script_service.py \
  agents/base.py rag/vector_store.py runtime_settings.py

# 迁移数据库（新增 active / last_seen / plugins）
alembic upgrade head

# /retrieve 冒烟
curl -s http://127.0.0.1:8000/api/v1/retrieve -H 'Content-Type: application/json' \
  -d '{"brief":{"targetAudience":"牙龈肿痛人群","primarySellingPoint":"清热通便","durationSeconds":30,"scriptMode":"content"}}'

# 管理接口（需管理员登录拿 cookie 后）
curl -s -b cookies.txt -X PATCH http://127.0.0.1:8000/api/v1/admin/config/llm \
  -H 'Content-Type: application/json' -d '{"model":"glm-5.2"}'
curl -s -b cookies.txt http://127.0.0.1:8000/api/v1/admin/users
curl -s -b cookies.txt http://127.0.0.1:8000/api/v1/admin/plugins
```

---

## 六、注意事项 / 风险

- **`require_admin` 依赖浏览器会话 cookie**：管理看板是 Web 控制台，走 `bibike_session` 登录 → 与 `/retrieve`（给 skill 用的无登录接口）天然分离，两边不混淆。
- **运行时配置含敏感 api_key**：`runtime_settings.json` 务必加入 `.gitignore` 并限制文件权限；管理页显示时脱敏（只回显前 6 位）。
- **`active=False` 会立刻 403**：改完确认没有把管理员误禁；接口已对 `user_id == user.id` 拒改。
- **LLM 配置只影响之后新建的 Agent**：正在跑的长任务不会中途切换模型（已在 B1-2 说明）。
- **`.gitignore` 追加**：`runtime_settings.json`、`skills/upload*/`、`data/chroma_db`（若未忽略）。