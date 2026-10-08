#!/usr/bin/env bash
set -euo pipefail

desktop_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$desktop_dir/../.." && pwd)"

usage() {
  cat <<'EOF'
用法: ./apps/desktop/package-local-macos.sh [版本号]

为本机 Apple Silicon 生成最新的 WorkStep DMG 和自动更新元数据。
版本号可写成 1.0.9 或 v1.0.9；省略时使用 apps/desktop/package.json 中的版本。
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi
if [[ $# -gt 1 ]]; then
  usage >&2
  exit 2
fi

version="${1:-$(node -p "require('$desktop_dir/package.json').version")}"
version="${version#v}"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]]; then
  echo "版本号无效：$version" >&2
  exit 2
fi
if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "此脚本仅用于 macOS Apple Silicon 本地试用包" >&2
  exit 1
fi

if command -v corepack >/dev/null 2>&1; then
  YARN_COMMAND=(corepack yarn)
elif command -v yarn >/dev/null 2>&1; then
  YARN_COMMAND=(yarn)
else
  echo "需要 Yarn；请安装 Yarn，或使用带 Corepack 的 Node.js 22" >&2
  exit 1
fi

run_yarn() {
  "${YARN_COMMAND[@]}" "$@"
}

cd "$desktop_dir"
if [[ ! -x node_modules/.bin/electron-builder ]]; then
  run_yarn install --frozen-lockfile
fi
npm version "$version" --no-git-tag-version --allow-same-version
run_yarn icons

cd "$repo_dir"
WORKSTEP_BUILD_VERSION="$version" "$repo_dir/build.sh" --with-web

cd "$desktop_dir"
BUILD_PLATFORM=mac "$desktop_dir/inject-backend.sh"
mkdir -p "$desktop_dir/dist"
find "$desktop_dir/dist" -maxdepth 1 -type f \( \
  -name 'WorkStep-*-macos-arm64.dmg' -o \
  -name 'WorkStep-*-macos-arm64.dmg.blockmap' -o \
  -name 'WorkStep-*-macos-arm64.zip' -o \
  -name 'WorkStep-*-macos-arm64.zip.blockmap' -o \
  -name 'WorkStep-macos-arm64.dmg' -o \
  -name 'WorkStep-macos-arm64.dmg.blockmap' -o \
  -name 'WorkStep-macos-arm64.zip' -o \
  -name 'WorkStep-macos-arm64.zip.blockmap' \
\) -delete
run_yarn dist:mac:local
codesign --verify --deep --strict "$desktop_dir/dist/mac-arm64/WorkStep.app"
rm -rf "$desktop_dir/dist/mac-arm64"
shasum -a 256 "$desktop_dir/dist/WorkStep-$version-macos-arm64.dmg"

echo "桌面包已生成：$desktop_dir/dist/WorkStep-$version-macos-arm64.dmg"
