#!/usr/bin/env python3
"""T09 配置面板 e2e：验证 harness-config 写出的 config.toml 能被 codex app-server 直接消费。

流程：
- 用 harness-config 示例写入一份含 mock provider + approval_policy=on-request 的 CODEX_HOME
- 以该 CODEX_HOME 启动 codex app-server
- thread/start 时不传 model/modelProvider（由 codex 从 config.toml 解析默认）
- turn/start 走 mock 服务器完成一轮，确认拿到完整文本与 turn/completed
- 证明面板「写config.toml → 重启app-server → 配置生效」闭环

用法: CODEX_HOME=<home> MOCK_KEY=mock python3 e2e_config.py
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
HOME = os.environ.get("CODEX_HOME", os.path.join(ROOT, ".codex-t09-home"))
MESSAGE = "你好，请回复确认配置有效"

import urllib.request

def main():
    # 1) 清空并重新写入 config.toml
    shutil.rmtree(HOME, ignore_errors=True)
    os.makedirs(HOME, exist_ok=True)
    env = dict(os.environ, CODEX_HOME=HOME)
    subprocess.run(
        ["cargo", "run", "-p", "harness-config", "--example", "write_sample"],
        cwd=ROOT, env=env, check=True, capture_output=True, text=True,
    )
    cfg_path = os.path.join(HOME, "config.toml")
    print("=== generated config.toml ===")
    print(open(cfg_path).read())
    raw = open(cfg_path).read()
    assert 'model = "mock-model"' in raw
    assert 'model_provider = "mock"' in raw
    assert 'base_url = "http://127.0.0.1:8791/v1"' in raw
    assert 'approval_policy = "on-request"' in raw

    # 2) 启动 mock 服务器（子进程）
    mock = subprocess.Popen(
        [sys.executable, os.path.join(ROOT, "scripts/mock_responses_server.py"), "8791"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(0.5)

    # 3) 启动 codex app-server，并验证 config 驱动默认 model provider
    p = subprocess.Popen([CODEX, "app-server", "--listen", "stdio://"],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         env=dict(os.environ, CODEX_HOME=HOME, MOCK_KEY="mock"))
    def send(obj):
        p.stdin.write((json.dumps(obj, separators=(",", ":")) + "\n").encode())
        p.stdin.flush()
    def recv(timeout=30):
        r, _, _ = select.select([p.stdout], [], [], timeout)
        return json.loads(p.stdout.readline()) if r else None

    send({"jsonrpc": "2.0", "id": 0, "method": "initialize",
          "params": {"protocolVersion": 1, "clientInfo": {"name": "e2e-cfg", "version": "0.1"}}})
    recv()

    # thread/start 不传 model/modelProvider -> 由 config.toml 解析
    send({"jsonrpc": "2.0", "id": 1, "method": "thread/start", "params": {"cwd": ROOT}})
    tid = None
    for _ in range(40):
        m = recv()
        if m and "id" in m:
            tid = m["result"]["thread"]["id"]
            break
    assert tid, "FAIL: thread/start did not return thread id"
    print("threadId:", tid, "(resolved default provider from config.toml)")

    send({"jsonrpc": "2.0", "id": 2, "method": "turn/start",
          "params": {"threadId": tid, "cwd": ROOT,
                     "input": [{"type": "text", "text": MESSAGE, "text_elements": []}]}})

    got_text = False
    completed = False
    t0 = time.time()
    while time.time() - t0 < 90 and not completed:
        m = recv(timeout=5)
        if not m:
            continue
        if "result" in m or "error" in m:
            continue  # RPC 响应，跳过
        meth = m.get("method")
        if meth == "item/commandExecution/requestApproval":
            print("  approval observed, acceptForSession", flush=True)
            send({"jsonrpc": "2.0", "id": m.get("id"), "result": {"decision": "acceptForSession"}})
        elif meth == "item/agentMessage/delta":
            d = m.get("params", {}).get("delta", "")
            if "端到端打通成功" in d:
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

    print("completed:", completed)
    print("got_final_text:", got_text)
    if not (completed and got_text):
        print("FAIL: turn did not complete via config-driven default provider", file=sys.stderr)
        return 1
    print("PASS: T09 config write/read -> codex default provider resolution verified")
    shutil.rmtree(HOME, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())