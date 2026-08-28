#!/usr/bin/env python3
"""端到端最小对话验证：thread/start -> turn/start -> 流式事件 -> turn/completed。

前置：
- mock_responses_server.py 已启动(默认 8791)
- codex 配置指向 mock (CODEX_HOME/.codex-test 或 ~/.codex)，model_provider=mock
- 环境变量 CODEX_HOME, MOCK_KEY

用法: python3 e2e_minimal_turn.py
"""
import json
import os
import select
import subprocess
import sys
import time

CODEX = os.environ.get("CODEX_BIN", "/workspace/codex/codex-rs/target/debug/codex")
MESSAGE = "你好，请回复一句话。"


def main():
    p = subprocess.Popen([CODEX, "app-server", "--listen", "stdio://"],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE)

    def send(obj):
        p.stdin.write((json.dumps(obj, separators=(",", ":")) + "\n").encode())
        p.stdin.flush()

    def recv(timeout=15):
        r, _, _ = select.select([p.stdout], [], [], timeout)
        if not r:
            return None
        line = p.stdout.readline()
        return json.loads(line) if line else None

    send({"jsonrpc": "2.0", "id": 0, "method": "initialize",
          "params": {"protocolVersion": 1, "clientInfo": {"name": "e2e-min", "version": "0.1"}}})
    agent = recv()["result"]["userAgent"]
    print("userAgent:", agent)

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
    print("threadId:", tid)
    if not tid:
        p.kill()
        return 1

    send({"jsonrpc": "2.0", "id": 2, "method": "turn/start",
          "params": {"threadId": tid, "cwd": os.getcwd(),
                     "input": [{"type": "text", "text": MESSAGE, "text_elements": []}]}})

    completed = False
    t0 = time.time()
    while time.time() - t0 < 45 and not completed:
        m = recv(timeout=3)
        if m is None:
            continue
        meth = m.get("method")
        if meth:
            par = m.get("params", {})
            print(f"[{meth}] {json.dumps(par, ensure_ascii=False)[:220]}")
            if meth == "turn/completed":
                completed = True
        else:
            print("[resp]", json.dumps(m)[:160])
    p.stdin.close()
    try:
        p.wait(timeout=2)
    except subprocess.TimeoutExpired:
        p.kill()
    print("turn/completed:", completed)
    return 0 if completed else 1


if __name__ == "__main__":
    sys.exit(main())