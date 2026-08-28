#!/usr/bin/env python3
# T12 飞书 MCP 集成 —— 模拟 lark-openapi-mcp 的 stdio MCP server。
# 实现 2024-11-05 版 MCP 协议（newline-delimited JSON-RPC over stdio），
# 暴露飞书 im 消息 / docx 文档等工具，便于在黑盒 e2e 中验证
# `[mcp_servers.feishu]` 配置契约与「消息/文档操作」工具可调用性。
#
# 用法：仅被 codex 或 e2e 脚本以子进程方式拉起，从 stdin 读请求，写 stdout。
import json
import sys

SERVER_NAME = "mock-lark-openapi-mcp"
SERVER_VERSION = "0.1.0"

TOOLS = [
    {
        "name": "feishu_im_message_create",
        "description": "通过飞书 OpenAPI 发送 IM 消息（对应 /im/v1/messages）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "receive_id_type": {"type": "string", "enum": ["open_id", "user_id", "chat_id"]},
                "receive_id": {"type": "string"},
                "msg_type": {"type": "string", "enum": ["text", "post", "image"]},
                "content": {"type": "string"},
                "text": {"type": "string"},
            },
            "required": ["receive_id", "content"],
        },
    },
    {
        "name": "feishu_im_chat_list",
        "description": "查询会话列表（/im/v1/chats）。",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "feishu_docx_get_document",
        "description": "读取飞书 docx 文档内容（/docx/v1/documents/{id} + blocks）。",
        "inputSchema": {
            "type": "object",
            "properties": {"document_id": {"type": "string"}, "lang": {"type": "string"}},
            "required": ["document_id"],
        },
    },
    {
        "name": "feishu_docx_create_document",
        "description": "创建飞书 docx 文档。",
        "inputSchema": {"type": "object", "properties": {"title": {"type": "string"}}},
    },
]


def call_tool(name, args):
    """按工具名返回模拟的飞书响应（证明 im/docx 操作链路已打通）。"""
    if name == "feishu_im_message_create":
        return {
            "content": [
                {
                    "type": "text",
                    "text": json.dumps({
                        "message_id": "om_mock_0000001",
                        "receive_id": args.get("receive_id"),
                        "msg_type": args.get("msg_type", "text"),
                        "create_time": "1700000000000",
                    }),
                }
            ],
            "isError": False,
        }
    if name == "feishu_im_chat_list":
        return {"content": [{"type": "text", "text": '[{"chat_id":"oc_mock_chat_1","name":"研发群"}]'}], "isError": False}
    if name == "feishu_docx_get_document":
        doc_id = args.get("document_id", "unknown")
        return {
            "content": [
                {"type": "text", "text": json.dumps({"document_id": doc_id, "title": "会议纪要", "content": "第一段：讨论了 T12 飞书集成方案。", "revision_id": 12})}
            ],
            "isError": False,
        }
    if name == "feishu_docx_create_document":
        return {"content": [{"type": "text", "text": json.dumps({"document_id": "doxcn_mock_2", "title": args.get("title", "")})}], "isError": False}
    return {"content": [{"type": "text", "text": f"unknown tool: {name}"}], "isError": True}


def handle(req):
    req_id = req.get("id")
    method = req.get("method")
    params = req.get("params") or {}
    if method == "initialize":
        return {"jsonrpc": "2.0", "id": req_id, "result": {
            "protocolVersion": req.get("params", {}).get("protocolVersion", "2024-11-05"),
            "capabilities": {"tools": {"listChanged": True}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
        }}
    if method == "notifications/initialized":
        return None  # 通知不回包
    if method == "ping":
        return {"jsonrpc": "2.0", "id": req_id, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": TOOLS}}
    if method == "tools/call":
        result = call_tool(params.get("name"), params.get("arguments") or {})
        return {"jsonrpc": "2.0", "id": req_id, "result": result}
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32601, "message": f"method not found: {method}"}}


def main():
    # 简单校验环境注入（模拟 lark-openapi-mcp 依赖飞书凭据）。
    app_id = __import__("os").environ.get("FEISHU_APP_ID", "")
    if not app_id:
        pass  # 允许无凭据启动以便 e2e 验证，正式场景由 codex 注入。
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        resp = handle(req)
        if resp is not None:
            sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()