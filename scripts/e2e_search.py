#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""T15 联网搜索端到端测试。

驱动 search_cli 示例 + 本地 mock Tavily HTTP 服务验证全链路：
  1. execute 指令对 mock 的 `/search` 发起请求并规整结果（title/url/score/content）；
  2. 空 url 的结果被丢弃；
  3. 上游返回非 2xx（如 429）时，CLI 报出明确 HTTP 错误；
  4. mcp-config 指令生成 `[mcp_servers.tavily|serper]` 配置（command/args/env/env_vars）。

运行：python3 scripts/e2e_search.py
"""
import json
import os
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

CARGO = os.environ.get("CARGO", "cargo")
CRATE = "harness-search"
EXE = os.path.join("target", "debug", "examples", "search_cli" + (".exe" if os.name == "nt" else ""))

passed = []
failed = []


def check(name, cond, detail=""):
    if cond:
        passed.append(name)
        print(f"  ✅ {name}")
    else:
        failed.append(name)
        print(f"  ❌ {name}  {detail}")


def ensure_built():
    if not os.path.exists(EXE):
        subprocess.run(
            [CARGO, "build", "-p", CRATE, "--example", "search_cli"],
            check=True, capture_output=True,
        )


class TavilyMock(BaseHTTPRequestHandler):
    """极简 Tavily /search mock：按收到请求头/体动态返回结果或错误。"""

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode("utf-8")
        req = json.loads(body) if body else {}
        if req.get("query") == "trigger-429":
            payload = json.dumps({"detail": "rate limit"}).encode()
            self._send(429, payload)
            return
        results = [
            {
                "title": "Rust SQLite 指南",
                "url": "https://example.org/rust-sqlite",
                "score": 0.92,
                "content": "在 Rust 中使用 SQLite 的实战指南。",
            },
            {"title": "void", "url": "", "score": 0.3, "content": "应被丢弃"},
        ]
        payload = json.dumps(
            {"query": req.get("query", ""), "results": results}
        ).encode()
        self._send(200, payload)

    def _send(self, code, payload):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *a):  # 静默
        pass


def start_mock():
    srv = HTTPServer(("127.0.0.1", 0), TavilyMock)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv, srv.server_address[1]


def stop(srv):
    srv.shutdown()


def run_cli(*args):
    r = subprocess.run([EXE, *args], capture_output=True, text=True)
    out = None
    if r.stdout.strip():
        try:
            out = json.loads(r.stdout)
        except json.JSONDecodeError:
            out = r.stdout.strip()
    return r.returncode, out, r.stdout, r.stderr


def main():
    tmp = tempfile.mkdtemp(prefix="harness-search-e2e-")
    srv, port = start_mock()
    base = f"http://127.0.0.1:{port}"
    print(f"mock Tavily @ {base}")

    print("== 1. execute 成功解析 ==")
    rc, out, _, _ = run_cli("execute", "rust sqlite", "--base-url", base, "--key", "k123")
    check("退出码 0", rc == 0, str(rc))
    check("query 回显", out and out.get("query") == "rust sqlite", str(out))
    results = out.get("results", []) if isinstance(out, dict) else []
    check("命中等条数（丢弃空 url）", len(results) == 1, str(results))
    r0 = results[0]
    check("title 正确", r0["title"] == "Rust SQLite 指南", str(r0))
    check("url 正确", r0["url"] == "https://example.org/rust-sqlite", str(r0))
    check("score 正确", r0["score"] == 0.92, str(r0))
    check("content 非空", bool(r0["content"]), str(r0))

    print("== 2. 上游 429 报出 HTTP 错误 ==")
    rc, out, stdout, _ = run_cli("execute", "trigger-429", "--base-url", base, "--key", "k")
    check("退出码非 0", rc != 0, str(rc))
    check("stdout 含 __HTTP_ERROR__", "__HTTP_ERROR__" in stdout, stdout)
    check("错误含状态码 429", "429" in stdout, stdout)

    print("== 3. mcp-config 生成 ==")
    rc, out, _, _ = run_cli("mcp-config", "tavily", "abc")
    check("退出码 0", rc == 0, str(rc))
    check("id = tavily", out["id"] == "tavily", str(out))
    check("command = npx", out["command"] == "npx", str(out))
    check("args 指向 tavily-mcp", out["args"] == ["-y", "tavily-mcp@latest"], str(out))
    check("env 注入 TAVILY_API_KEY", out["env"] == ["TAVILY_API_KEY=abc"], str(out))
    check("env_vars 透传", out["env_vars"] == ["TAVILY_API_KEY"], str(out))

    rc, out, _, _ = run_cli("mcp-config", "serper")
    check("serper 未传 key → env 空", out["env"] == [], str(out))
    check("serper env_vars 透传", out["env_vars"] == ["SERPER_API_KEY"], str(out))
    check("serper id", out["id"] == "serper", str(out))

    print("\n结果：通过 %d，失败 %d" % (len(passed), len(failed)))
    stop(srv)
    import shutil
    shutil.rmtree(tmp, ignore_errors=True)
    if failed:
        sys.exit(1)
    print("✅ T15 联网搜索端到端全部通过")


if __name__ == "__main__":
    ensure_built()
    main()