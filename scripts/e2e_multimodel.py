#!/usr/bin/env python3
"""T10 多模型切换 e2e：验证 thread/settings/update 使下个 turn 采用新模型生效。

流程：
- 用 harness-config 示例写入一份 mock provider 的 CODEX_HOME
- thread/start(model=mock-model, provider=mock)
- thread/settings/update(model=mock-model-v2)
- 收到 thread/settings/updated 通知，断言 thread_settings.model == mock-model-v2（证明切换下个 turn 生效）
- 随后的 turn/start 完成一轮，确认同一线程可继续对话

用法: CODEX_HOME=<home> MOCK_KEY=mock python3 e2e_multimodel.py
"""
import json
import os
import select
import shutil
import subprocess
import sys
import time

ROOT = "/workspace/codex-harness-app"
CODEX = os.environ.get("CODEX_BIN", "/workspace/codex/codex-rs/target/debug/codex")
HOME = os.environ.get("CODEX_HOME", os.path.join(ROOT, ".codex-t10-home"))


def main():
    shutil.rmtree(HOME, ignore_errors=True)
    os.makedirs(HOME, exist_ok=True)
    subprocess.run(
        ["cargo", "run", "-p", "harness-config", "--example", "write_sample"],
        cwd=ROOT, env=dict(os.environ, CODEX_HOME=HOME), check=True, capture_output=True, text=True,
    )

    mock = subprocess.Popen(
        [sys.executable, os.path.join(ROOT, "scripts/mock_responses_server.py"), "8791"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(0.5)

    p = subprocess.Popen([CODEX, "app-server", "--listen", "stdio://"],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         env=dict(os.environ, CODEX_HOME=HOME, MOCK_KEY="mock"))
    def send(obj):
        p.stdin.write((json.dumps(obj, separators=(",", ":")) + "\n").encode())
        p.stdin.flush()
    def recv(timeout=60):
        r, _, _ = select.select([p.stdout], [], [], timeout)
        return json.loads(p.stdout.readline()) if r else None

    send({"jsonrpc": "2.0", "id": 0, "method": "initialize",
          "params": {"protocolVersion": 1, "clientInfo": {"name": "e2e-multi", "version": "0.1"},
                     "capabilities": {"experimentalApi": True, "requestAttestation": False}}})
    recv()

    send({"jsonrpc": "2.0", "id": 1, "method": "thread/start",
          "params": {"model": "mock-model", "modelProvider": "mock", "cwd": ROOT}})
    tid = None
    for _ in range(40):
        m = recv()
        if m and "id" in m:
            tid = m["result"]["thread"]["id"]
            break
    assert tid, "FAIL: no thread id"
    print("threadId:", tid)

    # 切换模型（下个 turn 生效）
    send({"jsonrpc": "2.0", "id": 2, "method": "thread/settings/update",
          "params": {"threadId": tid, "model": "mock-model-v2"}})

    switched = False
    t0 = time.time()
    while time.time() - t0 < 30 and not switched:
        m = recv(timeout=5)
        if not m or ("result" in m and m.get("method") is None) or "id" in m and "method" not in m:
            # RPC 响应（thread/settings/update 的回执）
            continue
        if m.get("method") == "thread/settings/updated":
            params = m.get("params", {})
            ts = params.get("threadSettings") or params.get("thread_settings") or {}
            print("  thread/settings/updated model =", ts.get("model"))
            if ts.get("model") == "mock-model-v2":
                switched = True
    print("model_switched:", switched)
    if not switched:
        print("FAIL: thread/settings/update did not take effect", file=sys.stderr)
        p.kill()
        mock.kill()
        return 1

    # 随后的 turn 用新模型在同线程继续对话，应能完成
    send({"jsonrpc": "2.0", "id": 3, "method": "turn/start",
          "params": {"threadId": tid, "cwd": ROOT,
                     "input": [{"type": "text", "text": "请继续", "text_elements": []}]}})
    completed = False
    got_text = False
    t0 = time.time()
    while time.time() - t0 < 90 and not completed:
        m = recv(timeout=5)
        if not m:
            continue
        if "result" in m or "error" in m:
            continue
        meth = m.get("method")
        if meth == "item/commandExecution/requestApproval":
            send({"jsonrpc": "2.0", "id": m.get("id"), "result": {"decision": "acceptForSession"}})
        elif meth == "item/agentMessage/delta":
            if "端到端打通成功" in m.get("params", {}).get("delta", ""):
                got_text = True
        elif meth == "turn/completed":
            completed = True
    p.stdin.close()
    try:
        p.wait(timeout=3)
    except subprocess.TimeoutExpired:
        p.kill()
    mock.kill()
    mock.wait()
    print("turn_completed:", completed, "got_text:", got_text)
    if not (completed and got_text):
        print("FAIL: subsequent turn on switched thread did not complete", file=sys.stderr)
        return 1
    print("PASS: T10 multi-model switch (thread/settings/update -> next turn) verified")
    shutil.rmtree(HOME, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())