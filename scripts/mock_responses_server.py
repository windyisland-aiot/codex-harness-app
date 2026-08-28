#!/usr/bin/env python3
"""本地 mock OpenAI Responses API 服务器。

用途：在没有真实模型密钥时，模拟一个 OpenAI 兼容 `POST /v1/responses`
端点（SSE 流式），用于打通 Codex app-server 的完整 agent turn
(thread/start -> turn/start -> 流式事件 -> turn/completed)。
后接可选的工具调用循环：当请求里 codex 声明了 tools，mock 先返回一次
function_call(echo 工具)，收到工具结果后再返回最终文本——用来验证
tool-calling 与审批链路。

用法: python3 mock_responses_server.py [port]
默认端口 8791。
"""
import json
import os
import sys
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8791
MODEL = "mock-model"


def sse_event(event, data):
    return f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"


def _ev(name, extra):
    return (name, {"type": name, **extra})


def _snapshot(resp_id):
    return {"id": resp_id, "object": "response", "status": "in_progress", "model": MODEL}


def _usage():
    details = {"cached_tokens": 0, "cache_write_tokens": 0}
    return {"input_tokens": 1, "input_tokens_details": details, "output_tokens": 3,
            "output_tokens_details": None, "total_tokens": 4}


def build_completion_stream(resp_id):
    """一次性返回固定文本消息的 SSE 流。

    关键点：每个 data 负载顶层必须含 "type" 字段(与事件名一致)，codex 的
    SSE 解析器(codex-api/src/sse/responses.rs)按它分发。
    """
    msg_id = "msg_" + uuid.uuid4().hex[:12]
    text = "|||COMPLETION_PATH_98765||| 这是端到端打通成功。"
    snapshot = _snapshot(resp_id)
    ev = _ev

    events = [
        ev("response.created", {"response": {**snapshot, "status": "in_progress"}, "sequence_number": 1}),
        ev("response.in_progress", {"response": snapshot, "sequence_number": 2}),
        ev("response.output_item.added", {
            "response": snapshot, "sequence_number": 3, "output_index": 0,
            "item": {"id": msg_id, "type": "message", "status": "in_progress", "role": "assistant", "content": []},
        }),
        ev("response.content_part.added", {
            "response": snapshot, "sequence_number": 4, "item_id": msg_id, "output_index": 0,
            "content_index": 0, "part": {"type": "output_text", "text": "", "annotations": []},
        }),
    ]
    half = len(text) // 2 + 1
    for i, seg in enumerate([text[:half], text[half:]]):
        events.append(ev("response.output_text.delta", {
            "response": snapshot, "sequence_number": 5 + i, "item_id": msg_id,
            "output_index": 0, "content_index": 0, "delta": seg,
        }))
    events += [
        ev("response.output_text.done", {
            "response": snapshot, "sequence_number": 6, "item_id": msg_id, "output_index": 0,
            "content_index": 0, "text": text,
        }),
        ev("response.output_item.done", {
            "response": snapshot, "sequence_number": 7, "output_index": 0,
            "item": {"id": msg_id, "type": "message", "status": "completed", "role": "assistant",
                     "content": [{"type": "output_text", "text": text, "annotations": []}]},
        }),
        ev("response.completed", {
            "response": {**snapshot, "status": "completed", "usage": _usage()},
            "sequence_number": 8,
        }),
    ]
    return events


def build_escalated_exec_command_stream(resp_id, call_id, cmd, workdir):
    """返回一个 `exec_command` 升级权限(require_escalated)的 function_call。

    用于触发 codex 的 execCommandApproval 审批请求链路。
    与 codex 官方测试(create_escalated_command_execution_sse_response)一致，
    仅 3 个事件：response.created -> output_item.done(function_call) -> completed。
    """
    snapshot = _snapshot(resp_id)
    ev = _ev
    tool_call_arguments = json.dumps({
        "cmd": cmd,
        "workdir": workdir,
        "yield_time_ms": 5000,
        "sandbox_permissions": "require_escalated",
        "justification": "Test approval request.",
    }, separators=(",", ":"))
    e = [
        ev("response.created", {"response": {"id": resp_id}}),
        ev("response.output_item.done", {
            "response": snapshot, "sequence_number": 2, "output_index": 0,
            "item": {"id": call_id, "type": "function_call", "status": "completed",
                     "name": "exec_command", "call_id": call_id, "arguments": tool_call_arguments},
        }),
        ev("response.completed", {
            "response": {**snapshot, "status": "completed", "usage": _usage()},
            "sequence_number": 3,
        }),
    ]
    return e


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        body = json.loads(self.rfile.read(length) or b"{}") if length else {}
        print(f"[mock] POST {self.path} model={body.get('model')} has_input={bool(body.get('input'))} "
              f"tools={len(body.get('tools') or [])}", flush=True)

        if self.path.rstrip("/").endswith("/v1/responses"):
            resp_id = "resp_" + uuid.uuid4().hex[:16]
            input_items = body.get("input") or []
            has_tool_result = any(
                isinstance(i, dict) and i.get("type") == "function_call_output"
                for i in input_items
            )
            print(f"[mock] has_tool_result={has_tool_result} n_input_items={len(input_items)} "
                  f"input_types={[i.get('type') if isinstance(i, dict) else type(i).__name__ for i in input_items]}", flush=True)
            if has_tool_result:
                # codex 已把工具执行结果回传，返回最终文本，结束本轮。
                events = build_completion_stream(resp_id)
            else:
                # 首次调用：返回 `exec_command` 升级权限调用，触发审批链路。
                call_id = "call_" + uuid.uuid4().hex[:16]
                workdir = body.get("cwd") or ""
                cmd = "echo approved-ok; " + ("echo hi > ok.txt" if os.name != "nt"
                                              else "echo hi > ok.txt")
                events = build_escalated_exec_command_stream(resp_id, call_id, cmd, workdir)
                print(f"[mock] escalated exec_command: {cmd}", flush=True)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache, no-transform")
            self.send_header("Connection", "close")
            self.end_headers()
            for event, data in events:
                self.wfile.write(sse_event(event, data).encode())
                self.wfile.flush()
                time.sleep(0.03)
            return

        self.send_response(404)
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(json.dumps({"error": "not found"}).encode())

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(json.dumps({"object": "list", "data": []}).encode())


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[mock] responses server listening on 127.0.0.1:{PORT}", flush=True)
    server.serve_forever()