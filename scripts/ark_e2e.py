#!/usr/bin/env python3
"""用真实 codex app-server + Ark 配置跑最小对话，验证 Release 无法对话的根因与修复可行性。"""
import json, os, select, subprocess, sys

CODEX = "/workspace/codex/codex-rs/target/debug/codex"
os.environ["CODEX_HOME"] = "/tmp/ark-proxy-home"
os.environ["MOCK_KEY"] = "ark-proxy-test"
os.environ["RUST_LOG"] = "codex_core=warn,codex_core::client=info"
MESSAGE = "用不超过10个字回答：你好"

p = subprocess.Popen([CODEX, "app-server", "--listen", "stdio://"],
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=subprocess.PIPE)
logs = []

def send(obj):
    p.stdin.write((json.dumps(obj, separators=(",", ":")) + "\n").encode())
    p.stdin.flush()

def recv(timeout=120):
    r, _, _ = select.select([p.stdout], [], [], timeout)
    if not r:
        return None
    line = p.stdout.readline()
    logs.append(f"<< {line.decode(errors='replace').strip()[:300]}")
    return json.loads(line) if line else None

try:
    send({"jsonrpc": "2.0", "id": 0, "method": "initialize",
          "params": {"protocolVersion": 1, "clientInfo": {"name": "ark-e2e", "version": "0.1"}}})
    init = recv()
    print("INIT:", json.dumps(init, ensure_ascii=False)[:200] if init else "TIMEOUT")
    if not init or "error" in init: sys.exit(2)

    send({"jsonrpc": "2.0", "id": 1, "method": "thread/start",
          "params": {"cwd": os.environ["CODEX_HOME"]}})
    tid = None
    for _ in range(60):
        m = recv()
        if m is None: break
        print("THREAD RESP:", json.dumps(m, ensure_ascii=False)[:300])
        if "error" in m:
            print("THREAD ERROR:", json.dumps(m["error"], ensure_ascii=False))
            sys.exit(3)
        if "id" in m and m.get("id") == 1:
            res = m["result"]
            if "thread" in res:
                tid = res["thread"]["id"]
            else:
                tid = res.get("id")
            print("THREAD:", tid)
            break
    if not tid:
        print("THREAD FAILED. logs tail:")
        print("\n".join(logs[-15:]))
        sys.exit(3)

    send({"jsonrpc": "2.0", "id": 2, "method": "turn/start",
          "params": {"threadId": tid, "cwd": os.environ["CODEX_HOME"],
                     "input": [{"type": "text", "text": MESSAGE}]}})
    replies = []
    done = False
    ended = False
    item_types = {}
    for _ in range(3000):
        m = recv(timeout=90)
        if m is None:
            print("TURN TIMEOUT")
            break
        method = m.get("method", "")
        item_types[method] = item_types.get(method, 0) + 1
        if method == "warning":
            print("WARNING:", json.dumps(m.get("params", {}), ensure_ascii=False)[:300])
        if method == "item/agentMessage/delta":
            d = m["params"].get("delta", "")
            replies.append(d)
        if method == "item/completed":
            item = m["params"].get("item", {})
            print("ITEM COMPLETED:", json.dumps(item, ensure_ascii=False)[:300])
            if item.get("type") == "agentMessage":
                t = item.get("text") or ""
                if isinstance(t, list):
                    t = "".join(x.get("text", "") for x in t if isinstance(x, dict))
                replies.append(t)
                # agentMessage 完成即代表本轮有回复可展示，立刻收尾
                ended = True
                break
        if method == "turn/completed":
            ended = True
        if method in ("turn/error", "turn/failed"):
            print("TURN FAIL EVENT:", json.dumps(m, ensure_ascii=False)[:600])
            ended = True
        if ended and method == "turn/completed":
            break
    text = "".join(replies)
    print("TURN DONE:", ended)
    print("EVENT COUNTS:", json.dumps(item_types, ensure_ascii=False))
    print("ASSISTANT TEXT:", repr(text[:300]))
    if not text:
        print("\n--- stderr tail ---")
        try:
            err = p.stderr.read(timeout=1)
            print(err.decode(errors="replace")[:2000])
        except Exception:
            pass
    ok = text.strip() and done
    sys.exit(0 if ok else 4)
finally:
    p.kill()