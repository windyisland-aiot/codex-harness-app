# bibike-script-platform 服务端改动清单（方案 1 · 支撑 talk-script skill）

> 目标：给云端 bibike 后端新增一个 `POST /api/v1/retrieve` 接口，供 `talk-script` SKILL 的
> 🅱「知识库检索」步骤调用，返回按模块清洗后的参考片段（痛点钩子 / 购买理由 / 信任背书 /
> 品牌资产 / 促销话术）与金句库，云端 codex 据此生成广告口播脚本。
>
> 共改动 3 个文件。其余无需改动，纯读取 CDN/Chroma，无副作用。

---

## 1. 新增检索请求模式

### 文件
`backend/app/schemas/script.py`

### 改动
在 `RetrievePayload` 之前已有 `BriefPayload`（无需重复定义），在其后新增：

```python
class RetrievePayload(BaseModel):
    """talk-script skill 知识库检索请求：携带 brief 即返回按模块清洗后的参考片段。"""
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)
    brief: BriefPayload
    deep: bool = False
```

> 说明：字段同时接受蛇形 `duration_seconds` 与驼峰 `durationSeconds`。
> `brief` 只用到人群 / 卖点 / 风格 / 时长 / 模式，与 SKILL 里约定一致。

---

## 2. 新增检索服务函数

### 文件
`backend/app/services/script_service.py`

### 改动 A：在文件顶部 import 中加入一行（放在 `from agents import ...` 之后）
```python
from agents.retrieval import KnowledgeRetriever  # noqa: E402
```

### 改动 B：在 `def build_brief(...)` 之后、`def generate_script(...)` 之前新增
```python
def retrieve_references(brief_payload: dict, deep: bool = False) -> dict:
    """talk-script skill 知识库检索：返回按模块清洗后的参考片段 + 金句库。"""
    brief = build_brief(brief_payload)
    examples, golden = KnowledgeRetriever().retrieve(brief, deep=deep)
    return {
        "brief": brief_payload,
        "examples": examples,
        "golden": golden,
    }
```

> `KnowledgeRetriever().retrieve()` 内部已做：六模块检索、促销 mode 过滤、ProductFactGuard
> 引用清洗（`sanitize_reference`）、短句截取（`_reference_sentences`），返回 `(examples, golden)`。
> `deep=False` 时不扩展查询词，直接单查询检索，开销最小。

---

## 3. 注册 `/retrieve` 路由

### 文件
`backend/app/api/routes.py`

### 改动 A：import 三行
```python
from ..schemas.script import GeneratePayload, IntakePayload, ModifyPayload, RetrievePayload
from ..services.celery_app import celery_app
from ..services.script_service import retrieve_references
```
> 即：`script` 的 import 增加 `RetrievePayload`；`celery_app` 之后一行新增 `script_service.retrieve_references`。

### 改动 B：在 `@router.post("/scripts/generate"...)` 之前新增
```python
@router.post("/retrieve", status_code=status.HTTP_200_OK)
async def retrieve(payload: RetrievePayload, request: Request):
    """talk-script skill 知识库检索：返回按模块清洗后的参考片段与金句库。"""
    data = retrieve_references(payload.brief.model_dump(), deep=payload.deep)
    return envelope(data, request)
```

> 端点路径：`/api/v1/retrieve`（`api_prefix = "/api/v1"` 已在 config 固定）。
> 无鉴权依赖（与 `/health` `/ready` 一致），只读检索，供云端 codex 直接调用。
> 若希望后续加鉴权，见下方「可选：API Key」小节。

---

## 请求 / 响应示例

### 请求
```
POST /api/v1/retrieve
Content-Type: application/json

{
  "brief": {
    "targetAudience": "熬夜上火、牙龈肿痛、大便秘结的中青年",
    "primarySellingPoint": "清热泻火通便，OTC正品",
    "styles": ["真诚", "平实"],
    "durationSeconds": 45,
    "scriptMode": "content"
  },
  "deep": false
}
```

### 响应（包在 envelope 内）
```json
{
  "data": {
    "brief": { ... },
    "examples": {
      "痛点钩子": ["...短句1...", "...短句2..."],
      "购买理由": ["..."],
      "信任背书": ["..."],
      "促销话术": ["..."]
    },
    "golden": {
      "痛点钩子": ["..."],
      "购买理由": ["..."],
      "信任背书": ["..."]
    }
  },
  "request_id": "..."
}
```

> `examples` / `golden` 均按模块名分键；`golden` 即 SKILL 里的「金句库」。

---

## 验证
```bash
# 重启后端后，在服务端本机或浏览器跑一次：
curl -s http://127.0.0.1:8000/api/v1/retrieve \
  -H 'Content-Type: application/json' \
  -d '{"brief":{"targetAudience":"上火牙龈肿痛人群","primarySellingPoint":"清热通便","durationSeconds":30,"scriptMode":"content"}}'
```
- 返回 200 且 `examples` 非空 → 成功。
- 语法自检：`python -m py_compile backend/app/api/routes.py backend/app/schemas/script.py backend/app/services/script_service.py`

---

## （下一步，本次不需要）可选：API Key 鉴权
方案 C 阶段 A 提到「先 API key 后 OAuth2」。如需给 `/retrieve` 加签，可后续在
`backend/app/security.py` 增加一个从 `Authorization: Bearer <key>` 解析的依赖，并挂到该路由，
再在 `config.py` 配置 key 环境变量。本次仅先把检索端点跑通，故不实现。