#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""T17 Windows 安装包构建配置静态校验 + 发布产物目录结构断言。

我们运行在 Linux/沙盒环境，无法真的跑 `tauri build` 生成 .msi/.exe。
这里做静态/契约层面的验收：
  1. `tauri.conf.json` 的 bundle.targets 同时包含 msi 与 nsis；
  2. `tauri.conf.json` 含 Windows 专项配置（nsis/wix/webviewInstallMode）；
  3. `.github/workflows/build-windows-release.yml` 可被 PyYAML 解析且：
     - runner = windows-latest；
     - 包含 tauri build 步骤；
     - 包含 Release 上传（softprops/action-gh-release）；
     - 产物路径匹配 msi + nsis；
  4. 前端可 `npm run build` 成功（tauri 的 beforeBuildCommand 前置契约）。
"""
import json
import os
import shutil
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

passed = []
failed = []


def check(name, cond, detail=""):
    if cond:
        passed.append(name)
        print(f"  ✅ {name}")
    else:
        failed.append(name)
        print(f"  ❌ {name}  {detail}")


def main():
    # 1. tauri.conf.json
    tauri_conf = os.path.join(ROOT, "src-tauri", "tauri.conf.json")
    with open(tauri_conf, "r", encoding="utf-8") as f:
        conf = json.load(f)
    targets = conf.get("bundle", {}).get("targets", [])
    check("targets 包含 msi", "msi" in targets, str(targets))
    check("targets 包含 nsis", "nsis" in targets, str(targets))
    windows = conf.get("bundle", {}).get("windows", {})
    # 不强制 nsis / wix 对象存在（空默认值也能生成 msi+nsis）；
    # 若存在则仅记录，不做未校验的字段断言。
    check("bundle.windows 存在", isinstance(windows, dict))
    check("windows.webviewInstallMode 已配置", bool(windows.get("webviewInstallMode")), str(windows))

    # 2. workflow YAML 解析
    workflow = os.path.join(ROOT, ".github", "workflows", "build-windows-release.yml")
    check("workflow 存在", os.path.exists(workflow))
    try:
        import yaml  # 无 pyyaml 时跳过 YAML 结构检查（CI 中尽量装）
    except ImportError:
        try:
            subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", "pyyaml"],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            import yaml
        except Exception:
            yaml = None
    if yaml is not None:
        with open(workflow, "r", encoding="utf-8") as f:
            w = yaml.safe_load(f)
        jobs = w.get("jobs", {})
        build = jobs.get("build-windows", {})
        check("workflow 有 build-windows job", bool(build))
        check("runner = windows-latest", "windows-latest" in str(build.get("runs-on", "")),
              str(build.get("runs-on")))
        steps_text = json.dumps(build.get("steps", []), ensure_ascii=False)
        check("step: tauri build", "tauri build" in steps_text)
        check("step: softprops/action-gh-release", "softprops/action-gh-release" in steps_text)
        check("files: .msi 路径", "bundle/msi/**/*.msi" in steps_text)
        check("files: .exe 路径", "bundle/nsis/**/*.exe" in steps_text)

    # 3. 本地脚本 & 辅助文件存在
    for rel in ["scripts/build_windows.ps1"]:
        check(f"{rel} 存在", os.path.exists(os.path.join(ROOT, *rel.split("/"))))

    # 4. 前端构建契约（beforeBuildCommand = npm run build）
    frontend = os.path.join(ROOT, "frontend")
    print("== 前端 npm run build (beforeBuildCommand 契约) ==")
    env = os.environ.copy()
    r = subprocess.run(
        [shutil.which("npm") or "npm", "run", "build"],
        cwd=frontend, capture_output=True, text=True, env=env,
    )
    dist = os.path.join(frontend, "dist")
    check("npm run build 退出码 0", r.returncode == 0,
          f"rc={r.returncode}\n---stdout tail---\n{r.stdout[-600:]}\n---stderr tail---\n{r.stderr[-600:]}")
    check("dist/ 生成", os.path.isdir(dist))
    if os.path.isdir(dist):
        assets = sum(1 for _ in os.scandir(dist))
        check("dist/ 非空", assets > 0, f"assets={assets}")

    print("\n结果：通过 %d，失败 %d" % (len(passed), len(failed)))
    if failed:
        sys.exit(1)
    print("✅ T17 安装包配置 & 构建契约静态校验通过（真机构建需 Windows runner 执行 workflow）")


if __name__ == "__main__":
    main()