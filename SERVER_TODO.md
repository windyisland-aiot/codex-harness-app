# 服务端改造总清单（bibike 云端 → skill 桥 + 管理看板）

> 这是一份**综合执行单**，汇总了服务端需要做的全部改动，照着做即可。
> 仓库：`bibike-script-platform`（云服务器 `118.31.107.214`）
> 文档目标：① 让 `talk-script` SKILL 能调云端做知识库检索；② 把云端改造成管理看板
> （管理用户 / 添加插件 / 更新知识库 / 更改 LLM 配置）。
>
> 说明：bibike 仓库仅作参考，改动由你在服务端应用。新文件 `runtime_settings.py`、
> `runtime_settings.json` 需新建；其余均为修改现有文件。

---

## 〇、执行总览（一张表）

| # | 任务 | 涉及文件 | 新建/修改 | 一句话 |
|---|------|----------|-----------|--------|
| A | skill 检索桥 `/retrieve` | schemas/script.py、services/script_service.py、api/routes.py | 修改×3 | 供 SKILL 取六模块+金句库参考片段 |
| B | LLM/Embedding 运行时配置 | 新增 runtime_settings.py；改 agents/base.py、rag/vector_store.py；api/admin.py | 新建×1 修改×3 | 改配置不重启，热生效 |
| C | 用户管理补全 | models.py、alembic 0006、security.py、api/admin.py | 修改×3 新建迁移×1 | 禁用/在线/用量 + 登录拦截 |
| D | 插件/SKILL 管理 | models.py、alembic 0007、services/plugin_service.py、api/admin.py | 新建×1 修改×2 迁移×1 | 上传/启停/扫描 SKILL |
| E | 知识库 / 禁用词 | （无） | —— | 仓库已有完整接口，**无需改** |

> 执行顺序：**A → B → 跑迁移(0006/0007) → C → D**。每步做完跑对应验证命令。

---

## 一、A · skill 检索桥 `POST /api/v1/retrieve`

让 `talk-script` SKILL 的 🅱 步骤从云端 Chroma 取「清洗后的参考片段 + 金句库」。

### A1. `backend/app/schemas/script.py`
在 `BriefPayload` 之后（`CreateSessionPayload` 之前）追加：

```python
class RetrievePayload(BaseModel):
    """talk-script skill 知识库检索请求：携带 brief 即返回按模块清洗后的参考片段。"""
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)
    brief: BriefPayload
    deep: bool = False
```

### A2. `backend/app/services/script_service.py`
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

### A3. `backend/app/api/routes.py`
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

> 端点 `/api/v1/retrieve`，无登录依赖（只读检索）。如需加签见文末「注意事项」。

---

## 二、B · LLM / Embedding 运行时配置（热重载）

> 目的：Admin 面板改模型/BaseURL/Key 后立即生效，不重启进程。

### B1. 新建 `runtime_settings.py`（仓库根目录，与 `config.py` 平级）
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

### B2. 修改 `agents/base.py` → `BaseAgent.__init__`
```python
from runtime_settings import get_llm_api_key, get_llm_base_url, get_llm_model

def __init__(self, name, system_prompt, timeout=90.0, model=None):
    self.name = name
    self.system_prompt = system_prompt
    self.model = model or get_llm_model()
    self.client = OpenAI(api_key=get_llm_api_key(), base_url=get_llm_base_url(), timeout=timeout)
```
> `generate_script` 每轮新建 Agent 时读最新值，故改完下轮生效。

### B3. 修改 `rag/vector_store.py` → `VectorStoreManager.__init__`
```python
from runtime_settings import get_embedding_api_key, get_embedding_base_url
# ...
self.openai = OpenAI(api_key=get_embedding_api_key(), base_url=get_embedding_base_url())
```

### B4. 修改 `backend/app/api/admin.py` — 新增读写与管理接口
```python
from fastapi import UploadFile, File, Form
from pydantic import BaseModel, Field
from runtime_settings import reload

class LlmConfigPayload(BaseModel):
    base_url: str = Field(default="", max_length=500)
    model: str = Field(default="", max_length=120)
    api_key: str = Field(default="", max_length=500)   # 留空=不修改

class EmbeddingConfigPayload(BaseModel):
    base_url: str = Field(default="", max_length=500)
    model: str = Field(default="", max_length=120)
    api_key: str = Field(default="", max_length=500)
```
新增服务函数（可放 `backend/app/services/runtime_cfg_service.py`）：
```python
import json
from runtime_settings import _PATH, reload

def _read() -> dict:
    try:
        return json.loads(_PATH.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}

def write_runtime(scope: str, patch: dict) -> dict:
    data = _read()
    merged = dict(data.get(scope) or {})
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
新增路由（挂在 `router` 下，均 `Depends(require_admin)`）：
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

---

## 三、C · 用户管理补全（禁用 / 在线 / 用量）

### C1. `backend/app/models.py` → `User` 加两列
```python
from sqlalchemy import Boolean
class User(Base):
    # ...现有字段...
    role: Mapped[str] = mapped_column(String(20), default="user", index=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, default=None)
```

### C2. 新建迁移 `backend/alembic/versions/0006_user_active_last_seen.py`
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

### C3. `backend/app/security.py` → `get_current_user` 校验通过后追加
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
> `login`（auth.py）也应在密码校验后拒绝 `not user.active`。

### C4. `backend/app/api/admin.py` — 扩展现有 `/admin/users`
列表带在线/禁用/用量：
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

---

## 四、D · 插件 / SKILL 管理（新增）

### D1. `backend/app/models.py` → 新表 `Plugin`
```python
class Plugin(Base):
    __tablename__ = "plugins"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    key: Mapped[str] = mapped_column(String(120), unique=True, index=True)   # 如 talk-script
    name: Mapped[str] = mapped_column(String(200), default="")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    source: Mapped[str] = mapped_column(String(20), default="builtin")       # builtin / upload / sync
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
```

### D2. 新建迁移 `backend/alembic/versions/0007_plugins.py`
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

### D3. 新建 `backend/app/services/plugin_service.py`
```python
from __future__ import annotations
import io, zipfile
from pathlib import Path
from ..db import db_session
from ..models import Plugin

PLUGIN_DIR = Path(__file__).resolve().parents[3] / "skills"   # bibike 根下的 skills/

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

### D4. `backend/app/api/admin.py` — 插件路由
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
        if row is None:
            raise HTTPException(status_code=404, detail="插件不存在")
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

### D5. 内建 SKILL 入库（服务端初始化一次）
把 `talk-script`、`feishu-bot` 两个 `SKILL.md` 放进 `bibike 根/skills/talk-script/SKILL.md`、`skills/feishu-bot/SKILL.md`，然后
```
curl -b cookies.txt -X POST http://127.0.0.1:8000/api/v1/admin/plugins/scan
```

---

## 五、E · 知识库 / 禁用词（无需改）

已有能力，直接用于管理看板：
- `GET/POST /admin/knowledge(/*)`：六模块+金句库增删、检索测试、适用类型、维护任务
- `GET/POST/PATCH/DELETE /admin/banned-words(/*)`：公共/私有禁用词 + 审计

---

## 六、迁移执行顺序

1. **A** `/retrieve` 三文件 → `curl` 冒烟。✅ 最优先
2. **B** runtime_settings.py + 改 base.py / vector_store.py + Admin 接口
3. 跑 **alembic upgrade head**（含 0006、0007 两个迁移）
4. **C** 用户补全、**D** 插件管理（建 skills/、scan 入库）
5. 前端 admin 页（用户/插件/LLM）补齐 —— 前端工作，不在本单

---

## 七、验证命令

```bash
# 语法自检
python -m py_compile backend/app/api/routes.py backend/app/api/admin.py \
  backend/app/schemas/script.py backend/app/services/script_service.py \
  agents/base.py rag/vector_store.py runtime_settings.py

# 迁移
alembic upgrade head

# /retrieve
curl -s http://127.0.0.1:8000/api/v1/retrieve -H 'Content-Type: application/json' \
  -d '{"brief":{"targetAudience":"牙龈肿痛人群","primarySellingPoint":"清热通便","durationSeconds":30,"scriptMode":"content"}}'

# 以下需管理员登录拿 cookie（web 控制台登录后）
curl -s -b cookies.txt -X PATCH http://127.0.0.1:8000/api/v1/admin/config/llm \
  -H 'Content-Type: application/json' -d '{"model":"glm-5.2"}'
curl -s -b cookies.txt http://127.0.0.1:8000/api/v1/admin/users
curl -s -b cookies.txt http://127.0.0.1:8000/api/v1/admin/plugins
curl -s -b cookies.txt -X POST http://127.0.0.1:8000/api/v1/admin/plugins/scan
```

---

## 八、注意事项 / 风险

- **鉴权分两路**：Admin 接口走浏览器会话 `bibike_session` + `require_admin`；`/retrieve` 给 SKILL 用、暂未加签。两者不混淆。
- **敏感信息**：`runtime_settings.json` 含 api_key，务必加入 `.gitignore`、限制文件权限，管理页只回显前 6 位。
- **别误禁管理员**：`/admin/users/{id}/active` 已对 `id == self.id` 拒改。
- **LLM 配置只影响新 Agent**：正在跑的长任务不会中途切模型。
- **.gitignore 追加**：`runtime_settings.json`、`skills/upload*/`。
- **`/retrieve` 加签（可选）**：如需防滥用，可在 `security.py` 增加 API-key 依赖并挂到该路由，属后续项。