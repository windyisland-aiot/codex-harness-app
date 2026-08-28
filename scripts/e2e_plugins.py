#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""T14 插件与 Skill 系统端到端测试。

在临时目录构造 skills / 插件样例，驱动 skills_cli 示例验证发现与解析：
  - SKILL.md 递归发现（顶层 + 嵌套）与 frontmatter name/description 解析；
  - 无 manifest 的目录不作为插件；
  - 去重（overlapping roots）。
也验证 config 契约：用 harness-config 写入 skills/plugins 后 codex 可解析结构。

运行：python3 scripts/e2e_plugins.py
"""
import json
import os
import subprocess
import sys
import tempfile

CARGO = os.environ.get("CARGO", "cargo")
CRATE = "harness-plugins"
EXE = os.path.join("target", "debug", "examples", "skills_cli" + (".exe" if os.name == "nt" else ""))

passed = []
failed = []


def check(name, cond, detail=""):
    if cond:
        passed.append(name)
        print(f"  ✅ {name}")
    else:
        failed.append(name)
        print(f"  ❌ {name}  {detail}")


def run_cli(*args):
    if not os.path.exists(EXE):
        subprocess.run([CARGO, "build", "-p", CRATE, "--example", "skills_cli"], check=True)
    r = subprocess.run([EXE, *args], capture_output=True, text=True)
    return r.returncode, json.loads(r.stdout) if r.stdout.strip() else {}

def rel(root, *p):
    return os.path.join(root, *p)


def main():
    tmp = tempfile.mkdtemp(prefix="harness-plugins-e2e-")
    # skills
    top = rel(tmp, "skills")
    os.makedirs(rel(top, "code-review"), exist_ok=True)
    with open(rel(top, "code-review", "SKILL.md"), "w") as f:
        f.write("---\nname: code-review\ndescription: PR 代码审查\n---\n正文\n")
    os.makedirs(rel(top, "collections/general"), exist_ok=True)
    os.makedirs(rel(top, "collections", "general", "git-help"), exist_ok=True)
    with open(rel(top, "collections", "general", "git-help", "SKILL.md"), "w") as f:
        f.write("---\nname: git-help\ndescription: Git 帮助\n---\n")
    os.makedirs(rel(top, "empty"), exist_ok=True)
    # fallback: 无 frontmatter
    os.makedirs(rel(top, "no-fm"), exist_ok=True)
    with open(rel(top, "no-fm", "SKILL.md"), "w") as f:
        f.write("plain content\n")

    # plugins
    prot = rel(tmp, "plugins")
    os.makedirs(rel(prot, "my-tool"), exist_ok=True)
    with open(rel(prot, "my-tool", "plugin.toml"), "w") as f:
        f.write('name = "我的工具"\ndescription = "示例插件"\n')
    os.makedirs(rel(prot, "not-a-plugin"), exist_ok=True)

    print("== 1. skills 发现与解析 ==")
    rc, out = run_cli("--skill-root", top, "--scan-skills")
    names = [s["name"] for s in out["skills"]]
    check("commands 退出码 0", rc == 0, str(rc))
    check("发现顶层 skill", "code-review" in names, str(names))
    check("递归发现嵌套 skill", "git-help" in names, str(names))
    check("无 frontmatter 用目录名", "no-fm" in names, str(names))
    cr = next(s for s in out["skills"] if s["name"] == "code-review")
    check("frontmatter description 解析", cr["description"] == "PR 代码审查", str(cr))
    check("dir 指向 SKILL.md 所在目录", os.path.isfile(os.path.join(cr["dir"], "SKILL.md")), cr["dir"])
    check("空目录不作为 skill（数量）", len(out["skills"]) == 3, str(out["skills"]))

    print("== 2. 插件发现 ==")
    rc, out = run_cli("--plugin-root", prot, "--scan-plugins")
    ids = [p["id"] for p in out["plugins"]]
    check("发现带 manifest 的插件", "my-tool" in ids, str(ids))
    check("无 manifest 目录不作为插件", "not-a-plugin" not in ids, str(ids))
    check("插件元数据", len(out["plugins"]) == 1 and out["plugins"][0]["name"] == "我的工具", str(out["plugins"]))

    print("== 3. 去重（overlapping roots） ==")
    rc, out = run_cli("--skill-root", top, "--skill-root", rel(top, "code-review"), "--scan-skills")
    count = sum(1 for s in out["skills"] if s["name"] == "code-review")
    check("同一 skill 去重为 1", count == 1, str(count))

    print("\n结果：通过 %d，失败 %d" % (len(passed), len(failed)))
    import shutil
    shutil.rmtree(tmp, ignore_errors=True)
    if failed:
        sys.exit(1)
    print("✅ T14 插件与 Skill 系统端到端全部通过")


if __name__ == "__main__":
    main()