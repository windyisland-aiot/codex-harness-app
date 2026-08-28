# T17 Windows 安装包本地构建脚本（仅用于 Windows 开发机）。
#
# 说明：
#   - 前置：Node 20 / Rust stable / MSVC Build Tools / WebView2（Win10+ 默认自带）。
#   - 产物路径：src-tauri\target\release\bundle\msi\ 与 src-tauri\target\release\bundle\nsis\
#   - 生产构建请走 GitHub Actions（.github/workflows/build-windows-release.yml），
#     该 Workflow 会在 windows-latest runner 上执行并上传到 GitHub Release。
#
# 参数：
#   -BuildDir      项目根目录，默认 $PSScriptRoot\..
#   -UseProxy      注入 HTTP_PROXY/HTTPS_PROXY（Tauri bundler 下载 WiX/NSIS 用）

[CmdletBinding()]
param(
    [string]$BuildDir,
    [string]$UseProxy
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($BuildDir)) {
    $BuildDir = Join-Path $PSScriptRoot ".."
}
$BuildDir = (Resolve-Path $BuildDir).Path
Set-Location $BuildDir

Write-Host "== T17 构建目录: $BuildDir ==" -ForegroundColor Cyan

if (-not [string]::IsNullOrWhiteSpace($UseProxy)) {
    $env:HTTP_PROXY = $UseProxy
    $env:HTTPS_PROXY = $UseProxy
    Write-Host "使用代理: $UseProxy"
}

Write-Host "-- 1. 前端安装依赖 & 构建 --" -ForegroundColor Cyan
Push-Location frontend
npm ci --no-audit --no-fund
npm run build
Pop-Location

Write-Host "-- 2. 安装 @tauri-apps/cli (本地) --" -ForegroundColor Cyan
npm install -D @tauri-apps/cli@^2

Write-Host "-- 3. tauri build（msi + nsis） --" -ForegroundColor Cyan
npx tauri build --verbose

Write-Host "-- 4. 产物枚举 --" -ForegroundColor Cyan
$bundle = Join-Path $BuildDir "src-tauri" "target" "release" "bundle"
if (Test-Path $bundle) {
    Get-ChildItem -Recurse -File $bundle |
        Select-Object Name, @{N='SizeMB';E={[math]::Round($_.Length/1MB,2)}}, FullName |
        Sort-Object SizeMB -Descending |
        Format-Table -AutoSize
} else {
    Write-Warning "未找到 bundle 目录：$bundle"
    exit 1
}
Write-Host "✅ Windows 安装包构建完成" -ForegroundColor Green