#!/usr/bin/env python3
"""审批链路端到端验证。

流程：
- thread/start -> turn/start
- mock 返回 `exec_command` 升级权限(require_escalated) function_call
- app-server 应发出 `execCommandApproval` 服务器请求(带 command/cwd/reason)
- 客户端回复 `item/commandExecution/requestApproval`(decision=acceptForSession)
- codex 执行命令并把结果回传 mock，mock 返回最终文本
- turn/completed

用法: CODEX_HOME=<approval-home> MOCK_KEY=mock python3 e2e_approval.py
"""
import json
import os
import select
import subprocess
import sys
import time

CODEX = os.environ.get("CODEX_BIN", "/workspace/codex/codex-rs/target/debug/codex")
MESSAGE = "请执行 echo approved-ok"


def main():
    p = subprocess.Popen([CODEX, "app-server", "--listen", "stdio://"],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE)

    def send(obj):
        p.stdin.write((json.dumps(obj, separators=(",", ":")) + "\n").encode())
        p.stdin.flush()

    def recv(timeout=30):
        r, _, _ = select.select([p.stdout], [], [], timeout)
        if not r:
            return None
        line = p.stdout.readline()
        return json.loads(line) if line else None

    send({"jsonrpc": "2.0", "id": 0, "method": "initialize",
          "params": {"protocolVersion": 1, "clientInfo": {"name": "e2e-approval", "version": "0.1"}}})
    recv()

    send({"jsonrpc": "2.0", "id": 1, "method": "thread/start",
          "params": {"model": "mock-model", "modelProvider": "mock", "cwd": os.getcwd()}})
    tid = None
    for _ in range(40):
        m = recv()
        if m is None:
            break
        if "id" in m:
            tid = m["result"]["thread"]["id"]
            break
    if not tid:
        print("FAIL: no threadId")
        p.kill()
        return 1
    print("threadId:", tid)

    send({"jsonrpc": "2.0", "id": 2, "method": "turn/start",
          "params": {"threadId": tid, "cwd": os.getcwd(),
                     "input": [{"type": "text", "text": MESSAGE, "text_elements": []}]}})

    approved = False
    completed = False
    t0 = time.time()
    while time.time() - t0 < 90 and not completed:
        m = recv(timeout=5)
        if m is None:
            continue
        if "result" in m or "error" in m:
            # JSON-RPC 响应（对我们请求的回复），不是服务器请求或通知，跳过。
            continue
        meth = m.get("method")
        if meth in ("item/commandExecution/requestApproval", "execCommandApproval"):
            print(f"[{meth}] received", flush=True)
            print("  params:", json.dumps(m.get("params", {}), ensure_ascii=False)[:400], flush=True)
            req_id = m.get("id")
            send({"jsonrpc": "2.0", "id": req_id, "result": {
                "decision": "acceptForSession",
                "reason": "e2e test"}})
            approved = True
            print("  -> responded acceptForSession", flush=True)
        elif meth:
            print(f"[{meth}]", json.dumps(m.get("params", {}), ensure_ascii=False)[:200], flush=True)
            if meth == "turn/completed":
                st = m.get("params", {}).get("turn", {}).get("status")
                print("  turn status:", st, flush=True)
                completed = True
        else:
            print("[unknown]", json.dumps(m)[:200], flush=True)
    p.stdin.close()
    try:
        p.wait(timeout=2)
    except subprocess.TimeoutExpired:
        p.kill()
    print("approved_request_observed:", approved)
    print("turn_completed:", completed)
    return 0 if (approved and completed) else 1


if __name__ == "__main__":
    sys.exit(main())