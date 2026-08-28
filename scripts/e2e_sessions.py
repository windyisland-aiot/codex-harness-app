#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""T16 会话持久化端到端测试。

驱动 sessions_cli 示例验证 SQLite 会话存储全链路：
  1. 建会话 + 追加消息 + upsert 覆写；
  2. get 按序恢复（含覆写后的文本）；
  3. list 按最近更新倒序；
  4. search 按标题 / 内容命中；
  5. rename / delete；
  6. 重开后数据仍在（持久化）。

运行：python3 scripts/e2e_sessions.py
"""
import json
import os
import subprocess
import sys
import tempfile

CARGO = os.environ.get("CARGO", "cargo")
CRATE = "harness-sessions"
EXE = os.path.join("target", "debug", "examples", "sessions_cli" + (".exe" if os.name == "nt" else ""))

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
            [CARGO, "build", "-p", CRATE, "--example", "sessions_cli"],
            check=True, capture_output=True,
        )


def run_cli(*args):
    r = subprocess.run([EXE, *args], capture_output=True, text=True)
    out = None
    if r.stdout.strip():
        try:
            out = json.loads(r.stdout)
        except json.JSONDecodeError:
            out = r.stdout.strip()
    return r.returncode, out


def main():
    tmp = tempfile.mkdtemp(prefix="harness-sessions-e2e-")
    db = os.path.join(tmp, "history.sqlite")

    print("== 1. 建会话 + 追加 + upsert ==")
    rc, _ = run_cli("add", db, "s1", "rust sqlite", "openai", "gpt-4.1", "/ws")
    check("add 退出码 0", rc == 0, str(rc))
    rc, _ = run_cli("append", db, "s1", "user", "如何用 rusqlite")
    check("append 退出码 0", rc == 0, str(rc))
    rc, _ = run_cli("append", db, "s1", "assistant", "用 bundled 特性编译自带 SQLite")
    check("append2 退出码 0", rc == 0, str(rc))
    rc, _ = run_cli("upsert", db, "s1", "0", "user", "如何用 rusqlite（改）")
    check("upsert 退出码 0", rc == 0, str(rc))

    print("== 2. get 按序恢复 ==")
    rc, d = run_cli("get", db, "s1")
    check("get 退出码 0", rc == 0, str(rc))
    check("元数据 provider/model", d["meta"]["provider"] == "openai" and d["meta"]["model"] == "gpt-4.1", str(d["meta"]))
    check("消息条数=2", len(d["messages"]) == 2, str(d["messages"]))
    check("seq 有序", [m["seq"] for m in d["messages"]] == [0, 1], str(d["messages"]))
    check("upsert 已覆写", d["messages"][0]["text"] == "如何用 rusqlite（改）", str(d["messages"][0]))

    print("== 3. list 倒序 ==")
    # s1 已在 step1 有 append，s2 在此 add — 若同一秒内顺序不确定，则 sleep 1 秒以确保 updated_at 可区分。
    import time
    time.sleep(1.1)
    run_cli("add", db, "s2", "旧会话", "mock", "m", "/")
    rc, lst = run_cli("list", db)
    check("list 数量=2", len(lst) == 2, str(lst))
    check("最近更新在前（s2 后 add）", lst[0]["id"] == "s2", str([x["id"] for x in lst]))

    print("== 4. search ==")
    rc, hits = run_cli("search", db, "bundled")
    check("按内容命中 s1", len(hits) == 1 and hits[0]["id"] == "s1", str(hits))
    rc, hits = run_cli("search", db, "旧会话")
    check("按标题命中 s2", len(hits) == 1 and hits[0]["id"] == "s2", str(hits))
    rc, hits = run_cli("search", db, "不存在的词")
    check("无命中", len(hits) == 0, str(hits))

    print("== 5. rename / delete ==")
    rc, m = run_cli("rename", db, "s2", "重命名会话")
    check("rename 退出码 0", rc == 0, str(rc))
    rc, d = run_cli("get", db, "s2")
    check("rename 生效", d["meta"]["title"] == "重命名会话", str(d["meta"]))
    rc, _ = run_cli("delete", db, "s2")
    rc, lst = run_cli("list", db)
    check("delete 后剩余 1", len(lst) == 1 and lst[0]["id"] == "s1", str(lst))

    print("== 6. 重开后数据仍在（持久化） ==")
    rc, d = run_cli("get", db, "s1")
    check("持久化后 get 仍可用", rc == 0 and len(d["messages"]) >= 2, str(d))

    print("\n结果：通过 %d，失败 %d" % (len(passed), len(failed)))
    import shutil
    shutil.rmtree(tmp, ignore_errors=True)
    if failed:
        sys.exit(1)
    print("✅ T16 会话持久化端到端全部通过")


if __name__ == "__main__":
    ensure_built()
    main()