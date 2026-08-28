#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""T13 飞书 OAuth 端到端测试。

启动一个本地 mock「飞书」HTTP 服务，用 cargo 编译并驱动 oauth_cli 示例，验证：
  - app_access_token 成功与业务错误两种路径；
  - 授权链接生成（参数编码、state）；
  - 授权码 exchange 换取 user_access_token + refresh_token；
  - refresh_token 刷新（token 滚动）与失败路径。

运行（在仓库根目录）：
  python3 scripts/e2e_feishu_oauth.py [--keep-errors]
"""
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

CARGO = os.environ.get("CARGO", "cargo")
CRATE = "harness-feishu-oauth"
EXAMPLE = "oauth_cli"

passed = []
failed = []


def check(name, cond, detail=""):
    if cond:
        passed.append(name)
        print(f"  ✅ {name}")
    else:
        failed.append(name)
        print(f"  ❌ {name}  {detail}")


def srv_exe(name):
    p = os.path.join(
        "target", "debug", "examples",
        "oauth_cli" + (".exe" if os.name == "nt" else ""),
    )
    return p


def call_cli(*args):
    exe = srv_exe(EXAMPLE)
    if not os.path.exists(exe):
        subprocess.run([CARGO, "build", "-p", CRATE, "--example", EXAMPLE], check=True)
    r = subprocess.run([exe, *args], capture_output=True, text=True)
    return r.returncode, r.stdout.strip(), r.stderr.strip()


# --- mock 飞书 HTTP 服务 ---
class FeishuHandler(BaseHTTPRequestHandler):
    def _send(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        self.server.received.append((self.path, body))
        if self.path.endswith("app_access_token/internal"):
            if body.get("app_secret") == "badsecret":
                self._send({"code": 99991663, "msg": "app not found"})
            else:
                self._send({"code": 0, "msg": "ok", "app_access_token": "appTok_ok", "expire": 7200})
        elif self.path.endswith("oidc/access_token"):
            if body.get("code") == "badcode":
                self._send({"code": 99991668, "msg": "invalid code"})
            else:
                self._send({"code": 0, "msg": "ok", "access_token": "userTok_1", "refresh_token": "refTok_1", "expires_in": 7200, "scope": "im:message", "token_type": "Bearer"})
        elif self.path.endswith("oidc/refresh_access_token"):
            if body.get("refresh_token") == "dead":
                self._send({"code": 99991742, "msg": "refresh token invalid"})
            else:
                self._send({"code": 0, "msg": "ok", "access_token": "userTok_2", "refresh_token": "refTok_2", "expires_in": 3600, "scope": "im:message,docx:document"})
        else:
            self._send({"code": 99999999, "msg": f"no route {self.path}"})

    def log_message(self, *a):
        pass


def start_mock():
    server = HTTPServer(("127.0.0.1", 0), FeishuHandler)
    server.received = []
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return f"http://127.0.0.1:{server.server_address[1]}", server


def main():
    base, server = start_mock()
    app = ["--app-id", "cli_e2e", "--base-url", base]

    print("== 1. app_access_token ==")
    rc, out, err = call_cli(*app, "--app-secret", "goodsecret", "app-token")
    d = json.loads(out)
    check("app-token 成功返回 token", rc == 0 and d.get("ok") is True and d["token"] == "appTok_ok", out + err)

    print("== 2. app_access_token 业务错误 ==")
    rc, out, err = call_cli(*app, "--app-secret", "badsecret", "app-token")
    check("app-token 业务错误回传 code", rc != 0 and "99991663" in err, err)

    print("== 3. 授权链接参数编码 ==")
    rc, out, err = call_cli(*app, "--app-secret", "s", "--redirect-uri", "https://ex.com/cb?a=1", "auth-url", "--state", "abc 123")
    u = json.loads(out)["url"]
    check("授权链接包含 app_id", rc == 0 and "app_id=cli_e2e" in u, u)
    check("授权链接 state 编码", "state=abc%20123" in u, u)
    check("授权链接 redirect_uri 编码", "redirect_uri=https%3A%2F%2Fex.com%2Fcb%3Fa%3D1" in u, u)

    print("== 4. exchange 换 token ==")
    rc, out, err = call_cli(*app, "--app-secret", "s", "exchange", "goodcode")
    b = json.loads(out)
    check("exchange 返回 user token", rc == 0 and b["access_token"] == "userTok_1", out + err)
    check("exchange 返回 refresh token", b["refresh_token"] == "refTok_1", out)
    check("exchange 过期时间合理", b["exp_ts"] > 0 and b["exp_ts"] != (1 << 63) - 1, str(b["exp_ts"]))
    check("exchange 默认 token_type Bearer", b["token_type"] == "Bearer", out)

    print("== 5. exchange 失败 ==")
    rc, out, err = call_cli(*app, "--app-secret", "s", "exchange", "badcode")
    check("exchange 业务错误回传", rc != 0 and "99991668" in err, err)

    print("== 6. refresh 滚动 token ==")
    rc, out, err = call_cli(*app, "--app-secret", "s", "refresh", "refTok_1")
    b = json.loads(out)
    check("refresh 返回新 token", rc == 0 and b["access_token"] == "userTok_2" and b["refresh_token"] == "refTok_2", out + err)

    print("== 7. refresh 失败 ==")
    rc, out, err = call_cli(*app, "--app-secret", "s", "refresh", "dead")
    check("refresh 业务错误回传", rc != 0 and "99991742" in err, err)

    server.shutdown()
    print(f"\n结果：通过 {len(passed)}，失败 {len(failed)}")
    if failed:
        sys.exit(1)
    print("✅ T13 飞书 OAuth 端到端全部通过")


if __name__ == "__main__":
    main()