#!/bin/bash
# gitee-go-build.sh — Gitee Go (Linux 容器) 交叉构建 Windows NSIS 安装包
# 产物：src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*-setup.exe
# 说明：msi 需要 Windows/WiX，dmg 需要 macOS，本流程只出 NSIS .exe
set -e
echo "==> [0/7] 环境信息"; uname -a; nproc; free -h | head -2

DEPS_BASE="http://118.31.107.214/dl"
CODEX_EXE_URL="$DEPS_BASE/codex-x86_64-pc-windows-msvc-rust-v0.150.1.exe"
GH_MIRROR="https://ghfast.top/"

echo "==> [1/7] 系统依赖（nsis / lld / clang / 证书）"
apt-get update -qq
apt-get install -y -qq curl unzip xz-utils nsis lld clang pkg-config ca-certificates > /dev/null
mkdir -p /usr/share/nsis/Plugins/x86-unicode
curl -sSL "$DEPS_BASE/nsis_tauri_utils.dll" -o /usr/share/nsis/Plugins/x86-unicode/nsis_tauri_utils.dll

echo "==> [2/7] Node.js 20（npmmirror 国内源）"
if ! node -v 2>/dev/null | grep -q "^v20"; then
  curl -sSL "https://registry.npmmirror.com/-/binary/node/v20.18.1/node-v20.18.1-linux-x64.tar.xz" -o /tmp/node.tar.xz
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
fi
node -v; npm -v

echo "==> [3/7] Rust 工具链（rsproxy 国内源）"
export RUSTUP_DIST_SERVER="https://rsproxy.cn"
export RUSTUP_UPDATE_ROOT="https://rsproxy.cn/rustup"
export PATH="$HOME/.cargo/bin:$PATH"
if [ ! -x "$HOME/.cargo/bin/cargo" ]; then
  curl --proto '=https' --tlsv1.2 -sSf "https://rsproxy.cn/rustup-init.sh" | sh -s -- -y --default-toolchain stable
fi
mkdir -p "$HOME/.cargo"
cat > "$HOME/.cargo/config.toml" <<'CARGO'
[source.crates-io]
replace-with = 'rsproxy-sparse'
[source.rsproxy-sparse]
registry = "sparse+https://rsproxy.cn/index/"
[net]
git-fetch-with-cli = true
CARGO
rustup target add x86_64-pc-windows-msvc
rustc -vV

echo "==> [4/7] cargo-xwin（Windows SDK/CRT 交叉头文件库）"
if [ ! -x "$HOME/.cargo/bin/cargo-xwin" ]; then
  XWIN_VER="v0.18.4"
  curl -sSL "${GH_MIRROR}https://github.com/rust-cross/cargo-xwin/releases/download/${XWIN_VER}/cargo-xwin-x86_64-unknown-linux-musl.tar.gz" -o /tmp/cx.tar.gz
  tar -xzf /tmp/cx.tar.gz -C "$HOME/.cargo/bin" --strip-components=1 --wildcards '*/cargo-xwin'
fi
cargo xwin --version

echo "==> [5/7] 前端构建（npmmirror）"
cd frontend
npm ci --no-audit --no-fund --registry=https://registry.npmmirror.com
npm run build
cd ..

echo "==> [6/7] 下载随包 codex.exe"
mkdir -p src-tauri/resources
curl -sSL --retry 3 "$CODEX_EXE_URL" -o src-tauri/resources/codex.exe
ls -la src-tauri/resources/codex.exe

echo "==> [7/7] tauri build（target: x86_64-pc-windows-msvc, bundles: nsis）"
cd frontend
npx tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
cd ..
echo "==> 产物："
ls -la src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/
