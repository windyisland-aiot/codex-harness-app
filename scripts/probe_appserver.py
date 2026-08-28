#!/usr/bin/env python3
"""codex app-server JSON-RPC probe client.

用途：验证 Codex app-server 的 stdio JSON-RPC 协议（MCP v2 RPC）。
可作为后续 Tauri 后端集成前的协议探测工具。

用法:
  python3 probe_appserver.py <request-json-line> [more...]
  # 每个参数是一个 JSON RPC 请求(json 行)，依序发送，逐个打印响应。
"""
import json
import select
import subprocess
import sys

CODEX_BIN = "/workspace/codex/codex-rs/target/debug/codex"


def run_appserver(requests, config_args=None, listen="stdio://"):
    argv = [CODEX_BIN, "app-server", "--listen", listen]
    for cfg in (config_args or []):
        argv.append("-c")
        argv.append(cfg)
    proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE)

    def read_message(timeout=30):
        r, _, _ = select.select([proc.stdout], [], [], timeout)
        if not r:
            return None
        line = proc.stdout.readline()
        return line.decode() if line else None

    # 先发 initialize
    init = {"jsonrpc": "2.0", "id": 0, "method": "initialize",
            "params": {"protocolVersion": 1, "clientInfo": {"name": "probe", "version": "0.0.1"}}}
    proc.stdin.write((json.dumps(init) + "\n").encode())
    proc.stdin.flush()

    resp = read_message()
    print("[init]", json.dumps(json.loads(resp), ensure_ascii=False) if resp else "TIMEOUT")

    for i, raw in enumerate(requests):
        req = json.loads(raw)
        req_id = req.get("id")
        print(f"[snd:{req.get('method')}] {raw}")
        proc.stdin.write((raw + "\n").encode())
        proc.stdin.flush()
        # 循环读取，跳过 server-initiated 通知，直到拿到匹配当前请求 id 的响应
        resp = None
        while True:
            line = read_message()
            if line is None:
                break
            try:
                obj = json.loads(line)
            except Exception:
                print("[raw]", line)
                continue
            method = obj.get("method")
            if method:
                # server-initiated 通知 / server request
                kind = "notify" if obj.get("jsonrpc") is None else "srv_req"
                print(f"[{kind}:{method}] {json.dumps(obj.get('params', {}), ensure_ascii=False)[:400]}")
                continue
            if obj.get("id") == req_id:
                resp = obj
                break
            # 其它响应(非当前 id)打印后继续
            print("[other-resp]", json.dumps(obj, ensure_ascii=False)[:300])
        print(f"[rcv:{req.get('method', '')}] {json.dumps(resp, ensure_ascii=False) if resp else 'TIMEOUT'}")

    proc.stdin.close()
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        proc.kill()


if __name__ == "__main__":
    run_appserver(sys.argv[1:])