#!/usr/bin/env python3
# T11 模型路由端到端（黑盒）：通过 router_cli 示例二进制验证路由决策。
# 运行：python3 scripts/e2e_router.py [--bin <router_cli 路径>]
import json
import subprocess
import sys

ROOT = "/workspace/codex-harness-app"
DEFAULT_BIN = f"{ROOT}/target/debug/examples/router_cli"


def route(cli, prompt, **kw):
    args = [cli, prompt]
    if kw.get("sensitive"):
        args.append("--sensitive")
    if "max_cost" in kw:
        args += ["--max-cost", str(kw["max_cost"])]
    if "ctx" in kw:
        args += ["--ctx", str(kw["ctx"])]
    if "task" in kw:
        args += ["--task", kw["task"]]
    out = subprocess.run(args, capture_output=True, text=True, timeout=30)
    if out.returncode != 0:
        raise RuntimeError(f"router_cli failed: {out.stderr}")
    return json.loads(out.stdout.strip())


def check(cli):
    cases = [
        # (prompt, kwargs, expected_provider, expected_model)
        ("请实现用户登录接口", {}, "openai", "gpt-4.1"),
        ("帮我 review 这段代码", {}, "deepseek", "deepseek-reasoner"),
        ("处理财务报表的机密数据", {"sensitive": True}, "deepseek", "deepseek-reasoner"),
        ("帮我写一份使用说明文档", {}, "deepseek", "deepseek-chat"),
        ("随便聊聊", {"max_cost": 0.01}, "deepseek", "deepseek-chat"),
        ("长上下文数据任务", {"ctx": 200_000, "task": "dataAnalysis"}, "openai", "gpt-4.1"),
    ]
    passed = 0
    for prompt, kw, prov, model in cases:
        d = route(cli, prompt, **kw)
        ok = (d["provider"], d["model"]) == (prov, model)
        marker = "PASS" if ok else "FAIL"
        print(f"[{marker}] {prompt}{kw} -> {d['provider']}/{d['model']} (reason: {d['reason']})")
        if ok:
            passed += 1
        else:
            print(f"       expected {prov}/{model}")
    total = len(cases)
    print(f"\n{passed}/{total} cases passed")
    return passed == total


if __name__ == "__main__":
    cli = sys.argv[sys.argv.index("--bin") + 1] if "--bin" in sys.argv else DEFAULT_BIN
    sys.exit(0 if check(cli) else 1)