#!/usr/bin/env python3
# T12 飞书 MCP 集成端到端（黑盒）：
#  1) 通过 feishu_mcp 示例把 lark-openapi-mcp 注册为 [mcp_servers.feishu]；
#  2) 校验 config.toml 的 env 表 / env_vars / enabled 契约符合 codex；
#  3) 拉起模拟 lark-openapi-mcp 的 MCP server，验证 im 消息 / docx 文档工具可调用。
# 运行：python3 scripts/e2e_feishu_mcp.py [--bin <feishu_mcp 路径>]
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = "/workspace/codex-harness-app"
DEFAULT_BIN = f"{ROOT}/target/debug/examples/feishu_mcp"
MOCK = f"{ROOT}/scripts/mock_lark_openapi_mcp.py"


def run(cli, args):
    out = subprocess.run([cli] + args, capture_output=True, text=True, timeout=30)
    if out.returncode != 0:
        raise RuntimeError(f"feishu_mcp failed ({out.returncode}): {out.stderr}")
    return json.loads(out.stdout.strip())


def send_rpc(proc, req, expect_response=True):
    """向 MCP 子进程写一条 JSON-RPC 请求；期望回包时才读响应。"""
    proc.stdin.write(json.dumps(req) + "\n")
    proc.stdin.flush()
    if not expect_response:
        return None
    line = proc.stdout.readline()
    return json.loads(line) if line.strip() else None


def main():
    cli = sys.argv[sys.argv.index("--bin") + 1] if "--bin" in sys.argv else DEFAULT_BIN
    home = tempfile.mkdtemp(prefix="harness-feishu-e2e-")
    failed = False

    def check(name, ok, detail=""):
        nonlocal failed
        print(f"[{'PASS' if ok else 'FAIL'}] {name}", detail if detail and ok else detail)
        if not ok:
            failed = True

    try:
        # 1) 注册飞书 MCP（命令为模拟 lark-openapi-mcp 的 python 脚本）。
        reg = run(cli, [
            "--home", home,
            "--command", f"python3 {MOCK}",
            "--env", "FEISHU_APP_ID=cli_x1y2",
            "--env", "FEISHU_APP_SECRET=s3cret",
            "--env-var", "FEISHU_USER_ACCESS_TOKEN",
        ])
        check("注册 feishu 成功", reg.get("id") == "feishu", json.dumps(reg))
        check("command 写入", "mock_lark_openapi_mcp" in reg.get("command", ""), reg.get("command", ""))

        # 2) 校验 config.toml 契约（env 表 / env_vars / enabled）。
        raw = open(os.path.join(home, "config.toml")).read()
        check("存在 [mcp_servers.feishu]", "[mcp_servers.feishu]" in raw, raw)
        check("env 写成表", 'FEISHU_APP_ID = "cli_x1y2"' in raw or 'FEISHU_APP_ID="cli_x1y2"' in raw, raw)
        check("env_vars 数组", '"FEISHU_USER_ACCESS_TOKEN"' in raw, raw)

        st = run(cli, ["--home", home, "--status"])
        check("status 回读 registered=true", st.get("registered") is True, json.dumps(st))
        check("status 含 env_keys", any("FEISHU_APP_ID" in e for e in st.get("env", [])), json.dumps(st))

        # 3) 驱动模拟 lark-openapi-mcp 服务器，验证 im / docx 工具调用。
        proc = subprocess.Popen([sys.executable, MOCK], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, text=True)
        init = send_rpc(proc, {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                               "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "harness-e2e", "version": "0.1"}}})
        check("MCP initialize 成功", init and init.get("result", {}).get("serverInfo", {}).get("name") == "mock-lark-openapi-mcp", json.dumps(init or {}))
        send_rpc(proc, {"jsonrpc": "2.0", "id": 2, "method": "notifications/initialized", "params": {}}, expect_response=False)
        # 等待 mock 处理通知后，后续请求/响应严格配对。
        import time; time.sleep(0.05)

        tl = send_rpc(proc, {"jsonrpc": "2.0", "id": 3, "method": "tools/list", "params": {}})
        names = [t["name"] for t in tl["result"]["tools"]]
        check("tools/list 包含 im 消息", "feishu_im_message_create" in names, ",".join(names))
        check("tools/list 包含 docx 文档", "feishu_docx_get_document" in names, ",".join(names))

        # im 消息发送
        im = send_rpc(proc, {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {
            "name": "feishu_im_message_create",
            "arguments": {"receive_id": "ou_mock_1", "msg_type": "text", "content": "hello"},
        }})
        im_txt = im["result"]["content"][0]["text"]
        check("发送 IM 消息返回 message_id", "om_mock_0000001" in im_txt, json.dumps(im))

        # docx 文档读取
        doc = send_rpc(proc, {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {
            "name": "feishu_docx_get_document", "arguments": {"document_id": "doxcn_abc"},
        }})
        doc_payload = json.loads(doc["result"]["content"][0]["text"])
        check("读取 docx 返回正文", doc_payload.get("content", "").startswith("第一段"), json.dumps(doc_payload))
        proc.terminate()
    finally:
        shutil.rmtree(home, ignore_errors=True)

    print("\n" + ("RESULT: PASS" if not failed else "RESULT: FAIL"))
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())