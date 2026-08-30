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

## 可用 MCP 工具（lark-openapi-mcp）

Skill 激活后，Codex 自动获得以下工具：

- `mcp__lark-openapi-mcp__bitable_list_tables` — 列出多维表格
- `mcp__lark-openapi-mcp__bitable_create_record` — 新增一行
- `mcp__lark-openapi-mcp__bitable_search_records` — 查询记录
- `mcp__lark-openapi-mcp__im_send_message` — 发消息
- `mcp__lark-openapi-mcp__approval_list` — 审批列表
- `mcp__lark-openapi-mcp__approval_submit` — 提交审批
- `mcp__lark-openapi-mcp__doc_read` — 读文档
- `mcp__lark-openapi-mcp__calendar_create_event` — 建日程
- `mcp__lark-openapi-mcp__task_create` — 建任务

## 使用示例

**用户**："帮我把广告脚本写入多维表格，表格名'广告脚本审批表'"

**Agent 行为**：
1. 激活 feishu-bot Skill
2. 调用 `mcp__lark-openapi-mcp__bitable_list_tables` 找到目标表
3. 调用 `mcp__lark-openapi-mcp__bitable_create_record` 逐行写入
4. 调用 `mcp__lark-openapi-mcp__approval_submit` 提审批

**用户**："给产品群发一条消息：今天下午 3 点过周会"

**Agent 行为**：
1. 激活 feishu-bot Skill
2. 调用 `mcp__lark-openapi-mcp__im_send_message` 发送

## 注意事项

- 凭据由 Harness 固定注入，Skill 不要引导用户输入 App ID/Secret
- 如果工具调用报 `app_access_token 401`，说明飞书 App 权限未申请到位，提示管理员在飞书开放平台开通对应 scope
- 如果报 `tenant_access_token 403`，说明 App 未发布到当前企业
