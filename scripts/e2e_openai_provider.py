#!/usr/bin/env python3
"""T07 单模型打通（OpenAI）端到端验证。

在没有真实 OpenAI 密钥的沙箱里，用 mock Responses 端点模拟「OpenAI 兼容
provider + env_key 鉴权 + responses wire API」这条与内置 `openai` provider
完全相同的机制链路，验证：

1) 单模型配置驱动：config.toml 里 `model_provider` + `model`，thread/start
   不显式传模型/provider 时由 codex 自行解析（等价 `[model] model_provider = "openai"`）。
2) env_key 鉴权：provider 从环境变量 `OPENAI_API_KEY` 取密钥，作为
   `Authorization: Bearer <key>` 头发往端点（内置 openai provider 走同一
   ApiKey 鉴权路径）。
3) 完整 turn 打通：thread/start -> turn/start -> …… -> turn/completed。

前置：文件 `mock_responses_server.py` 与 codex 二进制。

用法: python3 e2e_openai_provider.py
"""
import json
import os
import select
import shutil
import subprocess
import sys
import tempfile
import time

CODEX = os.environ.get("CODEX_BIN", "/workspace/codex/codex-rs/target/debug/codex")
MOCK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mock_responses_server.py")
PORT = 8792
API_KEY = "sk-harness-openai-e2e"
MESSAGE = "请回复一句话即可。"

CONFIG = f"""# T07 单模型打通：模拟内置 openai provider 的鉴权/协议路径
model = "mock-model"
model_provider = "openai-compat"
approval_policy = "never"

[model_providers.openai-compat]
name = "OpenAI-compat"
base_url = "http://127.0.0.1:{PORT}/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
"""


def main():
    # 1) 启动 mock，stdout 定向到文件以便断言 Authorization 头。
    mock_log_path = os.path.join(tempfile.mkdtemp(prefix="harness-openai-log-"), "mock.log")
    mock_log_f = open(mock_log_path, "w")
    mock = subprocess.Popen(
        [sys.executable, MOCK, str(PORT)],
        stdout=mock_log_f, stderr=subprocess.STDOUT,
        text=True, bufsize=1,
    )
    time.sleep(1.0)

    home = tempfile.mkdtemp(prefix="harness-openai-")
    with open(os.path.join(home, "config.toml"), "w") as f:
        f.write(CONFIG)

    env = dict(os.environ)
    env["CODEX_HOME"] = home
    env["OPENAI_API_KEY"] = API_KEY

    p = subprocess.Popen([CODEX, "app-server", "--listen", "stdio://"],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         env=env)

    def send(obj):
        p.stdin.write((json.dumps(obj, separators=(",", ":")) + "\n").encode())
        p.stdin.flush()

    def recv(timeout=10):
        r, _, _ = select.select([p.stdout], [], [], timeout)
        if not r:
            return None
        line = p.stdout.readline()
        return json.loads(line) if line else None

    p.stdin.flush()
    send({"jsonrpc": "2.0", "id": 0, "method": "initialize",
          "params": {"protocolVersion": 1, "clientInfo": {"name": "e2e-openai", "version": "0.1"}}})
    ua = recv()["result"]["userAgent"]
    print("userAgent:", ua, flush=True)

    # 2) thread/start 不传 model/modelProvider -> 由 config.toml 解析（单模型配置驱动）。
    send({"jsonrpc": "2.0", "id": 1, "method": "thread/start", "params": {"cwd": home}})
    tid = None
    deadline = time.time() + 30
    while time.time() < deadline:
        m = recv(timeout=5)
        if m is None:
            continue
        if "id" in m:
            tid = m["result"]["thread"]["id"]
            print("thread/start resolved (config-driven)", json.dumps(m["result"])[:200], flush=True)
            break
        if m.get("method"):
            print("[notification]", m.get("method"), flush=True)
    if not tid:
        p.kill(); mock.kill()
        print("FAIL: config-driven thread/start did not return thread.id", file=sys.stderr)
        return 1

    # 3) turn -> 等待 turn/completed。
    send({"jsonrpc": "2.0", "id": 2, "method": "turn/start",
          "params": {"threadId": tid, "cwd": home,
                     "input": [{"type": "text", "text": MESSAGE, "text_elements": []}]}})

    completed = False
    t0 = time.time()
    while time.time() - t0 < 60 and not completed:
        m = recv(timeout=3)
        if m is None:
            continue
        if m.get("method") == "turn/completed":
            completed = True
    p.stdin.close()
    try:
        p.wait(timeout=2)
    except subprocess.TimeoutExpired:
        p.kill()

    # 4) 收集 mock 输出，断言 Bearer 头来自 OPENAI_API_KEY（先杀 mock 以刷盘）。
    time.sleep(0.3)
    mock.kill()
    mock.wait()
    mock_log_f.close()
    mock_log = open(mock_log_path).read()

    auth_found = f"auth=Bearer {API_KEY}" in mock_log
    print("turn/completed:", completed)
    print("bearer auth (env_key->Authorization):", auth_found)

    shutil.rmtree(home, ignore_errors=True)

    if not completed:
        print("FAIL: turn did not complete", file=sys.stderr)
        return 1
    if not auth_found:
        print("FAIL: expected Authorization: Bearer OPENAI_API_KEY on provider request", file=sys.stderr)
        print(mock_log[-2000:])
        return 1
    print("PASS: T07 openai single-model (config-driven + env_key auth) verified")
    return 0


if __name__ == "__main__":
    sys.exit(main())