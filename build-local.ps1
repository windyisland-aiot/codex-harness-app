# build-local.ps1 — Prism 本地一键构建 Windows 安装包（不依赖 GitHub Actions）
# 用法：在仓库根目录执行  powershell -ExecutionPolicy Bypass -File .\build-local.ps1
# 前置环境（只需装一次）：
#   1. Node.js 20+        https://nodejs.org
#   2. Rust (rustup)      https://rustup.rs  （默认选项即可）
#   3. VS Build Tools     https://visualstudio.microsoft.com/visual-cpp-build-tools/ 勾选「使用 C++ 的桌面开发」
param(
  [string]$CodexRelease = "rust-v0.150.1"
)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
Set-Location $root

Write-Host "==> 0/4 环境检查"
foreach ($cmd in @("node", "npm", "cargo", "rustc")) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "未找到 $cmd。请先安装上方注释中的前置环境后重试。"
  }
}

Write-Host "==> 1/4 前端依赖与构建"
Set-Location (Join-Path $root "frontend")
npm ci --no-audit --no-fund
npm run build
Set-Location $root

Write-Host "==> 2/4 下载随包分发的 codex.exe"
$resDir = Join-Path $root "src-tauri\resources"
New-Item -ItemType Directory -Force -Path $resDir | Out-Null
$codexExe = Join-Path $resDir "codex.exe"
if (Test-Path $codexExe) {
  Write-Host "    已存在，跳过下载: $codexExe"
} else {
  $url = "https://github.com/openai/codex/releases/download/$CodexRelease/codex-x86_64-pc-windows-msvc.exe"
  Invoke-WebRequest -Uri $url -OutFile $codexExe
  Unblock-File -Path $codexExe -ErrorAction SilentlyContinue
  $sz = [math]::Round((Get-Item $codexExe).Length / 1MB, 2)
  Write-Host "    下载完成 ($sz MB)"
}

Write-Host "==> 3/4 Tauri 打包（msi + nsis，最多重试 3 次）"
Set-Location (Join-Path $root "frontend")
$built = $false
foreach ($i in 1..3) {
  try {
    npx tauri build
    $built = $true
    break
  } catch {
    Write-Host "    第 $i 次构建失败，$($i * 10)s 后重试..."
    Start-Sleep -Seconds ($i * 10)
  }
}
if (-not $built) { throw "tauri build 连续 3 次失败，请把上方报错发给我排查。" }
Set-Location $root

Write-Host "==> 4/4 构建完成，产物位置："
Get-ChildItem (Join-Path $root "src-tauri\target\release\bundle\msi")  -Filter *.msi | ForEach-Object { Write-Host "    MSI : $($_.FullName)" }
Get-ChildItem (Join-Path $root "src-tauri\target\release\bundle\nsis") -Filter *.exe | ForEach-Object { Write-Host "    NSIS: $($_.FullName)" }
