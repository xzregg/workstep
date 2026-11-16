#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
web_dir="$repo_dir/apps/web"
landing_dir="$repo_dir/apps/landing"
desktop_build="$repo_dir/apps/desktop/build-backend.sh"
build_web=""
build_desktop=1

select_yarn() {
  if command -v corepack >/dev/null 2>&1; then
    YARN_COMMAND=(corepack yarn)
  elif command -v yarn >/dev/null 2>&1; then
    YARN_COMMAND=(yarn)
    echo "未找到 Corepack，使用现有 Yarn $(yarn --version)"
  else
    echo "需要 Yarn；请安装 Yarn，或使用带 Corepack 的 Node.js 24 LTS" >&2
    exit 1
  fi
}

run_yarn() {
  "${YARN_COMMAND[@]}" "$@"
}

usage() {
  cat <<'EOF'
用法: ./build.sh [web|--with-web|--no-web]

  web         只构建 apps/web/dist
  --with-web  先构建工作台和官网，再构建桌面后端包
  --no-web    跳过前端构建，复用已有工作台和官网 dist

不带参数时构建工作台、官网和桌面后端包。
EOF
}

for option in "$@"; do
  case "$option" in
    web)
      build_web=1
      build_desktop=0
      ;;
    --with-web)
      build_web=1
      ;;
    --no-web)
      build_web=0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $option" >&2
      usage >&2
      exit 2
      ;;
  esac
done

build_web="${build_web:-1}"

if [[ "$build_web" == "1" ]]; then
  select_yarn
  echo "构建 Web dist..."
  cd "$web_dir"
  if [[ ! -x node_modules/.bin/vite ]]; then
    run_yarn install --frozen-lockfile
  fi
  run_yarn build
  test -f "$web_dir/dist/index.html"
else
  test -f "$web_dir/dist/index.html" || {
    echo "未找到 apps/web/dist/index.html，请先运行 ./build.sh --with-web" >&2
    exit 1
  }
  echo "复用已有 Web dist"
fi

if [[ "$build_desktop" == "1" ]]; then
  if [[ "$build_web" == "1" ]]; then
    echo "构建官网和操作手册..."
    cd "$landing_dir"
    if [[ ! -x node_modules/.bin/vite ]]; then
      run_yarn install --frozen-lockfile
    fi
    LANDING_BASE=/landing/ run_yarn build
  fi
  test -f "$landing_dir/dist/index.html" || {
    echo "未找到 apps/landing/dist/index.html，请先运行 ./build.sh --with-web" >&2
    exit 1
  }
  echo "构建桌面后端包..."
  cd "$repo_dir"
  "$desktop_build"
fi
