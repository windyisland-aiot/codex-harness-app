#!/usr/bin/env python3
"""Raw dump of everything codex app-server writes to stdout during an approval turn.

用法: MOCK_KEY=mock CODEX_HOME=<home> python3 e2e_approval_raw.py
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

    def recv(timeout=8):
        r, _, _ = select.select([p.stdout], [], [], timeout)
        if not r:
            return None
        line = p.stdout.readline()
        return json.loads(line) if line else None

    send({"jsonrpc": "2.0", "id": 0, "method": "initialize",
          "params": {"protocolVersion": 1, "clientInfo": {"name": "e2e-raw", "version": "0.1"}}})
    recv()

    send({"jsonrpc": "2.0", "id": 1, "method": "thread/start",
          "params": {"model": "mock-model", "modelProvider": "mock", "cwd": os.getcwd()}})
    tid = None
    t0 = time.time()
    while time.time() - t0 < 20:
        line = recv()
        if line is None:
            continue
        res = line.get("result", {}) if "result" in line else {}
        if "thread" in res and "id" in res["thread"]:
            tid = res["thread"]["id"]
            break
    print("threadId:", tid, flush=True)

    send({"jsonrpc": "2.0", "id": 2, "method": "turn/start",
          "params": {"threadId": tid, "cwd": os.getcwd(),
                     "input": [{"type": "text", "text": MESSAGE, "text_elements": []}]}})

    t0 = time.time()
    while time.time() - t0 < 60:
        r, _, _ = select.select([p.stdout], [], [], 2)
        if not r:
            print("[no-data for 2s]", flush=True)
            continue
        line = p.stdout.readline()
        if not line:
            print("[eof]", flush=True)
            break
        line = line.rstrip(b"\n")
        print("RAW> " + line[:1200].decode("utf-8", "replace"), flush=True)
    p.kill()
    return 0


if __name__ == "__main__":
    sys.exit(main())