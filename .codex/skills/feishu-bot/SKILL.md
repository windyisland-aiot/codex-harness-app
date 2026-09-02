---
name: feishu-bot
description: 飞书企业机器人能力集 — 多维表格读写、消息推送、审批查询、文档操作。Harness 内置固定 App，无需额外授权。
short_description: 飞书机器人（Base/消息/审批/文档）
---

# 飞书企业机器人 Skill

当用户涉及飞书相关操作时，自动激活此 Skill。

## 固定凭据

| 变量 | 值 |
|------|----|
| FEISHU_APP_ID | `cli_aa0eb9626ae29bda` |
| FEISHU_APP_SECRET | `6ytcKVZLLnRkk854P3PcqbbFnzPsnK21` |

Harness 启动时会自动将以上凭据注入 codex 子进程环境，**不需要用户手动配置**。

## MCP 服务配置

Codex 启动时自动拉起 `lark-mcp`（官方 npm 包 `@larksuiteoapi/lark-mcp`）：

```
command: lark-mcp
args:    ["mcp", "-t", "preset.default,approval_v4", "-m", "stdio"]
env:     FEISHU_APP_ID, FEISHU_APP_SECRET (由 Harness 注入)
```

## 典型触发词

| 触发词 | 能力 |
|--------|------|
| "飞书" / "Feishu" / "Lark" | 激活 Skill |
| "多维表格" / "Base" / "Bitable" | 读写飞书多维表格 |
| "发消息" / "通知" / "推送" | 给指定用户/群发消息 |
| "审批" / "Approval" | 提交审批 / 查询审批状态 |
| "文档" / "Doc" / "Wiki" | 读取 / 写入飞书文档 |
| "日历" / "会议" / "日程" | 创建会议 / 查询忙闲 |
| "任务" / "Task" / "Todo" | 创建 / 更新飞书任务 |

## 可用 MCP 工具（lark-mcp v0.5.1，preset.default + approval_v4）

工具名格式：`{mcp_server_name}__{tool_name}`，实际调用时用 `tools/call` + `name` 参数。

### 多维表格（Bitable）

| 工具名 | 说明 |
|--------|------|
| `bitable_v1_app_create` | 创建多维表格（返回 app_token + URL） |
| `bitable_v1_appTable_create` | 创建数据表（含字段定义） |
| `bitable_v1_appTable_list` | 列出表 |
| `bitable_v1_appTableField_list` | 列出字段 |
| `bitable_v1_appTableRecord_create` | 新增记录 |
| `bitable_v1_appTableRecord_search` | 查询记录 |
| `bitable_v1_appTableRecord_update` | 更新记录 |

### 审批（Approval）

| 工具名 | 说明 |
|--------|------|
| `approval_v4_approval_create` | 创建审批模板 |
| `approval_v4_approval_get` | 查询审批模板 |
| `approval_v4_instance_create` | 提交审批实例 |
| `approval_v4_instance_list` | 查询审批实例列表 |
| `approval_v4_instance_get` | 查询审批实例详情 |
| `approval_v4_instance_cancel` | 撤销审批 |
| `approval_v4_instance_approve` | 审批通过 |
| `approval_v4_instance_reject` | 审批拒绝 |
| `approval_v4_task_search` | 查询待办任务 |
| `approval_v4_task_approve` | 审批待办 |

### 消息（IM）

| 工具名 | 说明 |
|--------|------|
| `im_v1_chat_create` | 创建群聊 |
| `im_v1_chat_list` | 列出群聊 |
| `im_v1_message_create` | 发送消息（文本/富文本/卡片） |
| `im_v1_message_list` | 拉取消息 |

### 文档（Docx / Drive）

| 工具名 | 说明 |
|--------|------|
| `docx_v1_document_rawContent` | 读取文档纯文本 |
| `drive_v1_permissionMember_create` | 添加文档权限 |

### 联系人

| 工具名 | 说明 |
|--------|------|
| `contact_v3_user_batchGetId` | 通过邮箱/手机号查 user_id |

## 使用示例

**用户**："帮我创建一个多维表格叫'广告脚本审批表'，有标题、主脚本、备选脚本三个字段"

**Agent 行为**：
1. 激活 feishu-bot Skill
2. 调用 `bitable_v1_app_create` 创建 Base → 拿到 app_token
3. 调用 `bitable_v1_appTable_create` 创建数据表（定义 3 个字段）

**用户**："给产品群发一条消息：今天下午 3 点过周会"

**Agent 行为**：
1. 激活 feishu-bot Skill
2. 调用 `contact_v3_user_batchGetId` 查到目标 chat_id
3. 调用 `im_v1_message_create` 发送

**用户**："帮我提交一个审批"

**Agent 行为**：
1. 激活 feishu-bot Skill
2. 调用 `approval_v4_approval_list` 找到目标模板 code
3. 调用 `approval_v4_instance_create` 提交实例 → 返回 instance_code + web_url

## 广告脚本工作流（多 Agent）

```
输入广告 brief
    ↓
[RAG 检索产品知识库] → 提取卖点、目标人群、渠道
    ↓
[LLM 生成主脚本 × 2] → 候选 A / 候选 B
    ↓
[BaseInsert] → bitable_v1_appTableRecord_create 写入多维表格
    ↓
[ApprovalSubmit] → approval_v4_instance_create 提交审批
    ↓
返回审批链接
```

## 注意事项

- 凭据由 Harness 固定注入，Skill 不要引导用户输入 App ID/Secret
- 如果工具调用报 `app_access_token 401`，说明飞书 App 权限未申请到位，提示管理员在飞书开放平台开通对应 scope
- 如果报 `tenant_access_token 403`，说明 App 未发布到当前企业
- lark-mcp 安装命令：`npm install -g @larksuiteoapi/lark-mcp`
